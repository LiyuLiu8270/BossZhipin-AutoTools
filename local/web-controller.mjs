import {MATCHER_VERSION} from './codex-runner.mjs';
import {normalizePolicy,profileFingerprint,greetingFingerprint,GREETING_PRESETS,POLICY_LIMITS} from './matching-policy.mjs';
import {activityDisplay,activityMatches,activityFilterLabels,activityFilterOptions} from './activity-display.mjs';
import {salaryMatches} from '../shared/salary.js';
import {activityEligible, needsActivity} from '../shared/activity.js';
import {ResumeDocuments} from './resume-documents.mjs';
import {resumeProfile} from './resume-profile.mjs';
import {MatchScheduler} from './match-scheduler.mjs';
import {ModelTaskQueue} from './model-task-queue.mjs';
import {readableJD} from '../shared/core.js';
import {normalizeHrActivity} from './hr-activity-policy.mjs';
import {detailState,detailQueueMap,detailSummary,jobAvailability,collectionOverview,overviewStage} from './detail-status.mjs';
import {cachedRead,databaseRevision,trackReadTables} from './read-cache.mjs';
import {VERSION} from '../shared/core.js';
import {jobViewFlags} from '../shared/job-views.mjs';
import {buildJobSearchIndex,matchesJobSearch,normalizeSearch} from '../shared/job-search.js';

const defaults={autoAnalyze:false,autoGreeting:false,dailyLimit:200,modelConcurrency:1,keywords:[]};
export function collectedAt(job){
  const times=[job.last_seen_at,job.jd_observed_at].filter(v=>typeof v==='string'&&Number.isFinite(Date.parse(v))).map(v=>Date.parse(v));
  return times.length?new Date(Math.max(...times)).toISOString():null;
}
export class WebController {
  constructor(store,worker,{resumeOnly=false}={}){
    this.resumeOnly=resumeOnly;
    this.store=store;this.worker=worker;this.db=store.db;this.busy=false;
    this.resumeDocuments=new ResumeDocuments(this.db);
    this.db.exec(`CREATE TABLE IF NOT EXISTS ui_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ui_actions(dataset TEXT NOT NULL,id TEXT NOT NULL,stage TEXT NOT NULL,note TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(dataset,id));`);
    this.db.exec("CREATE TABLE IF NOT EXISTS ui_replies(dataset TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(dataset,id));");
    trackReadTables(this.db,['ui_actions','ui_replies','ui_settings']);
    const savedSettings=this.read('settings');
    this.settings={...defaults,...savedSettings,autoGreeting:savedSettings?.autoGreeting??!!savedSettings?.autoAnalyze};
    this.settings.hrActivity=normalizeHrActivity(this.settings.hrActivity);
    this.worker.hrActivity=this.settings.hrActivity;
    this.worker.policy=normalizePolicy(this.read('matchingPolicy')||{});
    if(resumeOnly)this.syncResumeProfile();else this.applyProfile(this.read('profile')||this.worker.profile);
    this.worker.dailyLimit=this.settings.dailyLimit;
    this.modelQueue=new ModelTaskQueue({capacity:()=>this.settings.modelConcurrency,reserveCommunication:()=>this.communications?.hasActiveTasks?.()||false});
    this.scheduler=new MatchScheduler(worker,{queue:this.modelQueue,canRun:()=>!this._busy&&!this.resumeDocuments.busy&&(this.settings.autoAnalyze||this.settings.autoGreeting||worker.hasRequestedGreeting())&&worker.profile.mode!=='resume_missing'&&worker.budgetAvailable(),stages:()=>({matching:this.settings.autoAnalyze,greeting:this.settings.autoGreeting}),capacity:()=>this.settings.modelConcurrency});
  }
  get busy(){return Boolean(this._busy||this.scheduler?.active);}
  set busy(value){this._busy=value;}
  read(key){const row=this.db.prepare('SELECT value FROM ui_settings WHERE key=?').get(key);return row?JSON.parse(row.value):null;}
  write(key,value){this.db.prepare('INSERT INTO ui_settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  applyProfile(profile){
    const next=profileFingerprint(profile,this.worker.policy);
    const removed=this.db.prepare('DELETE FROM match_runs WHERE profile<>?').run(next).changes;
    this.worker.profile=profile;this.worker.profileHash=next;
    this.worker.pruneGreetings();
    if(removed)this.refreshReport();
  }
  refreshReport(){try{this.worker.render();return null;}catch{return 'report_write_failed';}}
  matchingPolicy(){return {policy:this.worker.policy,version:this.worker.profileHash,greetingVersion:this.worker.styleHash,presets:GREETING_PRESETS,limits:POLICY_LIMITS};}
  saveMatchingPolicy(value){
    const policy=normalizePolicy(value),old=this.worker.profileHash,oldStyle=this.worker.styleHash,next=profileFingerprint(this.worker.profile,policy);
    this.db.exec('BEGIN IMMEDIATE');
    let removed=0,greetingsRemoved=0;
    try{
      this.write('matchingPolicy',policy);
      removed=this.db.prepare('DELETE FROM match_runs WHERE profile<>?').run(next).changes;
      greetingsRemoved=this.worker.pruneGreetings(next,greetingFingerprint(policy));
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.worker.policy=policy;this.worker.profileHash=next;
    const matchingChanged=old!==next,greetingChanged=oldStyle!==this.worker.styleHash,changed=matchingChanged||greetingChanged;
    const reportError=changed||removed?this.refreshReport():null;this.scheduler?.wake();
    return {...this.matchingPolicy(),changed,matchingChanged,greetingChanged,removed,greetingsRemoved,...(reportError?{report_error:reportError}:{})};
  }
  syncResumeProfile(){this.applyProfile(resumeProfile(this.resumeDocuments.current()));}
  async importResume(value){
    if(this.resumeOnly&&this.busy)throw new Error('analysis_busy');
    const result=await this.resumeDocuments.import(value);if(this.resumeOnly)this.syncResumeProfile();
    return {...result,document:{...result.document,matching_connected:this.resumeOnly}};
  }
  saveProfile(profile){
    if(this.resumeOnly)throw new Error('resume_only');
    if(this.busy)throw new Error('analysis_busy');
    if(!profile||typeof profile.target!=='string'||profile.target.length>4000||!profile.target.trim()||
      !profile.facts||Array.isArray(profile.facts)||typeof profile.facts!=='object'||
      Object.keys(profile.facts).length<1||Object.keys(profile.facts).length>100||
      Object.entries(profile.facts).some(([k,v])=>!/^C\d{2,3}$/.test(k)||typeof v!=='string'||!v.trim()||v.length>4000)||
      !Array.isArray(profile.boundaries)||profile.boundaries.length>50||profile.boundaries.some(v=>typeof v!=='string'||v.length>2000))throw new Error('invalid_profile');
    // Stable metadata: saving an unchanged form must not invalidate all analyses.
    const next={...this.worker.profile,target:profile.target,facts:profile.facts,boundaries:profile.boundaries};
    this.write('profile',next);this.applyProfile(next);return next;
  }
  saveSettings(value){
    const autoGreeting=value?.autoGreeting===undefined?this.settings.autoGreeting:value.autoGreeting;
    const modelConcurrency=value?.modelConcurrency===undefined?this.settings.modelConcurrency:value.modelConcurrency;
    let hrActivity;try{hrActivity=normalizeHrActivity(value?.hrActivity===undefined?this.settings.hrActivity:value.hrActivity);}catch{throw new Error('invalid_settings');}
    if(!value||typeof value.autoAnalyze!=='boolean'||typeof autoGreeting!=='boolean'||!Number.isSafeInteger(value.dailyLimit)||value.dailyLimit<1||
      !Number.isInteger(modelConcurrency)||modelConcurrency<1||modelConcurrency>16||
      !Array.isArray(value.keywords)||value.keywords.length>100||value.keywords.some(k=>!k||typeof k.text!=='string'||!k.text.trim()||k.text.length>60||typeof k.enabled!=='boolean'))throw new Error('invalid_settings');
    const seen=new Set();const keywords=[];for(const k of value.keywords){const text=k.text.trim();if(!seen.has(text)){seen.add(text);keywords.push({text,enabled:k.enabled});}}
    this.settings={autoAnalyze:value.autoAnalyze,autoGreeting,dailyLimit:value.dailyLimit,modelConcurrency,keywords,hrActivity};this.write('settings',this.settings);this.worker.dailyLimit=value.dailyLimit;this.worker.hrActivity=hrActivity;this.modelQueue?.wake();this.scheduler?.wake();this.companyResearch?.wake();return this.settings;
  }
  regenerateGreeting(value){
    if(!value||typeof value.dataset!=='string'||typeof value.id!=='string')throw new Error('job_not_found');
    const result=this.worker.requestGreeting(value.dataset,value.id);this.scheduler.wake();return result;
  }
  previewBulkGreetings(value){const {rows,...summary}=this.worker.bulkGreetingPlan(value);return summary;}
  regenerateBulkGreetings(value){const result=this.worker.requestBulkGreetings(value);this.scheduler.wake();return result;}
  rows(dataset=null,id=null){
    return cachedRead(this,id?'job:'+JSON.stringify([dataset,id]):'rows',JSON.stringify([this.worker.profileHash,this.worker.styleHash,this.worker.hrActivity]),()=>this.readRows(dataset,id),{tables:['intake_jobs','intake_analysis_queue','match_runs','greeting_runs','manual_contact','ui_actions','ui_replies','collection_details'],expiresAt:rows=>Math.min(...rows.filter(r=>r.detail_state==='waiting_retry').map(r=>r.detail_retry_at))});
  }
  readRows(dataset=null,id=null){
    const queues=detailQueueMap(this.db),now=Date.now();
    const jobs=id?null:this.store.jobMap();
    const rows=this.db.prepare(`SELECT j.dataset,j.id,${id?'j.body,':''}j.exported_at,q.fingerprint,q.state AS queue_state,q.reason,m.state AS analysis_state,m.result,m.error,m.updated AS analyzed_at,
      g.state AS greeting_raw_state,g.result AS greeting_result,g.error AS greeting_raw_error,
      c.status AS manual_status,a.stage,a.note,p.status AS reply_status FROM intake_jobs j
      LEFT JOIN intake_analysis_queue q USING(dataset,id)
      LEFT JOIN match_runs m ON m.dataset=j.dataset AND m.id=j.id AND m.fingerprint=q.fingerprint AND m.profile=?
      LEFT JOIN greeting_runs g ON g.dataset=j.dataset AND g.id=j.id AND g.fingerprint=q.fingerprint AND g.profile=? AND g.style=?
      LEFT JOIN manual_contact c ON c.dataset=j.dataset AND c.id=j.id
      LEFT JOIN ui_replies p ON p.dataset=j.dataset AND p.id=j.id
      LEFT JOIN ui_actions a ON a.dataset=j.dataset AND a.id=j.id ${id?'WHERE j.dataset=? AND j.id=?':''}`).all(this.worker.profileHash,this.worker.profileHash,this.worker.styleHash,...(id?[dataset,id]:[]));
    rows.sort((a,b)=>(a.exported_at===b.exported_at?0:a.exported_at>b.exported_at?-1:1)||(a.id===b.id?0:a.id<b.id?-1:1));
    return rows.map(r=>{
        const job=id?JSON.parse(r.body):jobs.get(JSON.stringify([r.dataset,r.id])),result=r.queue_state!=='deferred'&&r.analysis_state==='completed'&&r.result?JSON.parse(r.result):null;
        const greeting=result&&r.greeting_raw_state?{state:r.greeting_raw_state,result:r.greeting_result,error:r.greeting_raw_error}:null;
        if(result&&greeting?.result)Object.assign(result,JSON.parse(greeting.result));
        const contact=r.manual_status||job.contact_status||'unknown';
        const queue=queues.get(JSON.stringify([r.dataset,r.id]));
        return {dataset:r.dataset,id:r.id,job,result,activity_gate:this.worker.activityDecision(job),greeting_state:this.worker.queueState(!result?'awaiting_match':greeting?.state||(['优先沟通','可以尝试'].includes(result.priority)?'pending':'not_required'),job),greeting_error:greeting?.error||null,analysis_state:this.worker.queueState(r.queue_state==='deferred'?'deferred':r.analysis_state||'pending',job),reason:r.reason,error:r.error,
          detail_state:detailState(job,queue,now),detail_retry_at:queue?.retry_at||0,job_state:jobAvailability(job),analyzed_at:r.analyzed_at,contact_status:contact,reply_status:contact==='contacted'?(r.reply_status||'unknown'):'unknown',stage:r.stage||(contact==='contacted'?'contacted':'new'),note:r.note||''};
      });
  }
  viewRevision(){return databaseRevision(this.db)+':'+Math.min(...this.rows().filter(r=>r.detail_state==='waiting_retry').map(r=>r.detail_retry_at));}
  list(params=new URLSearchParams()){
    const q=normalizeSearch(params.get('q')||''),priority=params.get('priority'),stage=params.get('stage'),dataset=params.get('dataset'),contact=params.get('contact');
    const searchIndex=q?cachedRead(this,'search-index','',()=>buildJobSearchIndex(this.store.jobsSnapshot()),{tables:['intake_jobs']}):null;
    const scope=this.rows().filter(r=>!dataset||r.dataset===dataset),summary=this.summary(scope),reply=params.get('reply'),detail=params.get('detail'),availability=params.get('availability');
    const communications=this.communications?.summaries()||{},view=params.get('view')||'all';
    const flags=r=>jobViewFlags(r,communications[JSON.stringify([r.dataset,r.id])]);
    const views=Object.fromEntries(['recommended','attention','communicating','all'].map(key=>[key,scope.filter(r=>flags(r)[key]).length]));
    let rows=scope.filter(r=>(flags(r)[view]??true)&&(!q||matchesJobSearch(searchIndex,r.dataset,r.id,q))&&
      (!availability||(availability==='terminal'?r.job_state!=='unknown':r.job_state===availability))&&(!reply||(r.contact_status==='contacted'&&r.reply_status===reply))&&(!detail||(detail==='ready'?readableJD(r.job):detail==='missing'?!readableJD(r.job):detail==='unfinished'?overviewStage(r.job)==='awaiting':['pending','waiting_retry','review','unqueued'].includes(detail)&&r.detail_state===detail))&&
      (!dataset||r.dataset===dataset)&&(!priority||(priority==='pending'?!r.result:r.result?.priority===priority))&&(!stage||r.stage===stage)&&(!contact||r.contact_status===contact)&&salaryMatches(r.job.salary,params.get('salary')||'')&&activityMatches(r.job,params.get('activity')||''));
    if(params.get('sort')!=='recent') {const rank={'优先沟通':0,'可以尝试':1,'低优先级':3,'不匹配':4};rows.sort((a,b)=> (rank[a.result?.priority]??2)-(rank[b.result?.priority]??2));}
    const page=Math.max(1,Math.floor(Number(params.get('page'))||1)),size=30,total=rows.length,pages=Math.max(1,Math.ceil(total/size)),actual=Math.min(page,pages);
    return {revision:this.viewRevision(),total,page:actual,pages,summary,views,items:rows.slice((actual-1)*size,actual*size).map(({job,result,...r})=>({...r,company_research:this.companyResearch?.summary(job)||null,communication:communications[JSON.stringify([r.dataset,r.id])]||null,title:job.title,company:job.company,salary:job.salary,location:job.location,
      hiring_type:job.hiring_party?.type,priority:result?.priority||null,summary:result?.reason||'',last_seen_at:job.last_seen_at,collected_at:collectedAt(job),
      availability:job.recruitment_signals?.availability?.value||'unknown',activity:job.recruitment_signals?.recruiter_activity?.raw||[],activity_display:activityDisplay(job)}))};
  }
  summary(rows){
    const priorities={'优先沟通':0,'可以尝试':0,'低优先级':0,'不匹配':0,pending:0};
    for(const r of rows){const key=r.result?.priority;if(Object.hasOwn(priorities,key))priorities[key]++;else priorities.pending++;}
    return {total:rows.length,overview:collectionOverview(rows),details:rows.filter(r=>readableJD(r.job)).length,detailCounts:detailSummary(rows),closed:rows.filter(r=>r.job_state==='closed').length,priorities,
      contacted:rows.filter(r=>r.contact_status==='contacted').length,
      waiting:rows.filter(r=>r.contact_status==='contacted'&&r.reply_status==='waiting').length};
  }
  detail(dataset,id){const row=this.rows(dataset,id)[0];if(!row)throw new Error('job_not_found');return {...row,activity_display:activityDisplay(row.job),facts:this.worker.profile.facts,communication:this.communications?.detail(dataset,id)||null,company_research:this.companyResearch?.detail(dataset,id)||null};}
  action(value){
    const {dataset,id,stage,note,contact}=value||{};
    if(!this.store.get(dataset,id))throw new Error('job_not_found');
    if(!['new','saved','contacted','followup','ignored'].includes(stage)||typeof note!=='string'||note.length>4000||!['unknown','not_contacted','contacted'].includes(contact))throw new Error('invalid_action');
    if(['contacted','followup'].includes(stage)&&contact!=='contacted')throw new Error('contact_stage_conflict');
    const previous=this.db.prepare('SELECT status FROM ui_replies WHERE dataset=? AND id=?').get(dataset,id)?.status||'unknown';
    const reply=value.reply===undefined?(contact==='contacted'?previous:'unknown'):value.reply;
    if(!['unknown','waiting','replied','closed'].includes(reply))throw new Error('invalid_action');
    if(contact!=='contacted'&&reply!=='unknown')throw new Error('contact_reply_conflict');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const at=new Date().toISOString();
      this.db.prepare('INSERT INTO ui_actions VALUES(?,?,?,?,?) ON CONFLICT(dataset,id) DO UPDATE SET stage=excluded.stage,note=excluded.note,updated=excluded.updated').run(dataset,id,stage,note,at);
      this.db.prepare('INSERT INTO manual_contact VALUES(?,?,?,?) ON CONFLICT(dataset,id) DO UPDATE SET status=excluded.status,updated=excluded.updated').run(dataset,id,contact,at);
      this.db.prepare('INSERT INTO ui_replies VALUES(?,?,?,?) ON CONFLICT(dataset,id) DO UPDATE SET status=excluded.status,updated=excluded.updated').run(dataset,id,reply,at);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    if((stage==='ignored'||reply==='closed')&&this.communications?.get(JSON.stringify([dataset,id])))this.communications.action({dataset,id,mode:'manual'});
    return {ok:true};
  }
  state(){
    const snapshot=cachedRead(this,'state',JSON.stringify([this.worker.profileHash,this.worker.styleHash,this.settings]),()=>this.stateSnapshot(),{tables:['intake_jobs','intake_analysis_queue','intake_imports','match_runs','greeting_runs','manual_contact','ui_actions','ui_replies']});
    return {...snapshot,version:VERSION,modelScheduling:this.modelQueue.status(),companyResearch:this.companyResearch?.status()||null,revision:this.viewRevision(),settings:this.settings,busy:this.busy,engine:MATCHER_VERSION,status:this.worker.status(),communication:{busy:this.communications?.busy||false,modelActive:this.communications?.modelActive||0,notifications:this.communications?.notifications()||[]},collection:this.collector?.status()||null};
  }
  stateSnapshot(){
    const rows=this.rows();return {datasets:this.store.stats(),
      activityFilterLabels:activityFilterLabels(rows.map(r=>r.job)),
      activityFilterOptions:activityFilterOptions(rows.map(r=>r.job)),
      activityCollection:{unknown:rows.filter(r=>activityDisplay(r.job).state==='unknown').length,
        pending:rows.filter(r=>needsActivity(r.job)).length,
        review:rows.filter(r=>activityEligible(r.job)&&r.job.activity_check?.state==='needs_review').length,
        notDisplayed:rows.filter(r=>activityEligible(r.job)&&r.job.activity_check?.state==='not_displayed').length,
        found:rows.filter(r=>r.job.activity_check?.state==='found').length},
      total:rows.length,recommended:rows.filter(r=>['优先沟通','可以尝试'].includes(r.result?.priority)).length,contacted:rows.filter(r=>r.contact_status==='contacted').length,
      lastImport:this.db.prepare('SELECT imported_at,source,dataset FROM intake_imports ORDER BY imported_at DESC LIMIT 1').get()||null,
      suggestions:[...new Set(rows.filter(r=>['优先沟通','可以尝试'].includes(r.result?.priority)).flatMap(r=>r.result.keywords||[]))].filter(w=>!this.settings.keywords.some(k=>k.text===w)).slice(0,20)};
  }
  async tick(limit=3){
    if(this.busy||this.resumeDocuments.busy||!this.settings.autoAnalyze||this.worker.profile.mode==='resume_missing')return {status:'paused'};
    this.busy=true;try{return await this.worker.step(limit);}finally{this.busy=false;}
  }
}
