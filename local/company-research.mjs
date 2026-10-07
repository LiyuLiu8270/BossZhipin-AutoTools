import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {researchCompanyNative} from './company-research-native.mjs';
import {CompanyIdentity,companyPageFor} from './company-identity.mjs';
const TOPICS=['主体核对','主营业务','规模与经营线索','新闻与奖项','风险线索'];
const QUALITY_VERSION=3;
export const RESEARCH_VERSION='company-research-v3-identity';
const TTL=30*86400000;
const reportTTL=report=>report?.status==='partial'?7*86400000:report?.status==='needs_review'?86400000:TTL;
const worthy=r=>['优先沟通','可以尝试'].includes(r.result?.priority)&&r.stage!=='ignored'&&r.reply_status!=='closed'&&r.job_state==='unknown';
export function companySubject(job){
 if(['headhunter','agency','conflicting'].includes(job?.hiring_party?.type))return null;
 const company=String(job?.company||'').normalize('NFKC').replace(/\s+/gu,' ').trim();
 if(company.length<2||company.length>160||/^某|^(未知|暂无|保密|公司名称|未披露|[—-]+)$/.test(company))return null;
 // Never strip corporate suffixes or merge a brand with its subsidiaries.
 const city=String(job.location||'').split(/[·\s/]/u)[0].slice(0,40);
 const legal=/(?:有限责任公司|有限公司|股份公司)$/.test(company);
 const page=companyPageFor(job);
 const key=createHash('sha256').update(JSON.stringify([page||company,page||legal?'':city,job.company_identity?.full_name||'',job.company_identity?.state==='conflict'?'conflict':'',RESEARCH_VERSION])).digest('hex');
 return {key,company,city:legal?'':city};
}
export class CompanyResearch {
 constructor(controller,{dataDir,model=researchCompanyNative,now=Date.now,identityResolver,probeNative=model===researchCompanyNative}={}){
  Object.assign(this,{controller,db:controller.db,dataDir,model,now});this.running=new Map();this.closed=false;this.started=false;
  this.db.exec(`CREATE TABLE IF NOT EXISTS company_research(key TEXT PRIMARY KEY,company TEXT NOT NULL,city TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL,next_at INTEGER NOT NULL DEFAULT 0,report TEXT,error TEXT,version TEXT NOT NULL);`);
  this.db.prepare("UPDATE company_research SET state='pending',error='interrupted' WHERE state='running'").run();
  this.db.exec('CREATE TABLE IF NOT EXISTS company_research_runtime(key TEXT PRIMARY KEY,body TEXT NOT NULL)');
  const legacyBlock=this.nativeBlock;
  // New browser capability deserves one fresh probe, but do not erase unrelated
  // faults, reports, user switches, budgets or the old diagnostic evidence.
  if(legacyBlock?.error==='research_native_search_unavailable'&&!legacyBlock.capabilityVersion){
   this.db.exec('SAVEPOINT research_capability_upgrade');try{
    this.db.prepare("INSERT OR REPLACE INTO company_research_runtime VALUES('native_block_before_browser',?)").run(JSON.stringify(legacyBlock));
    this.db.prepare("DELETE FROM company_research_runtime WHERE key='native_block'").run();this.db.exec('RELEASE research_capability_upgrade');
   }catch(e){this.db.exec('ROLLBACK TO research_capability_upgrade');this.db.exec('RELEASE research_capability_upgrade');throw e;}
  }
  this.probeNative=probeNative;this.nativeReady=!probeNative;
  this.identities=new CompanyIdentity(this.db,{now,isBusy:()=>this.closed||Boolean(controller.collector?.status().running)});
  this.resolveIdentity=identityResolver||this.identities.resolve.bind(this.identities);
 }
 get enabled(){return this.controller.read('companyResearch')?.enabled!==false;}
 get modelActive(){return this.running.size;}
 get busy(){return this.modelActive>0;}
 get nativeBlock(){const row=this.db.prepare("SELECT body FROM company_research_runtime WHERE key='native_block'").get();return row?JSON.parse(row.body):null;}
 blockNative(error){this.db.prepare("INSERT OR REPLACE INTO company_research_runtime VALUES('native_block',?)").run(JSON.stringify({error,at:this.now(),capabilityVersion:'public-browser-v1'}));}
 get concurrency(){return this.controller.read('companyResearch')?.concurrency??0;}
 get effectiveConcurrency(){return Math.min(this.concurrency||this.controller.settings.modelConcurrency,this.controller.settings.modelConcurrency);}
 get sharedUsed(){return this.controller.modelQueue?.active??((this.controller.scheduler?.active||0)+(this.controller.communications?.modelActive||0)+this.modelActive);}
 get(key){const r=this.db.prepare('SELECT * FROM company_research WHERE key=?').get(key);return r?{...r,report:r.report?JSON.parse(r.report):null}:null;}
 config(value){
  const concurrency=value?.concurrency??this.concurrency;
  if(!value||typeof value.enabled!=='boolean'||!Number.isInteger(concurrency)||concurrency<0||concurrency>16)throw Error('invalid_research_settings');
  this.controller.write('companyResearch',{...this.controller.read('companyResearch'),enabled:value.enabled,concurrency});this.wake();return this.status();
 }
 enqueue(subject){this.db.prepare("INSERT OR IGNORE INTO company_research(key,company,city,state,updated,version) VALUES(?,?,?,'pending',?,?)").run(subject.key,subject.company,subject.city,this.now(),RESEARCH_VERSION);}
 discover(){
  if(!this.enabled)return;
  if(this.now()<(this.nextDiscover||0))return;this.nextDiscover=this.now()+10000;
  const seen=new Set();for(const r of this.controller.rows())if(worthy(r)){const s=companySubject(r.job);if(!s||seen.has(s.key))continue;seen.add(s.key);this.enqueue(s);
   const record=this.get(s.key);
   const upgradeEmpty=record?.state==='needs_review'&&record.report?.evidenceCount===0&&record.report?.subject?.platform_identity?.state==='platform_verified'&&(record.report.quality_version||0)<QUALITY_VERSION;
   if(upgradeEmpty||record&&['completed','partial','needs_review'].includes(record.state)&&record.updated<this.now()-reportTTL(record.report))this.db.prepare("UPDATE company_research SET state='pending',attempts=0,error=? WHERE key=?").run(upgradeEmpty?'research_upgrade_recheck':null,s.key);
  }
 }
 summary(job){const s=companySubject(job);if(!s)return {state:'subject_unknown'};const r=this.get(s.key);return {state:r?.state||'pending',key:s.key,updated:r?.updated||null,hasReport:Boolean(r?.report),stale:Boolean(r?.report&&this.now()-Date.parse(r.report.generated_at)>reportTTL(r.report))};}
 detail(dataset,id){const r=this.controller.rows(dataset,id)[0];if(!r)throw Error('job_not_found');const s=companySubject(r.job);if(!s)return {state:'subject_unknown',reason:'猎头/代招或公司名称不明确，需确认实际用人主体。',report:null};const record=this.get(s.key);return {...this.summary(r.job),eligible:worthy(r),enabled:this.enabled,company:s.company,city:s.city,identity:r.job.company_identity||this.identities.get(r.job),report:record?.report||null,error:record?.error||null,attempts:record?.attempts||0};}
 retry({dataset,id}={}){
  const r=this.controller.rows(dataset,id)[0];if(!r)throw Error('job_not_found');if(!worthy(r))throw Error('research_not_eligible');const s=companySubject(r.job);if(!s)throw Error('research_subject_unknown');this.enqueue(s);const current=this.get(s.key);
  if(current.state==='running'||current.attempts>0&&this.now()-current.updated<60000)throw Error('research_busy');
  this.db.prepare("UPDATE company_research SET state='pending',attempts=0,next_at=0,error=NULL WHERE key=?").run(s.key);this.db.prepare("DELETE FROM company_research_runtime WHERE key='native_block'").run();this.nativeReady=!this.probeNative;this.wake();return this.detail(dataset,id);
 }
 status(){return {enabled:this.enabled,busy:this.busy,nativeBlock:this.nativeBlock,nativePreflight:!this.nativeReady,modelActive:this.modelActive,concurrency:this.concurrency,effectiveConcurrency:this.effectiveConcurrency,sharedLimit:this.controller.settings.modelConcurrency,sharedUsed:this.sharedUsed,budgetAvailable:this.controller.worker.budgetAvailable(),runtimeAvailable:this.controller.worker.runtimeStatus?.().available!==false,
  activeTasks:[...this.running.values()].map(s=>({company:s.fullName||s.row.company,city:s.row.city,startedAt:s.startedAt,elapsedSeconds:Math.max(0,Math.floor((this.now()-s.startedAt)/1000)),lastTool:s.lastTool||null})),
  counts:Object.fromEntries(this.db.prepare('SELECT state,count(*) AS n FROM company_research WHERE version=? GROUP BY state').all(RESEARCH_VERSION).map(r=>[r.state,r.n]))};}
 start(){if(this.started||this.closed)return;this.started=true;
  if(this.controller.modelQueue)this.unregister=this.controller.modelQueue.register('research',{kind:'research',ready:()=>!!this.nextQueuedRow(),run:()=>this.launchQueuedRow()});
  this.timer=setInterval(()=>this.wake(),1000);this.wake();}
 wake(){if(!this.started||this.closed)return;if(this.controller.modelQueue){this.controller.modelQueue.wake();return;}if(this.scheduled)return;this.scheduled=setImmediate(()=>{this.scheduled=null;this.tick().catch(()=>{});});}
 nextQueuedRow(){
  const w=this.controller.worker;
  if(this.closed||!this.started||!this.enabled||this.nativeBlock||!w.budgetAvailable()||w.runtimeStatus?.().available===false||this.modelActive>=this.effectiveConcurrency||!this.nativeReady&&this.modelActive>0)return null;
  this.discover();const eligible=new Set(this.controller.rows().filter(worthy).map(r=>companySubject(r.job)?.key).filter(Boolean));
  return this.db.prepare("SELECT * FROM company_research WHERE state IN ('pending','retry') AND next_at<=? ORDER BY updated,key").all(this.now()).find(r=>eligible.has(r.key)&&!this.running.has(r.key));
 }
 launchQueuedRow(){
  const row=this.nextQueuedRow();if(!row)return Promise.resolve({status:'idle'});
  const w=this.controller.worker;
  const claimed=this.db.prepare('INSERT INTO match_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET jobs=jobs+1 WHERE jobs<?').run(w.day(this.now()),w.dailyLimit).changes;
  if(!claimed)return Promise.resolve({status:'idle'});
  const slot={row,startedAt:this.now(),budgetDay:w.day(this.now()),modelStarted:false};this.running.set(row.key,slot);
  this.db.prepare("UPDATE company_research SET state='running',attempts=attempts+1,updated=?,error=NULL WHERE key=?").run(slot.startedAt,row.key);
  slot.promise=this.run(row,slot).finally(()=>{this.running.delete(row.key);this.controller.modelQueue.wake();});return slot.promise;
 }
 tick(){if(this.closed||!this.enabled||this.nativeBlock)return Promise.resolve();this.discover();
  if(this.controller.modelQueue){this.wake();return Promise.resolve();}
  const c=this.controller,w=c.worker;
  if(!w.budgetAvailable()||w.runtimeStatus?.().available===false||this.modelActive>=this.effectiveConcurrency||this.sharedUsed>=c.settings.modelConcurrency)return Promise.resolve();
  const eligible=new Set(c.rows().filter(worthy).map(r=>companySubject(r.job)?.key).filter(Boolean));
  const rows=this.db.prepare("SELECT * FROM company_research WHERE state IN ('pending','retry') AND next_at<=? ORDER BY updated,key").all(this.now()).filter(r=>eligible.has(r.key)&&!this.running.has(r.key)),launched=[];
  for(const row of rows){
   if(this.closed||!this.enabled||this.nativeBlock||!w.budgetAvailable()||this.modelActive>=this.effectiveConcurrency||this.sharedUsed>=c.settings.modelConcurrency||!this.nativeReady&&this.modelActive>0)break;
   // Synchronous reservation: sibling schedulers see occupancy before any await.
   const claimed=this.db.prepare('INSERT INTO match_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET jobs=jobs+1 WHERE jobs<?').run(w.day(this.now()),w.dailyLimit).changes;
   if(!claimed)break;
   const slot={row,startedAt:this.now(),budgetDay:w.day(this.now()),modelStarted:false};this.running.set(row.key,slot);
   this.db.prepare("UPDATE company_research SET state='running',attempts=attempts+1,updated=?,error=NULL WHERE key=?").run(slot.startedAt,row.key);
   slot.promise=this.run(row,slot).finally(()=>{this.running.delete(row.key);c.scheduler?.wake();this.wake();});
   launched.push(slot.promise);
  }
  // tick waits only for the work it claimed; refilling is per completion, not per cohort.
  return Promise.allSettled(launched);
 }
 async run(row,slot){
  try{
   const candidates=this.controller.rows().filter(r=>worthy(r)&&companySubject(r.job)?.key===row.key).map(r=>r.job);
   const job=candidates.find(j=>j.company_identity?.state==='platform_verified')||candidates[0];
   if(!job)throw Error('identity_browser_busy');
   slot.lastTool='identity';
   let identity=this.resolveIdentity(job);if(identity?.then)identity=await identity;
   const capturedNames=new Set(candidates.filter(j=>j.company_identity?.state==='platform_verified').map(j=>j.company_identity.full_name));
   if(capturedNames.size>1)identity={...identity,state:'conflict'};
   if(this.closed)throw Error('identity_browser_busy');
   slot.fullName=identity.full_name||null;
   const subject={company:identity.full_name||row.company,city:row.city,display_name:row.company,platform_identity:identity};
   let report;
   if(identity.state!=='platform_verified'){
    report={subject,status:'needs_review',quality_version:QUALITY_VERSION,identity_status:'uncertain',evidenceCount:0,generated_at:new Date(this.now()).toISOString(),sections:TOPICS.map(topic=>({topic,statements:[],unknowns:topic==='主体核对'?['未取得一致、可绑定到本岗位的工商全称；未使用简称继续联网背调。']:['主体未确认，暂未开展。']})),sources:[],questions:['招聘公司工商全称和劳动合同签约主体分别是什么？'],warnings:['公司主体识别状态：'+identity.state],disclaimer:'平台展示主体不等于劳动合同签约主体。'};
   }else{
    slot.modelStarted=true;slot.lastTool=null;
    report=await this.model(subject,{cwd:join(this.dataDir,'company-research-model',row.key),onTrace:event=>{if(slot)slot.lastTool=event.tool;}});
    this.nativeReady=true;
   }
   if(!report||!['completed','partial','insufficient','needs_review'].includes(report.status))throw Error('research_invalid_output');
   // The model owns interpretation and report completeness. No keyword,
   // quotation-count or topic-count formula overrides its report.
   this.db.prepare('UPDATE company_research SET state=?,updated=?,next_at=0,report=?,error=NULL WHERE key=?').run(report.status,this.now(),JSON.stringify(report),row.key);
  }catch(e){
   if(e.message.startsWith('identity_')){
    const waiting=['identity_browser_busy','identity_browser_paused'].includes(e.message);
    const retry=waiting||row.attempts<2;
    this.db.prepare('UPDATE company_research SET state=?,updated=?,next_at=?,error=?,attempts=attempts-? WHERE key=?').run(retry?'retry':'needs_review',this.now(),retry?this.now()+(waiting?60000:300000):0,e.message,waiting?1:0,row.key);return;
   }
   const code=['research_web_unavailable','research_native_search_unavailable','research_native_sources_missing','research_tool_isolation_failed','research_invalid_output','codex_network_unavailable','codex_binary_unavailable','codex_start_failed','codex_no_valid_completion','codex_timeout','codex_turn_failed','unexpected_tool_use'].includes(e.message)?e.message:'research_failed';
   if(this.probeNative&&(!this.nativeReady||['research_web_unavailable','research_native_search_unavailable','research_tool_isolation_failed','unexpected_tool_use'].includes(code)))this.blockNative(code);
   const transient=['codex_network_unavailable','codex_timeout','codex_turn_failed'].includes(code),retry=!this.nativeBlock&&transient&&row.attempts<2;
   this.db.prepare('UPDATE company_research SET state=?,updated=?,next_at=?,error=? WHERE key=?').run(retry?'retry':'failed',this.now(),retry?this.now()+3600000:0,code,row.key);
  }finally{if(slot&&!slot.modelStarted)this.db.prepare('UPDATE match_budget SET jobs=MAX(0,jobs-1) WHERE day=?').run(slot.budgetDay);}
 }
 stop(){this.closed=true;this.unregister?.();this.unregister=null;clearInterval(this.timer);clearImmediate(this.scheduled);this.scheduled=null;}
 async close(){this.stop();await Promise.allSettled([...this.running.values()].map(s=>s.promise));}
}
export function researchMarkdown(detail){
 const r=detail.report;if(!r)return '# 公司背调\n\n尚无报告。';const safe=s=>String(s).replace(/[<>]/g,'').replace(/\r/g,'');
 if(r.report_format==='codex_markdown')return [`# ${safe(r.subject.company)} — 公司背调`,`生成时间：${r.generated_at}`,r.markdown,'---',...(r.warnings||[])].join('\n\n');
 const identity=r.subject.platform_identity;
 const identityLines=identity?[`招聘显示名：${safe(r.subject.display_name||r.subject.company)}`,`工商全称：${safe(identity.full_name||'未取得')}；信用代码：${safe(identity.credit_code||'页面未展示')}`,`工商来源：${safe(identity.source_url||'未知')}；采集时间：${safe(identity.observed_at||'未知')}`,'平台展示工商主体不等于最终劳动合同签约主体。']:[];
 return [`# ${safe(r.subject.company)} — 公司背调`,`生成时间：${r.generated_at}`,`报告质量：${({completed:'资料较充分（不代表无风险）',partial:'有参考资料，覆盖不完整',insufficient:'未取得有效资料',needs_review:'主体待核实'})[r.status]||'旧版未评估'}；有效引文 ${r.evidenceCount||0} 条`,...(r.coverage?[`资料覆盖：${r.coverage.topics.join('、')||'无'}；缺口：${r.coverage.missing.join('、')||'无（仍需人工核实）'}`]:[]),...identityLines,`主体：${r.identity_status==='confirmed'?'名称证据已核对，仍需人工确认':'待核实，勿混用同名公司'}`,r.disclaimer,...r.sections.flatMap(s=>[`## ${s.topic}`,...s.statements.map(f=>`- ${safe(f.text)} [${safe(f.source_id)}]\n  > ${safe(f.quote)}`),...s.unknowns.map(x=>`- 待核实：${safe(x)}`)]),'## 面试核实问题',...r.questions.map(q=>`- ${safe(q)}`),'## 来源',...r.sources.map(s=>`- [${safe(s.id)}] ${safe(s.title)}\n  ${s.url}\n  读取：${s.accessed_at}；来源标注日期（未独立核对）：${safe(s.published_at)||'未知'}`),'## 限制',...(r.warnings||[]).map(x=>`- ${safe(x)}`)].join('\n\n');
}
