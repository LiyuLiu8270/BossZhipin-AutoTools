import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync,appendFileSync} from 'node:fs';
import {join,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {jobIdentity,readableJD,qualityOf} from '../shared/core.js';
import {executeBackfill} from './backfill.mjs';
import {createDetailPacer} from './detail-pacing.mjs';
import {collectPage} from '../shared/collector.js';
import {prepareScraperList} from './scraper-adapter.mjs';
import {CollectionBudget,detailGates} from './collection-budget.mjs';
import {applyActivityCapture} from '../shared/activity.js';
import {detailRows,detailSummary,detailState} from './detail-status.mjs';
import {cachedRead,trackReadTables} from './read-cache.mjs';
import {pythonPath,browserProfile} from './runtime-paths.mjs';

const defaults={enabled:false,intervalMinutes:360,city:'101280600',dataset:'我的求职',pages:2,dailyDetailLimit:30,nextRun:null,blocked:null};
const gates=detailGates;
const detailIdentityErrors=new Set(['detail_page_changed','scraper_detail_identity_conflict','scraper_orphan_detail','scraper_detail_invalid_url','scraper_detail_duplicate_identity']);
const diagnosticUrl=value=>{try{const u=new URL(value);return u.origin+u.pathname;}catch{return '';}};
export const searchBudgetSeconds=pages=>60+60*Math.max(1,Math.min(20,Number(pages)||1));
export async function ensureCollectorBrowser(){
  const ready=async()=>{try {const r=await fetch('http://127.0.0.1:19222/json/version',{signal:AbortSignal.timeout(2000)});return r.ok;}catch{return false;}};
  if(await ready())return;
  const executable=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  if(!executable)throw new Error('browser_unavailable');
  const child=spawn(executable,['--remote-debugging-address=127.0.0.1','--remote-debugging-port=19222','--remote-allow-origins=http://127.0.0.1:19222',
    `--user-data-dir=${browserProfile}`,'--no-first-run','--no-default-browser-check','https://www.zhipin.com/web/geek/jobs'],{windowsHide:true,detached:true,stdio:'ignore'});
  let failed=false;child.on('error',()=>{failed=true;});child.unref();
  for(let i=0;i<20&&!failed;i++){await new Promise(r=>setTimeout(r,500));if(await ready())return;}
  throw new Error('browser_unavailable');
}
export async function runBridge(mode,input,{directory,signal,timeoutMs=mode==='list'?(searchBudgetSeconds(input.pages)+120)*1000:180000}={}){
  const id=randomUUID(),source=join(directory,id+'-input.json'),output=join(directory,id+'-output.json');
  const debugFile=id+'-debug.jsonl';
  let debugWriteFailed=false;
  const trace=(event,fields={})=>{try{appendFileSync(join(directory,debugFile),JSON.stringify({at:new Date().toISOString(),task_id:basename(directory),operation_id:id,mode,event,...fields})+'\n','utf8');}catch{debugWriteFailed=true;}};
  trace('process_start',{timeout_ms:timeoutMs});
  writeFileSync(source,JSON.stringify(mode==='list'?{...input,keywordBudgetSeconds:searchBudgetSeconds(input.pages)}:input),'utf8');
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(pythonPath(),['-X','utf8','-u',fileURLToPath(new URL('./scraper-bridge.py',import.meta.url)),mode,source,output],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let text='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);trace('process_result',{error:error||null,ok:value?.ok??false});if(error){child.kill();const e=new Error(error);e.debugFile=debugFile;reject(e);}else resolve(value);};
    const abort=()=>finish('cancelled');
    const timer=setTimeout(()=>finish('collection_timeout'),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.on('error',()=>finish('collector_start_failed'));child.stderr.resume();
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{text+=chunk;if(text.length>100000)finish('bridge_output_invalid');});
    child.on('close',(code,termination)=>{trace('process_exit',{code,signal:termination});if(done)return;try{const r=JSON.parse(text.trim().split('\n').at(-1));if(typeof r.ok!=='boolean')throw 0;finish(null,r);}catch{finish('bridge_output_invalid');}});
  });
  let payload;
  try { payload=existsSync(output)?JSON.parse(readFileSync(output,'utf8')):null; }
  catch { trace('payload_read_failed');const e=new Error('bridge_output_invalid');e.debugFile=debugFile;throw e; }
  return {...result,payload,debugFile,debug_write_failed:debugWriteFailed||result.debug_write_failed===true};
}

export class Collector {
  constructor(store,controller,{dataDir,runner=runBridge,browser=ensureCollectorBrowser,now=()=>Date.now()}={}){
    Object.assign(this,{store,controller,db:store.db,dataDir,runner,browser,now});this.active=null;this.promise=null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS collection_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_runs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collection_details(dataset TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,PRIMARY KEY(dataset,id));`);
    trackReadTables(this.db,['collection_details']);
    this.config={...defaults,...JSON.parse(this.db.prepare("SELECT value FROM collection_config WHERE key='settings'").get()?.value||'{}')};
    if(this.config.maxDetails!==undefined){this.config.dailyDetailLimit=this.config.maxDetails;delete this.config.maxDetails;this.persist();}
    this.budget=new CollectionBudget(this.db,{dataDir,now});
    for(const row of this.db.prepare('SELECT id,body FROM collection_runs').all()){
      const run=JSON.parse(row.body);if(run.state==='running'){run.state='interrupted';run.error='service_restarted';run.finishedAt=this.now();this.saveRun(run);}
    }
  }
  persist(){this.db.prepare("INSERT INTO collection_config VALUES('settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(this.config));}
  save(value){
    if(!value||typeof value.enabled!=='boolean'||!Number.isInteger(value.intervalMinutes)||value.intervalMinutes<15||value.intervalMinutes>10080||
      !/^\d{9}$/.test(value.city)||typeof value.dataset!=='string'||!value.dataset.trim()||value.dataset.length>40||
      !Number.isInteger(value.pages)||value.pages<1||value.pages>20||!Number.isSafeInteger(value.dailyDetailLimit)||value.dailyDetailLimit<1)throw new Error('invalid_collection_settings');
    const changed=value.intervalMinutes!==this.config.intervalMinutes||!this.config.enabled;
    this.config={...this.config,enabled:value.enabled,intervalMinutes:value.intervalMinutes,city:value.city,dataset:value.dataset.trim(),pages:value.pages,dailyDetailLimit:value.dailyDetailLimit,
      nextRun:value.enabled?(changed||!this.config.nextRun?this.now()+value.intervalMinutes*60000:this.config.nextRun):null};
    this.persist();return this.status();
  }
  saveRun(run){this.db.prepare('INSERT INTO collection_runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id,JSON.stringify(run));}
  latest(){const row=this.db.prepare("SELECT body FROM collection_runs WHERE json_extract(body,'$.dataset')=? ORDER BY json_extract(body,'$.startedAt') DESC,rowid DESC LIMIT 1").get(this.config.dataset);return row?JSON.parse(row.body):null;}
  latestSearch(){const row=this.db.prepare("SELECT body FROM collection_runs WHERE json_extract(body,'$.dataset')=? AND json_extract(body,'$.trigger') NOT IN ('details','backfill') ORDER BY json_extract(body,'$.startedAt') DESC,rowid DESC LIMIT 1").get(this.config.dataset);return row?JSON.parse(row.body):null;}
  resumable(){const r=this.latest();return r&&['needs_attention','interrupted','cancelled','failed','daily_limit'].includes(r.state)?r:null;}
  incompleteKeywords(run=this.latestSearch()){const latest=new Map((run?.searchDiagnostics||[]).map(s=>[s.keyword,s]));return [...latest.values()].filter(s=>s.partial||s.error==='no_search_response').map(s=>s.keyword);}
  status(){return {config:this.config,running:Boolean(this.active),active:this.active?{...this.active}:null,
    resumable:this.active?null:this.resumable(),incompleteKeywords:this.incompleteKeywords(),latestSearchId:this.latestSearch()?.id||null,dailyDetails:this.budget.status(this.config.dailyDetailLimit),
    detailSummary:cachedRead(this,'detail-summary',this.config.dataset,()=>detailSummary(detailRows(this.store,this.config.dataset,this.now())),{tables:['intake_jobs','collection_details'],expiresAt:v=>v.nextRetryAt||Infinity,clock:this.now}),
    backlog:this.db.prepare("SELECT state,COUNT(*) AS count FROM collection_details WHERE dataset=? GROUP BY state").all(this.config.dataset),
    history:this.db.prepare("SELECT body FROM collection_runs ORDER BY json_extract(body,'$.startedAt') DESC LIMIT 10").all().map(r=>JSON.parse(r.body))};}
  start(trigger='manual',selectedKeywords=null,retryOf=null){
    if(this.active)throw new Error('collection_busy');
    const keywords=selectedKeywords||this.controller.settings.keywords.filter(k=>k.enabled).map(k=>k.text);
    if(!keywords.length&&trigger!=='details')throw new Error('collection_keywords_required');
    if(trigger==='details'&&!this.budget.status(this.config.dailyDetailLimit).remaining)throw new Error('detail_daily_limit');
    const run={id:randomUUID(),trigger,state:'running',phase:'starting',startedAt:this.now(),dataset:this.config.dataset,city:this.config.city,pages:this.config.pages,keywords,keyword:null,found:0,added:0,updated:0,details:0,failedDetails:0,error:null};
    Object.assign(run,{checkpointVersion:1,searchIndex:0,...(retryOf?{retryOf}:{})});
    this.active=run;this.abort=new AbortController();this.config.blocked=null;this.persist();this.saveRun(run);
    this.promise=this.execute(run,{...this.config},this.abort.signal).catch(()=>{});return {...run};
  }
  startDetails(){return this.start('details',[]);}
  async readDetail(mode,input,options){
    if(options.signal?.aborted)throw new Error('cancelled');
    const day=this.budget.reserve(this.config.dailyDetailLimit);
    try{const result=await this.runner(mode,input,options);if(gates.has(result.error))this.budget.refund(day);return result;}
    catch(e){if(gates.has(e.message)||e.message==='collector_start_failed')this.budget.refund(day);throw e;}
  }
  resume(value){
    if(this.active)throw new Error('collection_busy');
    const run=this.resumable();if(!run||value?.id!==run.id)throw new Error('collection_resume_unavailable');
    if(run.trigger==='backfill')return this.backfill(run.id);
    if(!Array.isArray(run.keywords)||!/^\d{9}$/.test(run.city))throw new Error('collection_resume_unavailable');
    // Legacy runs did not retain a cursor. Successful/partial searches are known
    // from their diagnostics; a populated detailTotal proves search phase ended.
    if(!Number.isInteger(run.searchIndex)){
      run.searchIndex=run.detailTotal!==undefined?run.keywords.length:0;
      while(run.searchIndex<run.keywords.length&&(run.searchDiagnostics||[]).some(s=>s.keyword===run.keywords[run.searchIndex]&&(!s.error||s.error==='no_search_response')))run.searchIndex++;
    }
    run.resumeEvents=[...(run.resumeEvents||[]),{at:this.now(),error:run.error,phase:run.resumePhase||run.phase}].slice(-20);
    Object.assign(run,{checkpointVersion:1,resumeCount:(run.resumeCount||0)+1,lastResumedAt:this.now(),state:'running',phase:run.searchIndex>=run.keywords.length?'details':'search',error:null});delete run.finishedAt;
    this.active=run;this.abort=new AbortController();this.config.blocked=null;this.persist();this.saveRun(run);
    this.promise=this.execute(run,{...this.config,dataset:run.dataset,city:run.city,pages:run.pages},this.abort.signal).catch(()=>{});return {...run};
  }
  retrySearch(value){
    if(this.active)throw new Error('collection_busy');
    const run=this.latestSearch();if(!run||run.id!==value?.id||this.resumable())throw new Error('collection_resume_unavailable');
    const keywords=this.incompleteKeywords(run);if(!keywords.length)throw new Error('collection_search_retry_unavailable');
    return this.start('search_retry',keywords,run.id);
  }
  async tick(){
    if(this.active||!this.config.enabled||this.config.blocked||!this.config.nextRun||this.config.nextRun>this.now())return;
    try{this.start('scheduled');}catch(e){this.config.blocked=e.message;this.persist();}
  }
  backfill(resumeOf=null){
    if(this.active)throw new Error('collection_busy');
    const run={id:randomUUID(),trigger:'backfill',state:'running',phase:'backfill',startedAt:this.now(),dataset:this.config.dataset,keywords:[],found:0,added:0,updated:0,details:0,failedDetails:0,processed:0,companyResolved:0,activityFound:0,unavailable:0,unresolved:0,error:null};
    if(resumeOf)run.resumeOf=resumeOf;
    this.active=run;this.abort=new AbortController();this.config.blocked=null;this.persist();this.saveRun(run);
    this.promise=executeBackfill(this,run,this.abort.signal);return {...run};
  }
  stop(){if(this.active)this.abort.abort();return {ok:true};}
  retry(){if(this.active)throw new Error('collection_busy');this.db.prepare("UPDATE collection_details SET state='pending',attempts=0,retry_at=0 WHERE dataset=?").run(this.config.dataset);return {ok:true};}
  async close(){this.stop();await this.promise;}
  async execute(run,config,signal){
    const directory=join(this.dataDir,'collection',run.id);mkdirSync(directory,{recursive:true});
    run.diagnosticVersion=1;
    const trace=(event,fields={})=>{try{appendFileSync(join(directory,'task-debug.jsonl'),JSON.stringify({at:new Date().toISOString(),task_id:run.id,event,phase:run.phase,keyword:run.keyword,...fields})+'\n','utf8');}catch{run.debugWriteFailed=true;}};
    trace('task_start',{keywords:run.keywords.length,pages:config.pages,daily_detail_limit:this.config.dailyDetailLimit});
    const checkpoint=()=>{if(signal.aborted)throw new Error('cancelled');this.saveRun(run);};
    let operation='browser_connect';
    try{
      await this.browser();checkpoint();
      for(let searchIndex=run.searchIndex||0;searchIndex<run.keywords.length;searchIndex++){
        const keyword=run.keywords[searchIndex];run.searchIndex=searchIndex;
        run.phase='search';run.keyword=keyword;checkpoint();
        let result;
        try { result=await this.runner('list',{keyword,city:config.city,pages:config.pages},{directory,signal}); }
        catch(e){run.searchDiagnostics||=[];run.searchDiagnostics.push({keyword,error:/^[a-z_]+$/.test(e.message)?e.message:'bridge_failed',debugFile:e.debugFile||null});throw e;}
        run.searchDiagnostics||=[];
        if(result.debug_write_failed)run.debugWriteFailed=true;
        run.searchDiagnostics.push({keyword,error:result.error||null,debugFile:result.debugFile||null,...result.search_diagnostics});checkpoint();
        trace('keyword_result',{ok:result.ok,error:result.error||null,raw_jobs:result.payload?.jobs?.length||0,debug_file:result.debugFile||null,...result.search_diagnostics});
        if(result.payload?.jobs?.length){
          const prepared=prepareScraperList(result.payload),list=prepared.list,observationId=run.id+':'+keyword;
          run.listRejected=(run.listRejected||0)+prepared.issues.length;
          run.listDuplicates=(run.listDuplicates||0)+prepared.duplicates;
          run.listIssues||=[];
          if(prepared.issues.length)run.listIssues.push({keyword,issues:prepared.issues});
          checkpoint();
          const received=this.store.importScraper({list,label:config.dataset,timezoneOffset:'+08:00',observationId});
          trace('list_imported',{accepted:list.jobs.length,rejected:prepared.issues.length,duplicates:prepared.duplicates,added:received.added||0,updated:received.updated||0});
          run.found+=list.jobs.length;run.added+=received.added||0;run.updated+=received.updated||0;
          for(const raw of list.jobs){
            const identity=jobIdentity(raw.job_link),saved=this.store.get(config.dataset,identity.id);
            if(readableJD(saved)||saved.link_access?.state==='unavailable'||saved.recruitment_signals?.availability?.value==='explicit_unavailable')continue;
            const body=JSON.stringify({list:{...list,jobs:[raw],total:1},observationId});
            this.db.prepare("INSERT INTO collection_details(dataset,id,body,state) VALUES(?,?,?,'pending') ON CONFLICT(dataset,id) DO UPDATE SET body=excluded.body").run(config.dataset,identity.id,body);
          }
        }
        const searchError=!result.ok?(result.error||'collection_failed'):!result.payload?'no_search_response':null;
        if(searchError&&searchError!=='no_search_response')throw new Error(searchError);
        if(searchError==='no_search_response')Object.assign(run.searchDiagnostics.at(-1),{error:searchError,partial:true});
        run.searchWarnings=this.incompleteKeywords(run).length;
        run.searchIndex=searchIndex+1;checkpoint();
      }
      if(!Array.isArray(run.detailIds)){
        run.detailIds=detailRows(this.store,config.dataset,this.now()).filter(r=>r.detail_state==='pending').sort((a,b)=>a.detail_retry_at-b.detail_retry_at||a.id.localeCompare(b.id)).map(r=>r.id);
        run.detailIndex=0;run.detailTotal=(run.details||0)+(run.failedDetails||0)+run.detailIds.length;
      }
      // Old snapshots were truncated by a per-run limit. Extend them once without losing the cursor.
      if(run.detailQueueVersion!==2){
        const ids=new Set(run.detailIds);
        for(const row of detailRows(this.store,config.dataset,this.now()).filter(r=>r.detail_state==='pending'))if(!ids.has(row.id)){run.detailIds.push(row.id);ids.add(row.id);}
        run.detailTotal=(run.details||0)+(run.failedDetails||0)+run.detailIds.length-(run.detailIndex||0);run.detailQueueVersion=2;
      }
      run.phase='details';checkpoint();
      trace('details_started',{queued:run.detailIds.length-run.detailIndex,resume_count:run.resumeCount||0});
      const pace=createDetailPacer(this.detailIntervalMs??5000);
      for(let detailIndex=run.detailIndex;detailIndex<run.detailIds.length;detailIndex++){
        operation='detail_queue_load';
        run.detailIndex=detailIndex;
        const row=this.db.prepare('SELECT * FROM collection_details WHERE dataset=? AND id=?').get(config.dataset,run.detailIds[detailIndex]);
        if(!row||row.state!=='pending'||row.retry_at>this.now()){run.detailIndex=detailIndex+1;checkpoint();continue;}
        checkpoint();const entry=JSON.parse(row.body),raw=entry.list.jobs[0];run.jobTitle=raw.title;checkpoint();
        const saved=this.store.get(config.dataset,row.id);
        if(readableJD(saved)||saved.link_access?.state==='unavailable'||saved.recruitment_signals?.availability?.value==='explicit_unavailable'){
          this.db.prepare('DELETE FROM collection_details WHERE dataset=? AND id=?').run(config.dataset,row.id);run.detailIndex=detailIndex+1;checkpoint();continue;
        }
        if(detailState(saved,row,this.now())!=='pending'){run.detailIndex=detailIndex+1;checkpoint();continue;}
        operation='detail_pacing';await pace(signal);checkpoint();
        operation='detail_read';
        let result;
        try{result=await this.readDetail('detail',{job:raw,expression:`JSON.stringify((${collectPage.toString()})())`},{directory,signal,timeoutMs:45000});}
        catch(e){if(!detailIdentityErrors.has(e.message))throw e;result={ok:false,error:e.message,debugFile:e.debugFile};}
        checkpoint();
        const readiness=result.detail_readiness?.reason;
        trace('detail_result',{id:row.id,attempt:row.attempts+1,expected_url:diagnosticUrl(raw.job_link),ok:result.ok,error:result.error||null,debug_file:result.debugFile||null,identity:result.detail_identity||null,...(['not_observed','job_unavailable','shared_not_captured','title_missing','jd_missing','jd_truncated','upstream_parse_failed','page_loading','ready','not_readable'].includes(readiness)?{readiness}:{})});
        operation='detail_import';let validationReason;
        try{
        if(result.ok&&result.payload?.status==='job_unavailable'){
          const capture=result.payload,current=this.store.get(config.dataset,row.id);
          if(jobIdentity(capture.source_url)?.id!==row.id||capture.jobs?.length!==1||jobIdentity(capture.jobs[0].url)?.id!==row.id)throw new Error('detail_page_changed');
          let next;try{next=applyActivityCapture({jobs:{[row.id]:current},runs:[]},capture,row.id,result.observed_at||new Date(this.now()).toISOString()).dataset.jobs[row.id];}catch{throw new Error('detail_unavailable_evidence_invalid');}
          const at=this.db.prepare('SELECT exported_at FROM intake_jobs WHERE dataset=? AND id=?').get(config.dataset,row.id).exported_at;
          this.store.importPayload({schema_version:2,label:config.dataset,exported_at:new Date(Math.max(this.now(),Date.parse(at)+1)).toISOString(),jobs:[next]},'detail:closed');
          run.unavailable=(run.unavailable||0)+1;this.db.prepare('DELETE FROM collection_details WHERE dataset=? AND id=?').run(config.dataset,row.id);
          trace('detail_unavailable',{id:row.id});
        }else if(result.ok&&result.payload?.length){
          if(!Array.isArray(result.payload)||result.payload.length!==1||jobIdentity(result.payload[0].job_link||result.payload[0].url)?.id!==row.id)throw new Error('detail_page_changed');
          const received=this.store.importScraper({list:entry.list,details:result.payload,label:config.dataset,timezoneOffset:'+08:00',observationId:entry.observationId,detailsObservedAt:result.observed_at});
          const savedResult=this.store.get(config.dataset,row.id);
          if(!readableJD(savedResult)){result.ok=false;validationReason=!savedResult.jd?'jd_missing':qualityOf(savedResult).includes('jd_encoded_font')?'jd_encoded_font':savedResult.jd_truncated?'jd_truncated':'jd_content_rejected';}
          else{run.details++;run.updated+=received.updated||0;this.db.prepare('DELETE FROM collection_details WHERE dataset=? AND id=?').run(config.dataset,row.id);}
          trace('detail_validation',{id:row.id,accepted:result.ok,reason:validationReason||'accepted',jd_status:savedResult.jd_status,jd_chars:savedResult.jd.length});
        }else result.ok=false;
        }catch(e){
          if(!detailIdentityErrors.has(e.message))throw e;
          result.ok=false;result.error=e.message;validationReason=e.message;
          trace('detail_identity_rejected',{id:row.id,stage:operation,expected_url:diagnosticUrl(raw.job_link),actual_url:diagnosticUrl(result.payload?.source_url||result.payload?.[0]?.job_link||result.payload?.[0]?.url),captured_job_url:diagnosticUrl(result.payload?.jobs?.[0]?.url),error:e.message});
        }
        if(!result.ok){
          if(gates.has(result.error))throw new Error(result.error);
          run.failedDetails++;
          run.failureReasons||={};const reason=validationReason||(['shared_not_captured','title_missing','jd_missing','jd_truncated','upstream_parse_failed','page_loading'].includes(readiness)?readiness:result.error||'detail_not_readable');run.failureReasons[reason]=(run.failureReasons[reason]||0)+1;
          const nextState=row.attempts>=2?'review':'pending';
          const detailFailure={reason,attempt:row.attempts+1,at:this.now(),debugFile:result.debugFile||null,identity:result.detail_identity||null};
          this.db.prepare('UPDATE collection_details SET attempts=attempts+1,state=?,retry_at=?,body=? WHERE dataset=? AND id=?').run(nextState,this.now()+3600000,JSON.stringify({...entry,detailFailure}),config.dataset,row.id);
          trace('detail_deferred',{id:row.id,error:reason,attempt:row.attempts+1,state:nextState,next_cursor:detailIndex+1});
        }
        // Persist the next cursor together with completed counters. A gate above
        // leaves the current item untouched and consumes no failure attempt.
        run.detailIndex=detailIndex+1;checkpoint();
      }
      run.state=run.failedDetails||run.listRejected||run.searchWarnings?'partial':'completed';
    }catch(e){run.error=signal.aborted?'cancelled':/^[a-z_]+$/.test(e.message)?e.message:'collection_failed';trace('task_error',{error:run.error,operation,exception:['Error','TypeError','SyntaxError','RangeError','AbortError','TimeoutError'].includes(e.name)?e.name:'Error',debug_file:e.debugFile||null});run.state=run.error==='detail_daily_limit'?'daily_limit':run.error==='cancelled'?'cancelled':gates.has(run.error)?'needs_attention':'failed';if(gates.has(run.error))this.config.blocked=run.error;}
    finally{run.finishedAt=this.now();run.resumePhase=run.phase;run.phase='finished';trace('task_end',{state:run.state,error:run.error,found:run.found,details:run.details,search_warnings:run.searchWarnings||0});this.saveRun(run);if(run.trigger!=='details')this.config.nextRun=this.config.enabled?this.now()+this.config.intervalMinutes*60000:null;this.persist();this.active=null;}
  }
}
