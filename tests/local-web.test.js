import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {IntakeStore} from '../local/intake.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {WebController} from '../local/web-controller.mjs';
import {createWebHandler} from '../local/web-handler.mjs';
import {createIntakeServer} from '../local/service.mjs';
import {applyActivityCapture} from '../shared/activity.js';
import {Collector} from '../local/collector.mjs';
const profile={source:'合成测试',target:'产品经理',facts:{C01:'企业服务需求调研'},boundaries:['不编造']};
const capture=(title='产品经理',label='合成测试',at='2026-09-30T01:00:00Z')=>({schema_version:2,label,exported_at:at,jobs:[{id:'boss:test_one',url:'https://www.zhipin.com/job_detail/test_one.html',title,company:'',hiring_party:{type:'headhunter',evidence:[]},jd:'负责企业服务需求调研和产品设计，梳理复杂流程并推动研发交付。任职要求：有产品经理经验，能够独立完成业务分析。'.repeat(5),jd_status:'captured_unverified',contact_status:'unknown'}]});
const runner=async(p,jobs)=>({output:{results:jobs.map(j=>({id:j.id,priority:'可以尝试',reason:'有直接经验',evidence:[{fact_id:'C01',jd_quote:'企业服务需求调研',relation:'直接经验'}],gaps:['待核实'],questions:['业务方向？'],greeting:'',greeting_fact_ids:[],keywords:['B端产品经理']}))}});
function setup(){const dataDir=mkdtempSync(join(tmpdir(),'career-web-test-')),store=new IntakeStore(join(dataDir,'jobs.sqlite')),worker=new MatchWorker(store,profile,{dataDir,runner});return {store,worker,controller:new WebController(store,worker),dataDir};}

test('推荐概览按数据集统计，不受其他筛选和分页影响，建议分组与当前结果一致',async()=>{
 const {store,controller,worker}=setup();try{
  const input=capture(),priorities=['优先沟通','可以尝试','低优先级','不匹配'];
  input.jobs=Array.from({length:35},(_,i)=>({...input.jobs[0],id:'boss:summary_'+i,url:'https://www.zhipin.com/job_detail/summary_'+i+'.html',...(i===34?{jd:'',jd_status:'missing'}:{})}));
  store.importPayload(input);store.importPayload(capture('另一个产品岗位','另一数据集'));
  for(let i=0;i<4;i++){
   const id=input.jobs[i].id,q=store.db.prepare('SELECT fingerprint FROM intake_analysis_queue WHERE dataset=? AND id=?').get(input.label,id);
   store.db.prepare('INSERT INTO match_runs(dataset,id,fingerprint,profile,state,updated,result) VALUES(?,?,?,?,?,?,?)').run(input.label,id,q.fingerprint,worker.profileHash,'completed',Date.now(),JSON.stringify({priority:priorities[i]}));
  }
  controller.action({dataset:input.label,id:input.jobs[0].id,stage:'contacted',contact:'contacted',reply:'waiting',note:''});
  controller.action({dataset:input.label,id:input.jobs[1].id,stage:'contacted',contact:'contacted',note:''});
  const before=JSON.stringify(worker.status()),hash=worker.profileHash;
  const expected={total:35,overview:{total:35,collected:34,terminal:0,awaiting:1,closed:0,unavailable:0},details:34,detailCounts:{total:35,captured:34,missing:1,pending:0,waiting_retry:0,review:0,closed:0,unavailable:0,unqueued:1,nextRetryAt:null},closed:0,priorities:{'优先沟通':1,'可以尝试':1,'低优先级':1,'不匹配':1,pending:31},contacted:2,waiting:1};
  for(const filters of [{},{page:'2'},{q:'无结果'},{reply:'waiting'},{detail:'ready'},{salary:'50plus',activity:'within:7'}]){
   assert.deepEqual(controller.list(new URLSearchParams({dataset:input.label,...filters})).summary,expected);
  }
  assert.equal(controller.list(new URLSearchParams({dataset:input.label,page:'2'})).items.length,5);
  for(const p of priorities)assert.equal(controller.list(new URLSearchParams({dataset:input.label,priority:p})).total,expected.priorities[p]);
  for(const [key,value,count] of [['priority','pending',31],['detail','ready',34],['detail','missing',1],['contact','contacted',2],['reply','waiting',1],['reply','unknown',1]]){
   assert.equal(controller.list(new URLSearchParams({dataset:input.label,[key]:value})).total,count);
  }
  assert.equal(controller.list().summary.total,36);
  assert.equal(controller.list(new URLSearchParams({dataset:'不存在'})).summary.total,0);
  assert.equal(JSON.stringify(worker.status()),before);assert.equal(worker.profileHash,hash);
  controller.saveProfile({...profile,target:'变更目标'});
  const changed=controller.list(new URLSearchParams({dataset:input.label})).summary;
  assert.equal(changed.priorities.pending,35);assert.equal(changed.contacted,2);assert.equal(changed.waiting,1);
 }finally{store.close();}
});

test('岗位关闭筛选独立于正文采集，推荐与可执行队列用同一口径',()=>{
 const {store,controller,dataDir}=setup();const collector=new Collector(store,controller,{dataDir,browser:async()=>{}});
 try{
  const input=capture(),base=input.jobs[0],closed={availability:{value:'explicit_unavailable',raw:['该职位已关闭']}};
  input.jobs=['stored_closed','closed','unavailable','waiting','ready'].map(id=>({...base,id:'boss:'+id,url:`https://www.zhipin.com/job_detail/${id}.html`,...(id==='stored_closed'?{}:{jd:'',jd_status:'missing'}),...(['stored_closed','closed'].includes(id)?{recruitment_signals:closed}:{}),...(id==='unavailable'?{link_access:{state:'unavailable'}}:{})}));
  store.importPayload(input);collector.config.dataset=input.label;
  for(const id of ['waiting','ready'])store.db.prepare("INSERT INTO collection_details(dataset,id,body,state,retry_at) VALUES(?,?,?,'pending',?)").run(input.label,'boss:'+id,'{}',id==='waiting'?Date.now()+3600000:0);
  const summary=controller.list(new URLSearchParams({dataset:input.label})).summary;
  assert.deepEqual(summary.detailCounts,collector.status().detailSummary);assert.equal(summary.closed,2);assert.equal(summary.details,1);assert.equal(summary.detailCounts.missing,4);
  assert.deepEqual(summary.overview,{total:5,collected:0,terminal:3,awaiting:2,closed:2,unavailable:1});
  assert.equal(controller.list(new URLSearchParams({dataset:input.label,availability:'terminal'})).total,3);assert.equal(controller.list(new URLSearchParams({dataset:input.label,detail:'unfinished'})).total,2);
  assert.equal(controller.list(new URLSearchParams({dataset:input.label,detail:'ready',availability:'unknown'})).total,summary.overview.collected);
  for(const [key,value,count] of [['availability','closed',2],['availability','unavailable',1],['detail','ready',1],['detail','pending',1],['detail','waiting_retry',1],['detail','missing',4]])assert.equal(controller.list(new URLSearchParams({dataset:input.label,[key]:value})).total,count);
  const r=controller.detail(input.label,'boss:stored_closed');assert.equal(r.job_state,'closed');assert.equal(r.detail_state,'captured');
 }finally{store.close();}
});

test('回复状态人工保存、旧记录未知、非法请求不写入、重复采集和重启保留且数据集隔离',()=>{
 const {store,controller,worker}=setup();try{
  const input=capture(),value={dataset:input.label,id:input.jobs[0].id,stage:'contacted',contact:'contacted',note:'人工记录'};
  store.importPayload(input);store.importPayload(capture('另一个产品岗位','另一数据集'));
  // Simulate pre-upgrade contact rows: absence of reply evidence must remain unknown.
  worker.contact(value.dataset,value.id,'contacted');
  assert.equal(controller.detail(value.dataset,value.id).reply_status,'unknown');
  assert.equal(controller.list().summary.waiting,0);
  for(const reply of ['waiting','replied','closed','unknown']){
   controller.action({...value,reply});
   assert.equal(controller.detail(value.dataset,value.id).reply_status,reply);
   assert.equal(controller.list(new URLSearchParams({reply})).total,1);
   assert.equal(controller.list().summary.waiting,reply==='waiting'?1:0);
  }
  controller.action({...value,reply:'replied'});controller.action({...value,note:'兼容未传回复的旧调用'});
  assert.equal(controller.detail(value.dataset,value.id).reply_status,'replied');
  for(const reply of ['fake',null,{},1])assert.throws(()=>controller.action({...value,reply}),/invalid_action/);
  assert.throws(()=>controller.action({...value,stage:'new',contact:'unknown',reply:'waiting',note:'不应保存'}),/contact_reply_conflict/);
  assert.equal(controller.detail(value.dataset,value.id).reply_status,'replied');
  assert.equal(controller.detail(value.dataset,value.id).note,'兼容未传回复的旧调用');
  store.importPayload(capture('采集更新的产品岗位',input.label,'2026-10-01T02:00:00Z'));
  const restarted=new WebController(store,worker);
  assert.equal(restarted.detail(value.dataset,value.id).reply_status,'replied');
  assert.equal(restarted.detail('另一数据集',value.id).reply_status,'unknown');
  restarted.action({...value,stage:'new',contact:'not_contacted'});
  assert.equal(restarted.detail(value.dataset,value.id).reply_status,'unknown');
  assert.equal(restarted.list(new URLSearchParams({reply:'unknown'})).total,0);
  restarted.action(value);assert.equal(restarted.detail(value.dataset,value.id).reply_status,'unknown');
 }finally{store.close();}
});

test('补采结果同步后网页计数、列表、抽屉同步更新，匹配结果保留',async()=>{
 const {store,controller,worker}=setup();try{
  const input=capture();store.importPayload(input);await worker.step();
  assert.deepEqual(controller.state().activityCollection,{unknown:1,pending:1,review:0,notDisplayed:0,found:0});
  const j=store.get(input.label,input.jobs[0].id),d={jobs:{[j.id]:j}};
  const c={status:'captured',source_url:j.url,jobs:[{url:j.url,recruitment_signals:{recruiter_activity:[{text:'本周活跃',selector:'.boss-info span'}]}}]};
  const saved=applyActivityCapture(d,c,j.id,'2026-09-30T02:00:00Z').dataset.jobs[j.id];
  store.importPayload({...input,exported_at:'2026-09-30T02:00:00Z',jobs:[saved]});
  assert.deepEqual(controller.state().activityCollection,{unknown:0,pending:0,review:0,notDisplayed:0,found:1});
  assert.equal(controller.list().items[0].activity_display.raw[0],'本周活跃');
  assert.equal(controller.detail(input.label,j.id).activity_display.observed_at,'2026-09-30T02:00:00Z');
  assert.equal(controller.detail(input.label,j.id).result.priority,'可以尝试');
  assert.equal((await worker.step()).status,'idle');
 }finally{store.close();}
});
test('累计活跃筛选先于分页，包含关系与其他条件组合且不改变队列',()=>{
 const {store,controller,worker}=setup();try{
  const input=capture(),labels=['在线','今日活跃','3日内活跃','本周活跃','2周内活跃','本月活跃','半年前活跃'];
  input.jobs=Array.from({length:70},(_,i)=>({...input.jobs[0],id:'boss:active_'+i,url:'https://www.zhipin.com/job_detail/active_'+i+'.html',recruitment_signals:{checked_at:input.exported_at,page_type:'detail',recruiter_activity:{raw:[labels[Math.floor(i/10)]]}}}));store.importPayload(input);
  const before=JSON.stringify(worker.status()),hash=worker.profileHash;
  const week=controller.list(new URLSearchParams({activity:'within:7'}));assert.equal(week.total,40);assert.equal(week.pages,2);assert.equal(week.items.length,30);
  assert.equal(controller.list(new URLSearchParams({activity:'within:7',page:'2'})).items.length,10);
  assert.equal(controller.list(new URLSearchParams({activity:'within:31'})).total,60);
  assert.equal(controller.list(new URLSearchParams({activity:'within:31',dataset:'不存在'})).total,0);
  assert.ok(controller.state().activityFilterOptions.some(([value,label])=>value==='within:7'&&label==='本周及更近期'));
  assert.equal(worker.profileHash,hash);assert.equal(JSON.stringify(worker.status()),before);
 }finally{store.close();}
});

test('薪资与其他筛选组合，先筛选再分页，不修改原始薪资',()=>{
 const {store,controller}=setup();try{
  const input=capture();input.jobs=Array.from({length:66},(_,i)=>({...input.jobs[0],id:'boss:salary_'+i,url:'https://www.zhipin.com/job_detail/salary_'+i+'.html',salary:i<35?'15-25K·13薪':i<65?'5-9K':'面议'}));store.importPayload(input);
  const query=new URLSearchParams({salary:'20-30',q:'产品经理',dataset:'合成测试',page:'2'});
  const r=controller.list(query);assert.equal(r.total,35);assert.equal(r.pages,2);assert.equal(r.items.length,5);assert.ok(r.items.every(j=>j.salary==='15-25K·13薪'));
  assert.equal(controller.list(new URLSearchParams({salary:'unknown'})).total,1);
  assert.equal(controller.list(new URLSearchParams({salary:'50plus'})).total,0);
  assert.equal(controller.list().total,66);
  assert.equal(controller.list(new URLSearchParams({salary:'20-30',activity:'state:unknown'})).total,35);
  assert.equal(controller.list(new URLSearchParams({activity:'label:在线'})).total,0);
 }finally{store.close();}
});

test('网页列表、过滤、抽屉和跨数据集隔离；默认不运行模型',async()=>{
 const {store,controller,worker}=setup();try{
  store.importPayload(capture());store.importPayload(capture('SaaS产品经理','其他数据集'));
  assert.equal(controller.list().total,2);assert.equal((await controller.tick()).status,'paused');assert.equal(worker.status().daily_used,0);
  controller.saveSettings({...controller.settings,autoAnalyze:true});await controller.tick();
  assert.equal(controller.list(new URLSearchParams({priority:'可以尝试',dataset:'其他数据集'})).total,1);
  assert.equal(controller.list(new URLSearchParams({q:'没有'})).total,0);
  assert.equal(controller.detail('合成测试','boss:test_one').result.priority,'可以尝试');
  assert.equal(controller.detail('合成测试','boss:test_one').job.hiring_party.type,'headhunter');
  assert.throws(()=>controller.detail('不存在','boss:test_one'),/job_not_found/);
 }finally{store.close();}
});
test('人工沟通记录持久化，新增采集不能覆盖；不同数据集不串记录',()=>{
 const {store,controller,worker}=setup();try{
  store.importPayload(capture());store.importPayload(capture('产品经理','另一个'));
  controller.action({dataset:'合成测试',id:'boss:test_one',stage:'contacted',contact:'contacted',note:'已沟通'});
  store.importPayload(capture('新的岗位名称','合成测试','2026-09-30T02:00:00Z'));
  const restored=new WebController(store,worker);assert.equal(restored.detail('合成测试','boss:test_one').contact_status,'contacted');
  assert.equal(restored.detail('另一个','boss:test_one').contact_status,'unknown');
  assert.equal(restored.list(new URLSearchParams({contact:'contacted'})).total,1);
  assert.throws(()=>controller.action({dataset:'合成测试',id:'boss:test_one',stage:'followup',contact:'unknown',note:''}),/contact_stage_conflict/);
 }finally{store.close();}
});
test('资料变更清除旧结果；相同资料不重复重评；设置和关键词持久化及校验',async()=>{
 const {store,controller,worker}=setup();try{
  store.importPayload(capture());await worker.step();const old=worker.profileHash;
  controller.saveProfile(profile);assert.equal(worker.profileHash,old);assert.equal(controller.state().recommended,1);
  controller.saveProfile({...profile,target:'SaaS产品经理'});assert.notEqual(worker.profileHash,old);assert.equal(controller.state().recommended,0);
  controller.busy=true;assert.throws(()=>controller.saveProfile(profile),/analysis_busy/);controller.busy=false;
  controller.saveSettings({autoAnalyze:false,dailyLimit:99,keywords:[{text:' 产品经理 ',enabled:true},{text:'产品经理',enabled:false}]});
  assert.equal(controller.settings.keywords.length,1);assert.equal(worker.dailyLimit,99);
  const next=new WebController(store,worker);assert.equal(next.settings.dailyLimit,99);assert.equal(next.worker.profile.target,'SaaS产品经理');
  for(const value of [5001,999999]){controller.saveSettings({...controller.settings,dailyLimit:value});assert.equal(new WebController(store,worker).settings.dailyLimit,value);assert.equal(worker.dailyLimit,value);assert.equal(controller.settings.autoAnalyze,false);}
  for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>controller.saveSettings({...controller.settings,dailyLimit:value}),/invalid_settings/);
  assert.throws(()=>controller.saveProfile({...profile,facts:{C01:'',fake:'a'}}),/invalid_profile/);
 }finally{store.close();}
});
test('HTTP 页面、同源鉴权、CSRF 拒绝、导入、XSS 数据和退役扩展接口拒绝',async()=>{
 const {store,worker,controller}=setup(),token='b'.repeat(64);
 const server=createIntakeServer({store,worker,token});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 // Test the production handler through a dynamically allocated loopback port.
 const port=server.address().port;server.removeAllListeners('request');
 const app=createIntakeServer({store,worker,token,port,webHandler:createWebHandler({controller,token,port})});
 server.on('request',app.listeners('request')[0]);const base=`http://127.0.0.1:${port}`;
 try{
  const root=await fetch(base);assert.equal(root.status,200);assert.match(await root.text(),/岗位推荐/);
  const cookie=root.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,'X-Local-UI':'1',Origin:base,'Content-Type':'application/json'};
  assert.match(root.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(base+'/api/state')).status,403);
  assert.equal((await fetch(base+'/api/state',{headers})).status,200);
  assert.equal((await fetch(base+'/api/matching-policy')).status,403);
  const policyUrl=base+'/api/matching-policy';
  assert.deepEqual((await(await fetch(policyUrl,{headers})).json()).policy,{matchingSkill:'',greetingStyle:''});
  assert.equal((await fetch(policyUrl,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
  const badPolicy=await fetch(policyUrl,{method:'POST',headers,body:JSON.stringify({matchingSkill:5})});assert.equal(badPolicy.status,400);assert.equal((await badPolicy.json()).error,'invalid_matching_policy');
  const customPolicy={matchingSkill:'<script>untrusted example</script>',greetingStyle:'自然真诚'};
  assert.equal((await fetch(policyUrl,{method:'POST',headers,body:JSON.stringify(customPolicy)})).status,200);
  assert.deepEqual((await(await fetch(policyUrl,{headers})).json()).policy,customPolicy);
  await fetch(policyUrl,{method:'POST',headers,body:'{}'});
  const oldProfileHash=worker.profileHash,oldProfile=JSON.stringify(worker.profile);
  assert.equal((await fetch(base+'/api/profile/resume')).status,403);
  assert.equal((await (await fetch(base+'/api/profile/resume',{headers})).json()).document,null);
  assert.equal((await fetch(base+'/api/profile/resume/original',{headers})).status,404);
  controller.resumeDocuments.parser=async()=>({text:'完整原文 <script> 不作为HTML执行',blocks:[{id:'B0001',type:'paragraph',source:'body',text:'完整原文 <script> 不作为HTML执行'}],warnings:[],stats:{characters:25,paragraphs:1,tables:0,images:0}});
  const resumeInput={filename:'合成简历.docx',base64:Buffer.from('synthetic-docx').toString('base64')};
  assert.equal((await fetch(base+'/api/profile/resume',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify(resumeInput)})).status,403);
  const importedResume=await fetch(base+'/api/profile/resume',{method:'POST',headers,body:JSON.stringify(resumeInput)});
  assert.equal(importedResume.status,200);assert.equal((await importedResume.json()).document.matching_connected,false);
  const original=await fetch(base+'/api/profile/resume/original',{headers});assert.equal(original.status,200);assert.match(original.headers.get('content-disposition'),/attachment/);assert.equal(await original.text(),'synthetic-docx');
  assert.equal(worker.profileHash,oldProfileHash);assert.equal(JSON.stringify(worker.profile),oldProfile);
  assert.equal((await fetch(base+'/api/profile/resume',{method:'POST',headers,body:JSON.stringify({...resumeInput,filename:'old.doc'})})).status,400);
  for(const Origin of ['https://evil.example','null','http://localhost:'+port])assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:{...headers,Origin},body:'{}'})).status,403);
  const withoutOrigin={...headers};delete withoutOrigin.Origin;assert.equal((await fetch(base+'/api/settings',{method:'POST',headers:withoutOrigin,body:'{}'})).status,403);
  const beforeRetiredUpload=store.stats();
  for(const body of ['{bad',JSON.stringify(capture('<img src=x onerror=alert(1)>'))])
    assert.equal((await fetch(base+'/api/import',{method:'POST',headers,body})).status,404);
  assert.deepEqual(store.stats(),beforeRetiredUpload);
  // Internal collector/storage normalization remains; only the user-facing upload is retired.
  store.importPayload(capture('<img src=x onerror=alert(1)>'));
  const list=await (await fetch(base+'/api/jobs',{headers})).json();assert.equal(list.total,1);assert.equal(list.items[0].title,'<img src=x onerror=alert(1)>');
  assert.equal(list.summary.total,1);assert.equal(list.summary.details,1);assert.equal(list.summary.waiting,0);
  const record={dataset:capture().label,id:'boss:test_one',stage:'contacted',contact:'contacted',reply:'waiting',note:'合成记录'};
  assert.equal((await fetch(base+'/api/action',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify(record)})).status,403);
  assert.equal((await fetch(base+'/api/action',{method:'POST',headers,body:JSON.stringify(record)})).status,200);
  const waiting=await(await fetch(base+'/api/jobs?reply=waiting',{headers})).json();assert.equal(waiting.total,1);assert.equal(waiting.summary.waiting,1);assert.equal(waiting.items[0].reply_status,'waiting');
  const conflict=await fetch(base+'/api/action',{method:'POST',headers,body:JSON.stringify({...record,stage:'new',contact:'unknown'})});assert.equal(conflict.status,400);assert.equal((await conflict.json()).error,'contact_reply_conflict');
  assert.equal((await fetch(base+'/candidate.json',{headers})).status,403);
  const script=await (await fetch(base+'/app.js')).text();assert.doesNotMatch(script,/innerHTML|insertAdjacentHTML|eval\(/);
  assert.equal((await fetch(base+'/api/pairing',{method:'POST',headers,body:'{}'})).status,404);
  const claimed=worker.claim(1);assert.equal(claimed.rows.length,1);
  store.db.prepare("UPDATE match_runs SET state='retry',error='codex_turn_failed',retry_at=? WHERE lease=?").run(Date.now()+3600000,claimed.lease);
  assert.equal((await fetch(base+'/api/retry',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
  controller.busy=true;assert.equal((await fetch(base+'/api/retry',{method:'POST',headers,body:'{}'})).status,409);controller.busy=false;
  const requeued=await fetch(base+'/api/retry',{method:'POST',headers,body:'{}'});assert.equal(requeued.status,200);assert.deepEqual((await requeued.json()).requeued,{matching:1,greeting:0,total:1});
  const afterRetry=await(await fetch(base+'/api/state',{headers})).json();assert.equal(afterRetry.status.states.find(s=>s.state==='pending').count,1);assert.equal(afterRetry.status.states.some(s=>s.state==='retry'),false);assert.equal(afterRetry.settings.autoAnalyze,false);
  assert.equal((await(await fetch(base+'/api/retry',{method:'POST',headers,body:'{}'})).json()).requeued.total,0);
  controller.collector=new Collector(store,controller,{dataDir:controller.worker.dataDir,browser:async()=>{},runner:async()=>({ok:true,payload:{jobs:[]}})});
  const post=async(path,body)=>fetch(base+'/api/collection/'+path,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await post('start',{})).status,400); // empty keyword list
  controller.saveSettings({...controller.settings,keywords:[{text:'产品经理',enabled:true}]});
  assert.equal((await post('settings',{...controller.collector.config,enabled:true})).status,200);
  assert.equal((await fetch(base+'/api/collection/start',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await post('start',{})).status,200);await controller.collector.promise;
  assert.equal(controller.state().collection.history[0].state,'completed');
  assert.equal((await post('stop',{})).status,200);
  assert.equal((await post('resume',{id:'stale'})).status,400);
  const paused=controller.collector.status().history[0];controller.collector.saveRun({...paused,state:'needs_attention',error:'login_required'});
  assert.equal((await fetch(base+'/api/collection/resume',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify({id:paused.id})})).status,403);
  assert.equal((await post('resume',{id:paused.id})).status,200);await controller.collector.promise;
  assert.equal(controller.collector.status().history[0].state,'completed');
  assert.equal((await post('retry-search',{id:paused.id})).status,400);
  assert.equal((await fetch(base+'/api/collection/details',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await post('details',{})).status,200);await controller.collector.promise;
  assert.equal(controller.collector.latest().trigger,'details');
  controller.collector.budget.reserve(controller.collector.config.dailyDetailLimit);
  assert.equal((await post('settings',{...controller.collector.config,dailyDetailLimit:1})).status,200);
  const limited=await post('details',{});assert.equal(limited.status,400);assert.equal((await limited.json()).error,'detail_daily_limit');
  let openCalls=0;controller.jobOpener={open:async value=>{openCalls++;assert.deepEqual(value,{dataset:'合成测试',id:'boss:test_one'});return {ok:true,opened:true,page_state:'detail_visible',jd_characters:100};}};
  assert.equal((await fetch(base+'/api/job/open',{headers})).status,404);
  assert.equal((await fetch(base+'/api/job/open',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'})).status,403);assert.equal(openCalls,0);
  const opened=await fetch(base+'/api/job/open',{method:'POST',headers,body:JSON.stringify({dataset:'合成测试',id:'boss:test_one'})});assert.equal(opened.status,200);assert.equal((await opened.json()).page_state,'detail_visible');assert.equal(openCalls,1);
  assert.equal((await fetch(base+'/health',{headers:{'X-Collector-Token':token,Origin:'chrome-extension://'+'a'.repeat(32)}})).status,403);
  const wrongHost=await new Promise((ok,fail)=>{const req=request(base+'/api/profile',{headers:{Cookie:cookie,'X-Local-UI':'1',Host:'evil.example'}},res=>{res.resume();ok(res.statusCode);});req.on('error',fail);req.end();});assert.equal(wrongHost,403);
 }finally{await new Promise(r=>server.close(r));store.close();}
});
