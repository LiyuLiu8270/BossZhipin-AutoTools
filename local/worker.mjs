import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {analysisInput} from './intake.mjs';
import {activityReport} from './activity-display.mjs';
import {MATCHER_VERSION,runCodex,validateResults} from './codex-runner.mjs';
import {normalizePolicy,profileFingerprint,greetingFingerprint} from './matching-policy.mjs';
import {runGreeting,validateGreeting} from './greeting-runner.mjs';
import {appendModelDiagnostic} from './model-diagnostics.mjs';
import {DEFAULT_HR_ACTIVITY,hrActivityDecision,hrActivityQueueState} from './hr-activity-policy.mjs';
import {codexRuntimeStatus} from './codex-executable.mjs';
import {cachedRead,databaseRevision,trackReadTables} from './read-cache.mjs';

export class MatchWorker {
  constructor(store,profile,{dataDir,runner=runCodex,greetingRunner=runGreeting,dailyLimit=200,runtimeStatus=codexRuntimeStatus}={}){
    this.store=store;this.db=store.db;this.profile=profile;this.policy=normalizePolicy();this.profileHash=profileFingerprint(profile,this.policy);
    this.dataDir=dataDir;this.runner=runner;this.greetingRunner=greetingRunner;this.dailyLimit=dailyLimit;this.activeStages={matching:0,greeting:0};this.hrActivity={...DEFAULT_HR_ACTIVITY};
    this.runtimeStatus=runtimeStatus;
    this.db.exec(`CREATE TABLE IF NOT EXISTS match_runs (
      dataset TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,profile TEXT NOT NULL,
      state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,retry_at INTEGER NOT NULL DEFAULT 0,
      updated INTEGER NOT NULL,error TEXT,result TEXT,usage TEXT,
      PRIMARY KEY(dataset,id,fingerprint,profile));
      CREATE TABLE IF NOT EXISTS match_budget (day TEXT PRIMARY KEY, jobs INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS greeting_runs (
        dataset TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,profile TEXT NOT NULL,style TEXT NOT NULL,
        state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,lease TEXT,retry_at INTEGER NOT NULL DEFAULT 0,
        updated INTEGER NOT NULL,error TEXT,result TEXT,usage TEXT,
        PRIMARY KEY(dataset,id,fingerprint,profile,style));
      CREATE TABLE IF NOT EXISTS manual_contact (dataset TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(dataset,id));`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS match_running_expiry ON match_runs(retry_at) WHERE state='running';
      CREATE INDEX IF NOT EXISTS greeting_running_expiry ON greeting_runs(retry_at) WHERE state='running';`);
    trackReadTables(this.db,['match_runs','greeting_runs','manual_contact']);
  }
  day(now){return new Date(now+8*3600000).toISOString().slice(0,10);}
  get styleHash(){return greetingFingerprint(this.policy);}
  activityDecision(job){
    const key=JSON.stringify(this.hrActivity);
    if(this._activityKey!==key){this._activityKey=key;this._activityCache=new WeakMap();}
    if(!this._activityCache.has(job))this._activityCache.set(job,hrActivityDecision(job,this.hrActivity));
    return this._activityCache.get(job);
  }
  queueState(state,job){return hrActivityQueueState(state,this.activityDecision(job));}
  taskDiagnostic(stage,rows){
    const context={requestId:randomUUID(),stage},cwd=join(this.dataDir,'codex-work');
    const log=(outcome,error=null)=>{try{return appendModelDiagnostic(cwd,{event:'task_result',request_id:context.requestId,stage,outcome,error,
      jobs:rows.map(r=>({ref:createHash('sha256').update(JSON.stringify([r.dataset,r.id])).digest('hex').slice(0,20),attempt:this.db.prepare(`SELECT attempts FROM ${stage==='matching'?'match_runs':'greeting_runs'} WHERE dataset=? AND id=? AND fingerprint=? AND profile=? ORDER BY updated DESC LIMIT 1`).get(r.dataset,r.id,r.fingerprint,this.profileHash)?.attempts||null}))});}catch{process.stderr.write('model_diagnostic_write_failed\n');return false;}};
    return {context,log};
  }
  pruneGreetings(profile=this.profileHash,style=this.styleHash){return this.db.prepare(`DELETE FROM greeting_runs WHERE profile<>? OR style<>? OR NOT EXISTS
    (SELECT 1 FROM intake_analysis_queue q WHERE q.dataset=greeting_runs.dataset AND q.id=greeting_runs.id AND q.fingerprint=greeting_runs.fingerprint AND q.state!='deferred')`).run(profile,style).changes;}
  greetingRows(){return this.db.prepare(`SELECT m.dataset,m.id,m.fingerprint,m.profile,m.result AS assessment,j.body,
    COALESCE(g.state,'pending') AS state,g.result,g.error,g.retry_at,g.attempts
    FROM match_runs m JOIN intake_analysis_queue q USING(dataset,id,fingerprint) JOIN intake_jobs j USING(dataset,id)
    LEFT JOIN greeting_runs g ON g.dataset=m.dataset AND g.id=m.id AND g.fingerprint=m.fingerprint AND g.profile=m.profile AND g.style=?
    WHERE m.profile=? AND m.state='completed' AND q.state!='deferred' AND json_extract(m.result,'$.priority') IN ('优先沟通','可以尝试')`).all(this.styleHash,this.profileHash);}
  greetingFor(dataset,id,fingerprint){return this.db.prepare('SELECT state,result,error FROM greeting_runs WHERE dataset=? AND id=? AND fingerprint=? AND profile=? AND style=?').get(dataset,id,fingerprint,this.profileHash,this.styleHash);}
  claimGreeting(now=Date.now()){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare("UPDATE greeting_runs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'retry' END,lease=NULL,error='lease_expired' WHERE state='running' AND retry_at<=?").run(now);
      const budget=this.db.prepare('SELECT jobs FROM match_budget WHERE day=?').get(this.day(now))?.jobs||0;
      const row=budget<this.dailyLimit?this.greetingRows().find(r=>(r.state==='pending'||r.state==='retry'&&r.retry_at<=now&&r.attempts<3)&&this.activityDecision(JSON.parse(r.body)).allowed):null;
      const lease=randomUUID();
      if(row){
        this.db.prepare(`INSERT INTO greeting_runs(dataset,id,fingerprint,profile,style,state,attempts,lease,retry_at,updated)
          VALUES(?,?,?,?,?,'running',1,?,?,?) ON CONFLICT(dataset,id,fingerprint,profile,style) DO UPDATE SET state='running',attempts=attempts+1,lease=excluded.lease,retry_at=excluded.retry_at,updated=excluded.updated`)
          .run(row.dataset,row.id,row.fingerprint,row.profile,this.styleHash,lease,now+300000,now);
        this.db.prepare('INSERT INTO match_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET jobs=jobs+1').run(this.day(now));
      }
      this.db.exec('COMMIT');return {row,lease};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  budgetAvailable(){return (this.db.prepare('SELECT jobs FROM match_budget WHERE day=?').get(this.day(Date.now()))?.jobs||0)<this.dailyLimit;}
  async nextStep(){
    if(!this.budgetAvailable())return {status:'idle',reason:'daily_limit'};
    const key=[databaseRevision(this.db),this.profileHash,this.styleHash,JSON.stringify(this.hrActivity)].join('|');
    if(this._idleKey===key&&this._idleUntil>Date.now())return {status:'idle'};
    const greeting=await this.greetingStep(),result=greeting.status==='idle'?await this.step(1):greeting;
    if(result.status==='idle'){this._idleKey=[databaseRevision(this.db),this.profileHash,this.styleHash,JSON.stringify(this.hrActivity)].join('|');this._idleUntil=Date.now()+5000;}
    return result;
  }
  scheduleReport(){
    this._reportDirty=true;if(this._reportTimer)return;
    this._reportTimer=setTimeout(()=>{this._reportTimer=null;this.flushReport();},30000);this._reportTimer.unref?.();
  }
  flushReport(){clearTimeout(this._reportTimer);this._reportTimer=null;if(!this._reportDirty)return;try{this.render();}catch{process.stderr.write('report_write_failed\n');}}
  async greetingStep(){
    if(this.profile.mode==='resume_missing')return {status:'paused'};
    if(this.greetingRunner===runGreeting&&!this.runtimeStatus().available)return {status:'paused',reason:'codex_binary_unavailable'};
    const profile=structuredClone(this.profile),policy=structuredClone(this.policy),profileHash=this.profileHash,style=this.styleHash;
    const {row,lease}=this.claimGreeting();if(!row)return {status:'idle'};
    const diagnostic=this.taskDiagnostic('greeting',[row]);
    this.activeStages.greeting++;
    try{
      const response=await this.greetingRunner(profile,analysisInput(JSON.parse(row.body)),JSON.parse(row.assessment),{cwd:join(this.dataDir,'codex-work'),policy,diagnosticContext:diagnostic.context});
      if(profileHash!==this.profileHash||style!==this.styleHash||!this.db.prepare("SELECT 1 FROM greeting_runs WHERE lease=? AND state='running'").get(lease))return {status:'superseded',stage:'greeting'};
      const result=validateGreeting(response.output,profile);
      this.db.prepare("UPDATE greeting_runs SET state='completed',lease=NULL,error=NULL,result=?,usage=?,updated=? WHERE lease=?").run(JSON.stringify(result),JSON.stringify(response.usage||null),Date.now(),lease);
      diagnostic.log('completed');
      this.scheduleReport();
      return {status:'completed',stage:'greeting',count:1};
    }catch(e){
      const code=/^[a-z_]+$/.test(e.message)?e.message:'greeting_failed',review=/^greeting_/.test(code);
      this.db.prepare("UPDATE greeting_runs SET state=CASE WHEN ? OR attempts>=3 THEN 'failed' ELSE 'retry' END,lease=NULL,error=?,retry_at=?,updated=? WHERE lease=?").run(Number(review),code,Date.now()+120000,Date.now(),lease);
      diagnostic.log('failed',code);
      this.scheduleReport();
      return {status:'failed',stage:'greeting',code,count:1};
    }finally{this.activeStages.greeting--;}
  }
  claim(limit=3,now=Date.now()){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      this.db.prepare("UPDATE match_runs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'retry' END,lease=NULL,error='lease_expired',retry_at=? WHERE state='running' AND retry_at<=?").run(now,now);
      const budget=this.db.prepare('SELECT jobs FROM match_budget WHERE day=?').get(this.day(now))?.jobs||0;
      limit=Math.max(0,Math.min(limit,this.dailyLimit-budget));
      const rows=limit?this.db.prepare(`SELECT q.*,j.body FROM intake_analysis_queue q JOIN intake_jobs j USING(dataset,id)
        LEFT JOIN match_runs m ON m.dataset=q.dataset AND m.id=q.id AND m.fingerprint=q.fingerprint AND m.profile=?
        WHERE q.state!='deferred' AND (m.state IS NULL OR m.state='pending' OR (m.state='retry' AND m.retry_at<=? AND m.attempts<3))
        ORDER BY CASE WHEN json_type(j.body,'$.scraper_source') IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN json_extract(j.body,'$.title') LIKE '%SaaS%' OR json_extract(j.body,'$.title') LIKE '%B端%' THEN 0
          WHEN json_extract(j.body,'$.title') LIKE '%产品%' THEN 1 ELSE 2 END, j.exported_at DESC,q.id`).all(this.profileHash,now)
        .filter(r=>this.activityDecision(JSON.parse(r.body)).allowed).slice(0,limit):[];
      const lease=randomUUID();
      for(const r of rows)this.db.prepare(`INSERT INTO match_runs(dataset,id,fingerprint,profile,state,attempts,lease,retry_at,updated)
        VALUES(?,?,?,?,'running',1,?,?,?) ON CONFLICT(dataset,id,fingerprint,profile) DO UPDATE SET
        state='running',attempts=attempts+1,lease=excluded.lease,retry_at=excluded.retry_at,updated=excluded.updated`).run(r.dataset,r.id,r.fingerprint,this.profileHash,lease,now+300000,now);
      if(rows.length)this.db.prepare('INSERT INTO match_budget VALUES(?,?) ON CONFLICT(day) DO UPDATE SET jobs=jobs+excluded.jobs').run(this.day(now),rows.length);
      this.db.exec('COMMIT');return {lease,rows};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  async step(limit=3){
    if(this.profile.mode==='resume_missing')return {status:'paused',reason:'resume_required',...this.status()};
    if(this.runner===runCodex&&!this.runtimeStatus().available)return {status:'paused',reason:'codex_binary_unavailable',...this.status()};
    // Settings can change while the runner awaits: bind this batch to its snapshot.
    const profile=structuredClone(this.profile),policy=structuredClone(this.policy),profileHash=this.profileHash;
    const {lease,rows}=this.claim(limit);
    if(!rows.length)return {status:'idle'};
    const diagnostic=this.taskDiagnostic('matching',rows);
    // BOSS ids may repeat across user datasets. Give each request a unique local
    // index instead, then bind returned results to exact claimed rows.
    const inputs=rows.map((r,i)=>({...analysisInput(JSON.parse(r.body)),id:`job-${i+1}`}));
    this.activeStages.matching++;
    try{
      const response=await this.runner(profile,inputs,{cwd:join(this.dataDir,'codex-work'),policy:{matchingSkill:policy.matchingSkill,greetingStyle:''},diagnosticContext:diagnostic.context});
      // User keeps only the current version. Never resurrect a superseded batch.
      const owned=this.db.prepare("SELECT COUNT(*) n FROM match_runs WHERE lease=? AND profile=? AND state='running'").get(lease,profileHash).n;
      if(this.profileHash!==profileHash||owned!==rows.length){
        this.db.prepare('DELETE FROM match_runs WHERE lease=?').run(lease);
        return {status:'superseded',count:rows.length,...this.status()};
      }
      const results=validateResults(response.output,inputs,profile,{assessmentOnly:true});
      this.db.exec('BEGIN IMMEDIATE');
      try{
        for(let i=0;i<rows.length;i++){
          const r=rows[i],result={...results.find(v=>v.id===inputs[i].id),id:r.id};
          this.db.prepare("UPDATE match_runs SET state='completed',lease=NULL,error=NULL,result=?,usage=?,updated=? WHERE dataset=? AND id=? AND fingerprint=? AND profile=? AND lease=?")
            .run(JSON.stringify(result),JSON.stringify(response.usage||null),Date.now(),r.dataset,r.id,r.fingerprint,profileHash,lease);
        }
        this.db.exec('COMMIT');
      }catch(e){this.db.exec('ROLLBACK');throw e;}
      this.scheduleReport();
      diagnostic.log('completed');
      return {status:'completed',stage:'matching',count:rows.length};
    }catch(e){
      const code=/^[a-z_]+$/.test(e.message)?e.message:'analysis_failed';
      this.db.prepare("UPDATE match_runs SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'retry' END,lease=NULL,error=?,retry_at=?,updated=? WHERE lease=? AND state='running'")
        .run(code,Date.now()+60000*2**Math.min(3,rows.length),Date.now(),lease);
      diagnostic.log('failed',code);
      this.scheduleReport();
      return {status:'failed',code,count:rows.length};
    }finally{this.activeStages.matching--;}
  }
  status(){
    const snapshot=cachedRead(this,'counts',[this.profileHash,this.styleHash,JSON.stringify(this.hrActivity)].join('|'),()=>this.statusCounts(),{tables:['intake_jobs','intake_analysis_queue','match_runs','greeting_runs']});
    return {...snapshot,active_stages:{...this.activeStages},runtime:this.runtimeStatus(),daily_limit:this.dailyLimit,daily_used:this.db.prepare('SELECT jobs FROM match_budget WHERE day=?').get(this.day(Date.now()))?.jobs||0};
  }
  statusCounts(){
    const jobs=this.store.jobMap();
    const rows=this.db.prepare(`SELECT q.dataset,q.id,COALESCE(m.state,'pending') AS state FROM intake_analysis_queue q
      LEFT JOIN match_runs m ON m.dataset=q.dataset AND m.id=q.id AND m.fingerprint=q.fingerprint AND m.profile=?
      WHERE q.state!='deferred'`).all(this.profileHash);
    const counts={};for(const row of rows){const state=this.queueState(row.state,jobs.get(JSON.stringify([row.dataset,row.id])));counts[state]=(counts[state]||0)+1;}
    const states=Object.entries(counts).map(([state,count])=>({state,count})).sort((a,b)=>a.state.localeCompare(b.state));
    const greetingCounts={};for(const row of this.greetingRows()){const state=this.queueState(row.state,JSON.parse(row.body));greetingCounts[state]=(greetingCounts[state]||0)+1;}
    return {states,greeting_states:Object.entries(greetingCounts).map(([state,count])=>({state,count})),
      deferred:this.db.prepare("SELECT COUNT(*) AS n FROM intake_analysis_queue WHERE state='deferred'").get().n};
  }
  contact(dataset,id,status){
    if(!['unknown','contacted','not_contacted'].includes(status)||!this.store.get(dataset,id))throw new Error('contact_identity_invalid');
    this.db.prepare('INSERT INTO manual_contact VALUES(?,?,?,?) ON CONFLICT(dataset,id) DO UPDATE SET status=excluded.status,updated=excluded.updated').run(dataset,id,status,new Date().toISOString());
    this.render();
  }
  retryFailed(){
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const now=Date.now(),eligible=table=>`EXISTS (SELECT 1 FROM intake_analysis_queue q WHERE q.dataset=${table}.dataset AND q.id=${table}.id AND q.fingerprint=${table}.fingerprint AND q.state!='deferred')`;
      const matching=this.db.prepare(`UPDATE match_runs SET state='pending',attempts=0,lease=NULL,retry_at=0,updated=? WHERE state IN ('failed','retry') AND profile=? AND ${eligible('match_runs')}`).run(now,this.profileHash).changes;
      const greeting=this.db.prepare(`UPDATE greeting_runs SET state='pending',attempts=0,lease=NULL,retry_at=0,updated=? WHERE state IN ('failed','retry') AND profile=? AND style=? AND ${eligible('greeting_runs')}`).run(now,this.profileHash,this.styleHash).changes;
      this.db.exec('COMMIT');return {matching,greeting,total:matching+greeting};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  render(){
    clearTimeout(this._reportTimer);this._reportTimer=null;
    mkdirSync(join(this.dataDir,'reports'),{recursive:true});
    const order={'优先沟通':0,'可以尝试':1,'低优先级':2,'不匹配':3};
    const rows=this.db.prepare(`SELECT m.*,j.body,c.status AS manual_status FROM match_runs m
      JOIN intake_analysis_queue q ON q.dataset=m.dataset AND q.id=m.id AND q.fingerprint=m.fingerprint
      JOIN intake_jobs j ON j.dataset=m.dataset AND j.id=m.id LEFT JOIN manual_contact c ON c.dataset=m.dataset AND c.id=m.id
      WHERE m.state='completed' AND m.profile=? AND q.state!='deferred'`).all(this.profileHash);
    const jobs=rows.map(r=>{const result=JSON.parse(r.result),g=this.greetingFor(r.dataset,r.id,r.fingerprint),job=JSON.parse(r.body);return {dataset:r.dataset,job,...result,...(g?.state==='completed'?JSON.parse(g.result):{}),greeting_state:this.queueState(g?.state||(['优先沟通','可以尝试'].includes(result.priority)?'pending':'not_required'),job),activity_gate:this.activityDecision(job),contact_status:r.manual_status||job.contact_status||'unknown',analyzed_at:new Date(r.updated).toISOString()};})
      .sort((a,b)=>Number(a.contact_status==='contacted')-Number(b.contact_status==='contacted')||order[a.priority]-order[b.priority]||b.analyzed_at.localeCompare(a.analyzed_at));
    const status=this.status(), keywords=[...new Set(jobs.filter(j=>['优先沟通','可以尝试'].includes(j.priority)).flatMap(j=>j.keywords))];
    const data={generated_at:new Date().toISOString(),profile:this.profileHash,engine:MATCHER_VERSION,status,keyword_suggestions:keywords,notice:'模型建议非录用概率；引文与事实ID经过程序校验，但不保证推理无误。打招呼草稿未发送。关键词需人工确认。沟通状态未知时请先核对BOSS消息，勿重复打招呼。',jobs};
    const safe=v=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\\[\]`*_]/g,'\\$&').replace(/\r?\n/g,' ');
    const lines=['# 自动岗位匹配报告','',data.notice,'',`生成时间：${data.generated_at}；已分析 ${jobs.length} 条；状态 ${JSON.stringify(status)}`,'','## 建议关键词（未自动加入搜索）','',safe(keywords.join('、'))||'暂无',''];
    for(const r of jobs){
      const j=r.job;lines.push(`## ${safe(r.priority)}｜${safe(j.title)}｜${safe(j.company||({'headhunter':'猎头（雇主待确认）','agency':'代招（雇主待确认）'}[j.hiring_party?.type]||'公司待确认'))}`,'',
        `${safe(j.salary)} / ${safe(j.location)} / 沟通状态：${{'unknown':'未知（先核对历史沟通）','contacted':'已沟通（勿重复打招呼）','not_contacted':'人工确认未沟通'}[r.contact_status]||safe(r.contact_status)}`,'',`[查看岗位](${j.url})`,'',safe(r.reason),'',
        ...r.evidence.map(e=>`- ${safe(e.relation)}：JD「${safe(e.jd_quote)}」 ↔ ${safe(e.fact_id)} ${safe(this.profile.facts[e.fact_id])}`),'',
        `缺口：${safe(r.gaps.join('；'))||'未列出，仍需核实'}`,'',`追问：${safe(r.questions.join('；'))}`,'',
        `招聘者活跃：${safe(activityReport(j))}`,'',
        `打招呼草稿：${r.contact_status==='contacted'?'已沟通，不再推荐发送':safe(r.greeting)||(r.greeting_state==='activity_skipped'?'被 HR 活跃条件跳过，放宽条件后可继续':['优先沟通','可以尝试'].includes(r.priority)?'待生成 / 请检查招呼队列':'本优先级不生成')}`,'',`记录沟通用ID：${safe(r.dataset)} / \`${r.id}\``,'');
    }
    for(const [name,content] of [['latest.json',JSON.stringify(data,null,2)],['latest.md',lines.join('\n')]]){
      const path=join(this.dataDir,'reports',name),tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,content,'utf8');renameSync(tmp,path);
    }
    this._reportDirty=false;return data;
  }
}
