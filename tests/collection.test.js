import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IntakeStore} from '../local/intake.mjs';
import {Collector,searchBudgetSeconds} from '../local/collector.mjs';
const raw={title:'产品经理',job_link:'https://www.zhipin.com/job_detail/abc.html',encrypt_job_id:'abc',boss_name:'测试公司'};
const list={scraped_at:'2026-09-30T10:00:00+08:00',keyword:'产品经理',jobs:[raw]};
function setup(options={}){
 const store=new IntakeStore(':memory:'),dir=mkdtempSync(join(tmpdir(),'career-collection-'));
 const controller={settings:{keywords:[{text:'产品经理',enabled:true}]}};
 const collector=new Collector(store,controller,{dataDir:dir,browser:async()=>{},...options});
 const cleanup=async()=>{await collector.close();store.close();rmSync(dir,{recursive:true,force:true});};
 return {store,collector,controller,cleanup};
}

test('停止发生在详情间隔等待时应为cancelled，保留游标、不扣下一条额度',async()=>{
 let reads=0;const jobs=['stop_a','stop_b'].map(id=>({...raw,encrypt_job_id:id,job_link:`https://www.zhipin.com/job_detail/${id}.html`}));
 const env=setup({runner:async(mode,input)=>{if(mode==='list')return {ok:true,payload:{...list,jobs}};reads++;return {ok:true,payload:[{...input.job,jd:'负责企业需求分析及产品设计交付。'.repeat(30)}]};}});
 env.collector.detailIntervalMs=2000;
 try{
  env.collector.start();for(let i=0;i<100&&env.collector.active?.detailIndex!==1;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(env.collector.active.detailIndex,1);env.collector.stop();await env.collector.promise;
  const run=env.collector.status().history[0];assert.equal(run.state,'cancelled');assert.equal(run.error,'cancelled');assert.equal(run.details,1);assert.equal(run.failedDetails,0);assert.equal(reads,1);assert.equal(run.detailIndex,1);assert.equal(env.collector.status().dailyDetails.used,1);
 }finally{await env.cleanup();}
});

test('详情明确关闭保存证据，保留JD/人工状态，不算JD成功或失败',async()=>{
 const capture={status:'job_unavailable',source_url:raw.job_link,jobs:[{url:raw.job_link,title:'',recruitment_signals:{availability:[{text:'该职位已关闭',selector:'.job-status'}]}}]};
 const env=setup({runner:async mode=>mode==='list'?{ok:true,payload:list}:{ok:true,payload:capture}});env.collector.detailIntervalMs=0;
 try{
  env.store.importScraper({list,label:env.collector.config.dataset,timezoneOffset:'+08:00'});
  const previous=env.store.get(env.collector.config.dataset,'boss:abc');
  env.store.importPayload({schema_version:2,label:env.collector.config.dataset,exported_at:new Date().toISOString(),jobs:[{...previous,jd:'先前保留的部分正文，展开全部',jd_status:'partial',contact_status:'contacted'}]});
  env.collector.start();await env.collector.promise;const run=env.collector.latest(),saved=env.store.get(env.collector.config.dataset,'boss:abc');
  assert.equal(run.state,'completed');assert.equal(run.unavailable,1);assert.equal(run.details,0);assert.equal(run.failedDetails,0);assert.equal(saved.recruitment_signals.availability.value,'explicit_unavailable');assert.equal(saved.jd,'先前保留的部分正文，展开全部');assert.equal(saved.contact_status,'contacted');assert.equal(env.collector.status().backlog.length,0);assert.equal(env.collector.status().dailyDetails.used,1);
 }finally{await env.cleanup();}
});

test('无关闭证据和错岗位的关闭结果不得使岗位失效',async()=>{
 for(const wrong of [false,true]){
  const url=wrong?'https://www.zhipin.com/job_detail/other.html':raw.job_link;
  const env=setup({runner:async mode=>mode==='list'?{ok:true,payload:list}:{ok:true,payload:{status:'job_unavailable',source_url:url,jobs:[{url,recruitment_signals:{}}]}}});env.collector.detailIntervalMs=0;
  try{env.collector.start();await env.collector.promise;assert.equal(env.collector.latest().error,wrong?'detail_page_changed':'detail_unavailable_evidence_invalid');assert.notEqual(env.store.get(env.collector.config.dataset,'boss:abc').recruitment_signals.availability.value,'explicit_unavailable');assert.equal(env.collector.status().backlog[0].count,1);}finally{await env.cleanup();}
 }
});

test('详情门禁恢复保留游标、失败次数与每日累计额度，已完成搜索不重跑',async()=>{
 const calls=[];let gated=true;
 const jobs=['a','b','c'].map(id=>({...raw,encrypt_job_id:id,job_link:`https://www.zhipin.com/job_detail/${id}.html`}));
 const runner=async(mode,value)=>{calls.push(mode==='list'?'list':value.job.encrypt_job_id);if(mode==='list')return {ok:true,payload:{...list,jobs}};if(value.job.encrypt_job_id==='b'&&gated)return {ok:false,error:'login_required'};return {ok:true,payload:[{...value.job,jd:'负责需求分析和产品交付。'.repeat(30)}]};};
 const env=setup({runner});env.collector.detailIntervalMs=0;
 try{
  env.collector.config.dailyDetailLimit=2;env.collector.start();await env.collector.promise;
  const paused=env.collector.status().resumable;assert.equal(paused.details,1);assert.equal(paused.detailIndex,1);assert.equal(paused.detailTotal,3);assert.equal(env.collector.status().dailyDetails.used,1);
  assert.equal(env.store.db.prepare('SELECT attempts FROM collection_details WHERE id=?').get('boss:b').attempts,0);
  assert.throws(()=>env.collector.resume({id:'stale'}),/resume_unavailable/);
  env.collector.resume({id:paused.id});assert.throws(()=>env.collector.resume({id:paused.id}),/busy/);await env.collector.promise;
  assert.equal(env.collector.config.blocked,'login_required');assert.equal(env.collector.status().resumable.detailIndex,1);
  gated=false;env.controller.settings.keywords=[];
  const reloaded=new Collector(env.store,env.controller,{dataDir:env.collector.dataDir,runner,browser:async()=>{}});reloaded.detailIntervalMs=0;
  reloaded.resume({id:paused.id});await reloaded.promise;
  assert.deepEqual(calls,['list','a','b','b','b']);assert.equal(reloaded.status().history[0].details,2);assert.equal(reloaded.status().history[0].state,'daily_limit');
  assert.equal(reloaded.config.blocked,null);assert.equal(reloaded.status().dailyDetails.used,2);assert.equal(reloaded.status().backlog[0].count,1);
 }finally{await env.cleanup();}
});

test('搜索阶段恢复只重搜中断词；完成词和原搜索范围保留',async()=>{
 const calls=[];let gated=true;const env=setup({runner:async(mode,input)=>{calls.push(input.keyword);return input.keyword==='second'&&gated?{ok:false,error:'verification_required'}:{ok:true,payload:{...list,keyword:input.keyword,jobs:[]}};}});
 try{
  env.controller.settings.keywords=['first','second','third'].map(text=>({text,enabled:true}));env.collector.start();await env.collector.promise;
  const r=env.collector.status().resumable;assert.equal(r.searchIndex,1);gated=false;env.controller.settings.keywords=[{text:'changed',enabled:true}];
  env.collector.resume({id:r.id});await env.collector.promise;
  assert.deepEqual(calls,['first','second','second','third']);assert.equal(env.collector.status().history[0].state,'completed');assert.equal(env.collector.status().history[0].searchWarnings,0);
 }finally{await env.cleanup();}
});

test('旧版本详情中断兼容：废止原轮上限，按每日额度继续且不重新搜索',async()=>{
 const calls=[];const env=setup({runner:async(mode,input)=>{calls.push(mode);return {ok:true,payload:[{...input.job,jd:'负责需求分析和产品交付。'.repeat(30)}]};}});env.collector.detailIntervalMs=0;
 try{
  const c=env.collector;for(const id of ['legacy_a','legacy_b']){const j={...raw,encrypt_job_id:id,job_link:`https://www.zhipin.com/job_detail/${id}.html`},l={...list,jobs:[j]};env.store.importScraper({list:l,label:c.config.dataset,timezoneOffset:'+08:00'});env.store.db.prepare("INSERT INTO collection_details(dataset,id,body,state) VALUES(?,?,?,'pending')").run(c.config.dataset,'boss:'+id,JSON.stringify({list:l,observationId:'old'}));}
  c.saveRun({id:'legacy',dataset:c.config.dataset,state:'needs_attention',phase:'finished',error:'login_required',startedAt:Date.now(),city:c.config.city,pages:20,maxDetails:3,keywords:['old'],details:1,failedDetails:1,detailTotal:3,found:2,updated:0});
  c.resume({id:'legacy'});await c.promise;
  assert.deepEqual(calls,['detail','detail']);const r=c.status().history[0];assert.equal(r.details,3);assert.equal(r.detailTotal,4);assert.equal(r.state,'partial');assert.equal(c.status().backlog.length,0);
 }finally{await env.cleanup();}
});

test('搜索缺口定向重试只运行问题词；分页软预算与硬超时留有余量',async()=>{
 assert.equal(searchBudgetSeconds(1),120);assert.equal(searchBudgetSeconds(20),1260);
 const calls=[];let first=true;const env=setup({runner:async(mode,input)=>{calls.push(input.keyword);return {ok:true,payload:{...list,jobs:[],keyword:input.keyword},search_diagnostics:{partial:first&&input.keyword==='slow',stop_reason:'keyword_time_budget'}};}});
 try{
  env.controller.settings.keywords=['good','slow'].map(text=>({text,enabled:true}));env.collector.start();await env.collector.promise;
  const r=env.collector.status().history[0];assert.deepEqual(env.collector.status().incompleteKeywords,['slow']);first=false;
  env.collector.retrySearch({id:r.id});await env.collector.promise;assert.deepEqual(calls,['good','slow','slow']);assert.deepEqual(env.collector.status().incompleteKeywords,[]);
 }finally{await env.cleanup();}
});
test('网页任务链路：列表入库、详情补齐、自动入分析队列，重跑不重复采详情',async()=>{
 let calls=0;const env=setup({runner:async mode=>{calls++;return mode==='list'?{ok:true,payload:list}:{ok:true,observed_at:'2026-09-30T10:01:00+08:00',payload:[{...raw,jd:'负责产品需求分析设计和交付。'.repeat(30)}]};}});
 try{const {collector,store}=env;collector.start();assert.throws(()=>collector.start(),/busy/);await collector.promise;
 assert.equal(collector.status().history[0].state,'completed');assert.equal(collector.status().history[0].details,1);
 assert.equal(store.stats()[0].pending_analysis,1);assert.equal(store.stats()[0].jobs,1);
 collector.start();await collector.promise;assert.equal(calls,3);assert.equal(store.stats()[0].jobs,1);
 }finally{await env.cleanup();}
});

test('短正文采集完成并入分析队列，重复搜索不再补采或扣详情额度',async()=>{
 const calls=[];const jd='负责产品需求分析与交付。';
 const env=setup({runner:async mode=>{calls.push(mode);return mode==='list'?{ok:true,payload:list}:{ok:true,payload:[{...raw,jd}]};}});env.collector.detailIntervalMs=0;
 try{
  env.collector.start();await env.collector.promise;
  const saved=env.store.get(env.collector.config.dataset,'boss:abc');
  assert.equal(saved.jd,jd);assert.equal(saved.jd_status,'short_unverified');
  assert.equal(env.collector.latest().state,'completed');assert.equal(env.collector.latest().details,1);assert.equal(env.collector.latest().failedDetails,0);
  assert.equal(env.collector.status().backlog.length,0);assert.equal(env.store.stats()[0].pending_analysis,1);assert.equal(env.collector.status().dailyDetails.used,1);
  env.collector.start();await env.collector.promise;
  assert.deepEqual(calls,['list','detail','list']);assert.equal(env.collector.latest().state,'completed');assert.equal(env.collector.latest().detailTotal,0);
  assert.equal(env.collector.status().dailyDetails.used,1);assert.equal(env.collector.status().backlog.length,0);assert.equal(env.store.stats()[0].pending_analysis,1);
 }finally{await env.cleanup();}
});

test('Word文本间圆点不误判正文失败；未知字体字符记录具体校验原因',async()=>{
 for(const [marker,success] of [['\uF0B7',true],['\uE123',false]]){
  const jd='理解跨境支付与物流'+marker+'熟练使用产品设计工具。';
  const env=setup({runner:async mode=>mode==='list'?{ok:true,payload:list}:{ok:true,payload:[{...raw,jd}],detail_readiness:{reason:'ready'}}});env.collector.detailIntervalMs=0;
  try{env.collector.start();await env.collector.promise;const r=env.collector.latest();assert.equal(r.details,success?1:0);assert.equal(r.failedDetails,success?0:1);assert.equal(env.store.get(env.collector.config.dataset,'boss:abc').jd,jd);if(!success)assert.equal(r.failureReasons.jd_encoded_font,1);}finally{await env.cleanup();}
 }
});

test('列表异常不拖停后续关键词及详情；全部异常不伪报完整成功',async()=>{
 const calls=[],good={...raw,job_link:'https://www.zhipin.com/job_detail/good~.html',encrypt_job_id:'good~'};
 const env=setup({runner:async(mode,value)=>{
  calls.push(mode==='list'?value.keyword:value.job.encrypt_job_id);
  if(mode==='list')return {ok:true,payload:{...list,keyword:value.keyword,jobs:value.keyword==='bad'?[{...raw,encrypt_job_id:'wrong'},null]:[good,good]}};
  return {ok:true,observed_at:'2026-09-30T10:01:00+08:00',payload:[{...value.job,jd:'负责产品需求分析设计和交付。'.repeat(30)}]};
 }});
 try{
  env.controller.settings.keywords=[{text:'bad',enabled:true},{text:'good',enabled:true}];
  env.collector.start();await env.collector.promise;
  const run=env.collector.status().history[0];
  assert.deepEqual(calls,['bad','good','good~']);assert.equal(run.state,'partial');assert.equal(run.listRejected,2);assert.equal(run.listDuplicates,1);assert.equal(run.found,1);assert.equal(run.details,1);assert.equal(run.listIssues[0].keyword,'bad');
  assert.equal(env.store.get(env.collector.config.dataset,'boss:abc'),null);assert.ok(env.store.get(env.collector.config.dataset,'boss:good~').jd);
  env.controller.settings.keywords=[{text:'bad',enabled:true}];env.collector.start();await env.collector.promise;
  assert.equal(env.collector.status().history[0].state,'partial');
 }finally{await env.cleanup();}
});
test('定时持久化、到点执行、禁用/阻断不触发，错过多轮只执行一轮',async()=>{
 let now=1000000000000,calls=0;const env=setup({now:()=>now,runner:async()=>{calls++;return {ok:true,payload:{...list,jobs:[]}};}});
 try{const {collector}=env;collector.save({...collector.config,enabled:true,intervalMinutes:15});await collector.tick();assert.equal(calls,0);
 now+=3600000;await collector.tick();await collector.promise;assert.equal(calls,1);assert.equal(collector.status().history[0].trigger,'scheduled');
 await collector.tick();assert.equal(calls,1);assert.equal(collector.config.nextRun,now+900000);
 collector.config.blocked='login_required';now+=900000;await collector.tick();assert.equal(calls,1);
 collector.save({...collector.config,enabled:false});assert.equal(collector.config.nextRun,null);
 }finally{await env.cleanup();}
});

test('无响应关键词与已恢复超时均继续其余搜索和详情，记录逐词诊断且不伪报完整完成',async()=>{
 const calls=[];const env=setup({runner:async(mode,value)=>{
  calls.push(mode==='list'?value.keyword:'detail');
  if(mode==='list'&&value.keyword==='timeout')return {ok:false,error:'no_search_response',payload:null,debugFile:'test-debug.jsonl',search_diagnostics:{partial:true,warnings:[{page:1,reason:'request_not_observed'}]}};
  if(mode==='list')return {ok:true,payload:list,search_diagnostics:{partial:true,missing_responses:1,warnings:[{page:2,reason:'response_not_finished'}]}};
  return {ok:true,observed_at:'2026-09-30T10:01:00+08:00',payload:[{...raw,jd:'负责产品需求分析设计和交付。'.repeat(30)}]};
 }});
 try{
  env.controller.settings.keywords=[{text:'timeout',enabled:true},{text:'recovered',enabled:true}];
  env.collector.start();await env.collector.promise;
  const r=env.collector.status().history[0];assert.deepEqual(calls,['timeout','recovered','detail']);
  assert.equal(r.state,'partial');assert.equal(r.searchWarnings,2);assert.equal(r.details,1);assert.equal(r.error,null);assert.equal(r.searchDiagnostics[0].warnings[0].page,1);assert.equal(r.searchDiagnostics[0].debugFile,'test-debug.jsonl');
 }finally{await env.cleanup();}
});

test('恢复过无响应也不能掩盖登录、验证码、搜索跳转和浏览器断连门禁',async()=>{
 for(const gate of ['verification_required','login_required','search_page_changed','browser_unavailable']){
  let calls=0;const env=setup({runner:async()=>{calls++;return {ok:false,error:gate,payload:list,search_diagnostics:{partial:true,missing_responses:1}};}});
  try{
   env.controller.settings.keywords=[{text:'first',enabled:true},{text:'must-not-run',enabled:true}];env.collector.start();await env.collector.promise;
   assert.equal(calls,1);assert.equal(env.collector.status().history[0].state,'needs_attention');assert.equal(env.collector.config.blocked,gate);
  }finally{await env.cleanup();}
 }
});
test('登录/验证阻断可恢复；零响应不伪报完成；已采结果保存',async()=>{
 let outcome={ok:false,error:'verification_required',payload:list};const env=setup({runner:async()=>outcome});
 try{const {collector,store}=env;collector.start();await collector.promise;
 assert.equal(collector.config.blocked,'verification_required');assert.equal(store.stats()[0].jobs,1);
 outcome={ok:false,error:'no_search_response',payload:null};collector.start();await collector.promise;
 assert.equal(collector.status().history[0].state,'partial');assert.equal(collector.status().history[0].searchWarnings,1);assert.equal(collector.config.blocked,null);
 }finally{await env.cleanup();}
});
test('停止当前采集保留数据；缺关键词和非法参数拒绝',async()=>{
 const env=setup({runner:async(mode,input,{signal})=>new Promise((ok,no)=>signal.addEventListener('abort',()=>no(new Error('cancelled')),{once:true}))});
 try{const {collector,controller}=env;
 assert.throws(()=>collector.save({...collector.config,intervalMinutes:0}),/invalid/);
 controller.settings.keywords=[];assert.throws(()=>collector.start(),/keywords/);controller.settings.keywords=[{text:'产品经理',enabled:true}];
 collector.start();await new Promise(r=>setImmediate(r));collector.stop();await collector.promise;
 assert.equal(collector.status().history[0].state,'cancelled');assert.equal(collector.status().running,false);
 }finally{await env.cleanup();}
});
test('详情失败持久化重试；三次失败进入待检查而非无限重试',async()=>{
 let now=Date.now();const env=setup({now:()=>now,runner:async mode=>mode==='list'?{ok:true,payload:list}:{ok:false,error:'detail_not_readable'}});
 try{const {collector}=env;for(let i=0;i<3;i++){collector.start();await collector.promise;now+=3600001;}
 assert.equal(collector.status().backlog.find(r=>r.state==='review').count,1);collector.start();await collector.promise;
 assert.equal(collector.status().history[0].detailTotal,0);
 }finally{await env.cleanup();}
});

test('重启保留采集计划和待采队列；遗留运行状态改为中断',async()=>{
 const env=setup();try{
  const {collector,store,controller}=env;collector.save({...collector.config,enabled:true});
  collector.saveRun({id:'interrupted-test',state:'running',startedAt:1});
  const reloaded=new Collector(store,controller,{dataDir:collector.dataDir,browser:async()=>{}});
  assert.equal(reloaded.config.nextRun,collector.config.nextRun);assert.equal(reloaded.config.enabled,true);
  assert.equal(reloaded.status().history[0].state,'interrupted');
 }finally{await env.cleanup();}
});
