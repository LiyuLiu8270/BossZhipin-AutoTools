// Real shipped UI and API, synthetic database, no scheduler and no external messages.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {IntakeStore} from '../local/intake.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {WebController} from '../local/web-controller.mjs';
import {CompanyResearch,companySubject} from '../local/company-research.mjs';
import {Communications} from '../local/communication.mjs';
import {Collector} from '../local/collector.mjs';
import {createIntakeServer} from '../local/service.mjs';
import {createWebHandler} from '../local/web-handler.mjs';
import {Cdp} from '../local/boss-cdp.mjs';
const dir=mkdtempSync(join(tmpdir(),'career-usability-')),port=17330,origin=`http://127.0.0.1:${port}`,dataset='合成验收';
const artifacts=resolve('artifacts/usability-production');mkdirSync(artifacts,{recursive:true});
const store=new IntakeStore(join(dir,'test.sqlite'));
const worker=new MatchWorker(store,{mode:'resume_fulltext',facts:{C01:'企业服务产品设计'},target:'产品经理'},{dataDir:dir,runtimeStatus:()=>({available:true}),runner:async()=>{throw Error('no_model_allowed');}});
const controller=new WebController(store,worker);controller.resumeInsights={status:()=>({busy:false,keywords:null,score:null})};
controller.collector=new Collector(store,controller,{dataDir:dir,browser:async()=>{throw Error('no_boss_allowed');},runner:async()=>{throw Error('no_boss_allowed');}});
store.importPayload({schema_version:2,label:dataset,exported_at:new Date().toISOString(),jobs:Array.from({length:38},(_,i)=>({id:'boss:ux_'+i,url:`https://www.zhipin.com/job_detail/ux_${i}.html`,title:['B端产品经理','SaaS产品经理','AI应用产品经理'][i%3],company:'合成公司'+i+'有限公司',location:'深圳',salary:i%2?'25-35K':'20-30K',jd:'企业服务产品设计、需求分析与跨团队交付。'.repeat(12),jd_status:'captured_unverified'}))});
store.db.prepare("UPDATE intake_jobs SET body=json_set(body,'$.last_seen_at','2026-10-07T01:02:03Z')").run();
const searchFixture=store.db.prepare('SELECT body FROM intake_jobs WHERE dataset=? AND id=?').get(dataset,'boss:ux_0');
const searchJob=JSON.parse(searchFixture.body);searchJob.company_identity={state:'platform_verified',full_name:'深圳市检索验收科技有限公司',source_kind:'job_detail',source_url:searchJob.url};
store.db.prepare('UPDATE intake_jobs SET body=? WHERE dataset=? AND id=?').run(JSON.stringify(searchJob),dataset,'boss:ux_0');
for(const job of store.jobMap().values()){const q=store.db.prepare('SELECT fingerprint FROM intake_analysis_queue WHERE dataset=? AND id=?').get(dataset,job.id);store.db.prepare('INSERT INTO match_runs(dataset,id,fingerprint,profile,state,updated,result) VALUES(?,?,?,?,?,?,?)').run(dataset,job.id,q.fingerprint,worker.profileHash,'completed',Date.now(),JSON.stringify({priority:'优先沟通',reason:'企业服务流程与多方产品交付经验匹配，需核实行业深度。',evidence:[{fact_id:'C01',jd_quote:'企业服务产品设计',relation:'直接经验'}],gaps:['领域深度待核实'],questions:['首期业务范围？']}));}
controller.companyResearch=new CompanyResearch(controller,{dataDir:dir,identityResolver:job=>({state:'platform_verified',full_name:job.company,source_url:job.url,observed_at:new Date().toISOString()}),model:async()=>{throw Error('no_model_allowed');}});
const reportJob=controller.rows(dataset,'boss:ux_1')[0].job,reportSubject=companySubject(reportJob);controller.companyResearch.enqueue(reportSubject);
store.db.prepare("UPDATE company_research SET state='completed',report=? WHERE key=?").run(JSON.stringify({subject:reportSubject,status:'completed',report_format:'codex_markdown',markdown:'# 合成背调\n\n<script>window.reportInjected=true</script>\n\n业务证据需要核实。',sources:[{url:'https://example.com/public',title:'合成公开来源'}],generated_at:new Date().toISOString(),warnings:['软件未独立核验事实。']}),reportSubject.key);
controller.communications=new Communications(controller,{dataDir:dir,portFactory:()=>{throw Error('no_boss_allowed');},model:async()=>{throw Error('no_model_allowed');}});
const key=id=>JSON.stringify([dataset,'boss:ux_'+id]);
controller.communications.save({key:key(1),dataset,job_id:'boss:ux_1',mode:'manual',status:'paused',nextAt:0});controller.communications.event(controller.communications.get(key(1)),'hr_reply');
controller.communications.save({key:key(2),dataset,job_id:'boss:ux_2',mode:'manual',status:'unknown',pending:{kind:'text',text:'合成未知发送'},nextAt:0});
controller.action({dataset,id:'boss:ux_1',contact:'contacted',stage:'contacted',reply:'replied',note:''});
const checks=[],errors=[],external=[],writes=[],researchCalls=[];
const requests=[];let stateDelay=0,stateResponded=false;
const handler=createWebHandler({controller,port});
const server=createIntakeServer({worker,token:'a'.repeat(64),port,webHandler:async(req,res)=>{requests.push({url:req.url,stateResponded});if(req.method==='POST')writes.push(req.url);if(req.url==='/api/state'&&stateDelay){await delay(stateDelay);stateResponded=true;}return handler(req,res);}});await new Promise(r=>server.listen(port,'127.0.0.1',r));
const profile=join(dir,'edge');mkdirSync(profile);
const browser=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
let cdp,session;
async function evaluate(expression){const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
async function until(expr){for(let i=0;i<80;i++){if(await evaluate(expr))return;await delay(100);}throw Error('UI wait failed: '+expr);}
 async function click(s){await until(`document.querySelector(${JSON.stringify(s)}) && !document.querySelector(${JSON.stringify(s)}).disabled`);await evaluate(`document.querySelector(${JSON.stringify(s)}).click()`);}
async function capture(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'},session);writeFileSync(join(artifacts,name+'.png'),Buffer.from(r.data,'base64'));}
try{
 let debugPort;for(let i=0;i<100&&!debugPort;i++){try{debugPort=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);}catch{}if(!debugPort)await delay(100);}
 if(!debugPort)throw Error('isolated_browser_start_timeout');cdp=await Cdp.connect('http://127.0.0.1:'+debugPort);
 const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});session=(await cdp.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;
 cdp.on('event',e=>{if(e.sessionId!==session)return;if(e.method==='Runtime.exceptionThrown')errors.push(e.params.exceptionDetails.exception?.description||e.params.exceptionDetails.text);if(e.method==='Network.requestWillBeSent'&&!e.params.request.url.startsWith(origin+'/'))external.push(e.params.request.url);});
 await cdp.send('Runtime.enable',{},session);await cdp.send('Network.enable',{},session);
 // A slow state response must not serialize the initial list or cause a second
 // state request on direct entry to settings/tasks. No production data involved.
 stateDelay=400;
 for(const view of ['recommend','tasks','settings']){
  requests.length=0;stateResponded=false;await cdp.send('Page.navigate',{url:origin+'/?initial='+view+'#'+view},session);
  await until(`location.search==='?initial=${view}' && document.querySelector('#app-version')?.textContent.startsWith('v')`);
  if(view==='recommend'){await until("document.querySelectorAll('#jobs tr').length>0");assert.ok(requests.some(r=>r.url.startsWith('/api/jobs?')&&!r.stateResponded),'list requested before slow state reply');}
  if(view==='settings')await until("!document.querySelector('#policy-fields').disabled");
  await delay(100);assert.equal(requests.filter(r=>r.url==='/api/state').length,1,view+' only one initial state request');
 }
 stateDelay=0;
 await evaluate("navigate('tasks')");await click('[data-task-tab=analysis]');await click('#toggle-analysis');await until("state.settings.autoAnalyze===true");assert.equal(controller.settings.autoGreeting,false);
 await click('#toggle-greeting');await until("state.settings.autoGreeting===true");assert.equal(controller.settings.autoAnalyze,true);
 await click('#toggle-analysis');await until("state.settings.autoAnalyze===false");assert.equal(controller.settings.autoGreeting,true);
 await click('#toggle-greeting');await until("state.settings.autoGreeting===false");
 await evaluate("navigate('settings')");assert.equal(await evaluate("document.querySelectorAll('#auto-greeting,#auto-analyze').length"),0);
 await evaluate(`openJob(${JSON.stringify(dataset)},'boss:ux_4')`);await click('[data-tab=record]');
 await evaluate("document.querySelector('#action-note').value='手动备注草稿保留';document.querySelector('#action-note').dispatchEvent(new Event('input',{bubbles:true}))");
 const beforeRegenerate=store.db.prepare('SELECT result FROM match_runs WHERE id=?').get('boss:ux_4').result;
 await click('#regenerate-greeting');await until("document.querySelector('#greeting-status').textContent.includes('手动生成队列')");
 worker.greetingRunner=async()=>({output:{greeting:'您好，我有企业服务产品设计的相关经验，希望进一步了解贵公司的业务场景、岗位职责和产品规划，期待有机会交流。',greeting_fact_ids:['C01'],claims:[{text:'有企业服务产品设计的相关经验',fact_id:'C01',quote:'企业服务产品设计'}]}});
 const generated=await worker.nextStep({matching:false,greeting:false});assert.equal(generated.status,'completed');await evaluate('refreshGreeting()');
 assert.match(await evaluate("document.querySelector('#greeting').value"),/企业服务产品设计/);
 assert.equal(await evaluate("document.querySelector('#action-note').value"),'手动备注草稿保留');assert.equal(await evaluate('recordDirty'),true);
 assert.equal(store.db.prepare('SELECT result FROM match_runs WHERE id=?').get('boss:ux_4').result,beforeRegenerate);assert.equal(controller.settings.autoAnalyze,false);assert.equal(controller.settings.autoGreeting,false);
 await evaluate('window.confirm=()=>true');await click('#close-drawer');
 assert.deepEqual(writes,['/api/settings','/api/settings','/api/settings','/api/settings','/api/greeting/regenerate']);
 await evaluate("navigate('tasks');window.confirm=()=>false");
 await click('[data-task-tab=greeting]');
 assert.equal(await evaluate("document.querySelector('#task-bulk-greeting').closest('.view').id"),'view-tasks');
 await click('#bulk-regenerate-greeting');await until("!document.querySelector('#bulk-greeting-fields').disabled");assert.equal(worker.hasRequestedGreeting(),false);
 await evaluate('window.confirm=()=>true');await click('#bulk-regenerate-greeting');await until("document.querySelector('#bulk-greeting-status').textContent.includes('本次已加入')");
 assert.equal(worker.greetingRows().filter(r=>r.state==='requested').length,37);
 assert.equal(controller.settings.autoAnalyze,false);assert.equal(controller.settings.autoGreeting,false);
 assert.equal((await worker.nextStep({matching:false,greeting:false})).status,'completed');
 assert.equal(writes.filter(p=>p==='/api/greeting/bulk-preview').length,2);assert.equal(writes.filter(p=>p==='/api/greeting/bulk-regenerate').length,1);
 const featureWrites=writes.splice(0);
 for(const width of [1366,1920,410]){
  await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===410?750:900,deviceScaleFactor:1,mobile:false},session);await cdp.send('Page.navigate',{url:origin},session);
  await until("document.querySelectorAll('#jobs tr').length>0");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('#jobs .collected-time')).display!=='none'"),true);
  assert.match(await evaluate("document.querySelector('#jobs .collected-time').textContent"),/\d{4}\/\d{1,2}\/\d{1,2}/);
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"),true);
  const rowTop=await evaluate("document.querySelector('#jobs tr').getBoundingClientRect().top");assert.ok(rowTop<(width===410?620:420),String(rowTop));await capture('jobs-'+width);
  await click('[data-quick-view=attention]');await until("document.querySelectorAll('#jobs tr').length===2");await capture('attention-'+width);
  await click('#jobs .job-title');await until("document.querySelector('#job-drawer').open");
  await click('[data-tab=research]');assert.equal(await evaluate("document.querySelector('#tab-match').hidden"),true);assert.equal(await evaluate("document.querySelector('#tab-research').hidden"),false);
  await until("document.querySelector('#research-report').textContent.includes('合成背调')");assert.equal(await evaluate("Boolean(window.reportInjected)"),false);assert.equal(await evaluate("document.querySelector('#research-report script')===null"),true);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await capture('native-report-'+width);
  await click('[data-tab=record]');assert.equal(await evaluate("document.querySelector('.drawer-footer').getBoundingClientRect().bottom<=innerHeight"),true);await capture('drawer-'+width);
  await evaluate("window.confirm=()=>false;document.querySelector('#action-note').value='尚未保存';document.querySelector('#action-note').dispatchEvent(new Event('input',{bubbles:true}))");await click('#close-drawer');assert.equal(await evaluate("document.querySelector('#job-drawer').open"),true);
  await evaluate("window.confirm=()=>true");await click('#close-drawer');await until("!document.querySelector('#job-drawer').open");
  await click('[data-quick-view=all]');await until("document.querySelectorAll('#jobs tr').length===30");await click('#next');await until("document.querySelectorAll('#jobs tr').length===8");
  await evaluate("document.querySelector('#search').value='绝无此岗位';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))");await until("!document.querySelector('#list-empty').hidden");await click('#clear-filters');await until("document.querySelectorAll('#jobs tr').length===30");
  await evaluate("document.querySelector('#search').value='检索验收';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))");await until("document.querySelectorAll('#jobs tr').length===1 && document.querySelector('#jobs').textContent.includes('合成公司0有限公司')");await click('#clear-filters');await until("document.querySelectorAll('#jobs tr').length===30");
  await evaluate("document.querySelector('#salary-filter').value='50plus';document.querySelector('#salary-filter').dispatchEvent(new Event('change',{bubbles:true}))");await until("!document.querySelector('#list-empty').hidden");await click('#clear-filters');await until("document.querySelectorAll('#jobs tr').length===30");
  for(const view of ['tasks','profile','settings']){await click(`[data-view=${view}]`);await until(`!document.querySelector('#view-${view}').hidden`);assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,view+width);await capture(view+'-'+width);}
  await click('[data-view=tasks]');
  const tabs=['collection','analysis','greeting','research','keywords'];
  for(const tab of tabs){
   await click(`[data-task-tab=${tab}]`);
   assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-task-panel]')].filter(n=>!n.hidden).map(n=>n.dataset.taskPanel)"),[tab]);
   assert.equal(await evaluate(`document.querySelector('[data-task-tab=${tab}]').getAttribute('aria-selected')`),'true');
   assert.equal(await evaluate(`document.querySelector('[data-task-panel=${tab}]').checkVisibility()`),true);
   assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await capture('task-tab-'+tab+'-'+width);
  }
  await evaluate("document.querySelector('#keyword-input').value='切换保留草稿'");await click('[data-task-tab=analysis]');await click('[data-task-tab=keywords]');assert.equal(await evaluate("document.querySelector('#keyword-input').value"),'切换保留草稿');
  await evaluate("document.querySelector('[data-task-tab=keywords]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))");assert.equal(await evaluate("document.activeElement.dataset.taskTab"),'collection');
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");assert.equal(await evaluate("document.activeElement.dataset.taskTab"),'analysis');
  await click('[data-view=settings]');await click('#open-task-research');await until("!document.querySelector('[data-task-panel=research]').hidden");
  await click('[data-view=settings]');await click('#open-task-analysis');await until("!document.querySelector('[data-task-panel=analysis]').hidden");
  await click('[data-view=settings]');
  await until("document.querySelector('#daily-limit').value!==''");const limit=await evaluate("document.querySelector('#daily-limit').value");await evaluate("document.querySelector('#daily-limit').value='987';document.querySelector('#daily-limit').dispatchEvent(new Event('input',{bubbles:true}))");
  await click('[data-settings-tab=rules]');await until("!document.querySelector('#policy-fields').disabled");assert.equal(await evaluate("document.querySelector('#settings-draft').hidden"),false);
  await evaluate('window.confirm=()=>false');await click('[data-view=recommend]');assert.equal(await evaluate("document.querySelector('#view-settings').hidden"),false);
  await evaluate('window.confirm=()=>true');await click('[data-view=recommend]');await until("!document.querySelector('#view-recommend').hidden");await click('[data-view=settings]');await until("!document.querySelector('#view-settings').hidden");assert.equal(await evaluate("document.querySelector('#daily-limit').value"),'987');
  await evaluate(`document.querySelector('#daily-limit').value=${JSON.stringify(limit)};runtimeDirty=false;updateDraftNotice()`);
  checks.push({width,rowTop,views:4,filters:true,drawerActionsVisible:true,draftProtection:true});
 }
 assert.deepEqual(writes,[],'read/navigation must not mutate settings or send messages');
 // Saving an older settings draft must preserve switches changed on the task page.
 await click('[data-settings-tab=automation]');
 await evaluate("document.querySelector('#daily-limit').value='876';document.querySelector('#daily-limit').dispatchEvent(new Event('input',{bubbles:true}));window.confirm=()=>true");
 await click('#open-task-analysis');await click('#toggle-analysis');await until('state.settings.autoAnalyze===true');
 await click('[data-view=settings]');assert.equal(await evaluate("document.querySelector('#daily-limit').value"),'876');
 await click('#settings-form [type=submit]');await until('!runtimeDirty');assert.equal(controller.settings.dailyLimit,876);assert.equal(controller.settings.autoAnalyze,true);assert.equal(controller.settings.autoGreeting,false);
 await click('#open-task-analysis');await click('#toggle-analysis');await until('state.settings.autoAnalyze===false');
 const beforeKeywords=JSON.stringify(controller.settings.keywords);
 await evaluate("navigate('profile')");await delay(200);
 await evaluate(`renderInsights({roles:{state:'completed',requires_confirmation:true,version:'resume-insights-v2-semantic',result:{summary:'合成建议',roles:[{keyword:'合成产品经理',fit:'可迁移尝试',reason:'合成经验',evidence:[],gaps:[]}],limitations:[]}},score:{state:'completed',version:'resume-insights-v2-semantic',result:{summary:'综合评价',total:73,score_reason:'整体判断非固定加权',dimensions:[{id:'custom',name:'业务表达',score:82,reason:'合成证据',evidence:[]}],strengths:[],improvements:[],limitations:[]}},dimensions:{}})`);
 assert.equal(JSON.stringify(controller.settings.keywords),beforeKeywords);
 await evaluate("[...document.querySelectorAll('#resume-roles-result button')].find(b=>b.textContent==='加入采集').click()");await until("state.settings.keywords.some(k=>k.text==='合成产品经理')");assert.ok(controller.settings.keywords.some(k=>k.text==='合成产品经理'));
 await evaluate("renderInsights({roles:null,score:{kind:'score',state:'failed',version:'resume-insights-v1',outdated:true,error:'insight_invalid'},dimensions:{}})");assert.match(await evaluate("document.querySelector('#resume-score-result').textContent"),/旧版本的失败记录/);assert.doesNotMatch(await evaluate("document.querySelector('#resume-score-result').textContent"),/未同步关键词/);
 await evaluate("renderCommunication({mode:'managed',status:'paused',error_text:'AI 生成首条招呼时建议本人处理（不代表收到新消息）',handoff_reason:'合成的转人工原因',messages:[],events:[{code:'greeting_handoff',message:'AI 生成首条招呼时建议本人处理（不代表收到新消息）',context:{origin:'model',reason:'合成的转人工原因'},at:new Date().toISOString(),seen:0}]})");assert.match(await evaluate("document.querySelector('#communication-events').textContent"),/原因：合成的转人工原因/);assert.doesNotMatch(await evaluate("document.querySelector('#communication-events').textContent"),/收到需要本人决定/);
 await evaluate("window.confirm=()=>true;navigate('recommend')");await evaluate("selectQuickView('attention')");await evaluate(`openJob(${JSON.stringify(dataset)},'boss:ux_1')`);await click('[data-tab=record]');await click('#chat-ack');await until("document.querySelector('#chat-ack').hidden");assert.equal(controller.list(new URLSearchParams('view=attention')).total,1);
 await click('#close-drawer');await evaluate(`openJob(${JSON.stringify(dataset)},'boss:ux_3')`);await click('#chat-greet');await until("document.querySelector('#communication-status').textContent.includes('等待处理')");assert.equal(controller.communications.get(key(3)).mode,'greet_only');assert.equal(controller.communications.get(key(3)).status,'queued');
 assert.equal(await evaluate("document.querySelector('#tab-record').hidden"),false);await click('#chat-pause');await until("document.querySelector('#communication-status').textContent.includes('人工处理')");assert.equal(controller.communications.get(key(3)).mode,'manual');
 await click('#close-drawer');await evaluate("navigate('tasks')");
 await click('[data-task-tab=research]');
 assert.equal(await evaluate("document.querySelector('#research-task-panel').closest('.view').id"),'view-tasks');
 assert.equal(await evaluate("document.querySelectorAll('#research-concurrency').length"),1);
 await evaluate("document.querySelector('#research-concurrency').value='2';document.querySelector('#research-concurrency').dispatchEvent(new Event('change',{bubbles:true}));window.confirm=()=>false");await click('[data-view=settings]');assert.equal(await evaluate("document.querySelector('#view-tasks').hidden"),false);
 await click('#research-save');await until("!document.querySelector('#research-save').disabled && document.querySelector('#research-draft').hidden");assert.equal(controller.companyResearch.concurrency,2);
 controller.saveSettings({...controller.settings,modelConcurrency:4});
 controller.companyResearch.model=(subject)=>new Promise(resolve=>researchCalls.push({subject,resolve}));controller.companyResearch.start();
 for(let n=0;n<80&&researchCalls.length<2;n++)await delay(25);assert.equal(researchCalls.length,2);
 const researchReport=subject=>({subject,status:'needs_review',generated_at:new Date().toISOString(),identity_status:'uncertain',sections:[],sources:[],questions:[],warnings:[],evidenceCount:0});
 researchCalls[1].resolve(researchReport(researchCalls[1].subject));for(let n=0;n<80&&researchCalls.length<3;n++)await delay(25);assert.equal(researchCalls.length,3,'immediate refill before slow first task finishes');
 await evaluate('refreshState()');assert.match(await evaluate("document.querySelector('#research-capacity').textContent"),/背调在途 2 \/ 2/);
 for(const width of [1366,1920,410]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false},session);await evaluate("document.querySelector('#research-active-tasks').parentElement.open=true;document.querySelector('#research-task-panel').scrollIntoView({block:'start'})");assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);await capture('research-parallel-'+width);}
 await click('#research-toggle');await until("document.querySelector('#research-toggle').textContent==='继续自动背调'");assert.equal(controller.companyResearch.enabled,false);assert.equal(controller.companyResearch.concurrency,2);
 for(const call of researchCalls)call.resolve(researchReport(call.subject));await delay(100);assert.equal(researchCalls.length,3,'pause forbids refill');assert.equal(controller.companyResearch.modelActive,0);
 assert.equal(controller.settings.autoAnalyze,false);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const result={ok:true,checks,writes:[...featureWrites,...writes],taskTabs:{exclusivePanels:true,keyboard:true,draftsPreserved:true,settingsLinks:true,settingsSavePreservesTaskSwitches:true},independentGreeting:{switches:true,manualRegenerate:true,matchPreserved:true,noteDraftPreserved:true},initialLoad:{parallelList:true,singleStateOnTasksAndSettings:true},researchParallel:{limit:2,observedActive:2,immediateRefill:true,pausedWithoutRefill:true,taskMenu:true},realModelCalls:0,realHRMessages:0,externalRequests:external.length,errors};writeFileSync(join(artifacts,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(e){console.error(JSON.stringify({errors,ui:session?await evaluate("({toast:document.querySelector('#toast')?.textContent,error:document.querySelector('#global-error')?.textContent})").catch(()=>null):null}));if(session)await capture('failure').catch(()=>{});throw e;}
finally{cdp?.close();browser.kill();controller.companyResearch.stop();controller.modelQueue.stop();for(const c of researchCalls)c.resolve({status:'needs_review',subject:c.subject});await controller.collector.close();await controller.companyResearch.close();await controller.communications.close();await controller.scheduler.close();await controller.modelQueue.close();await new Promise(r=>server.close(r));store.close();}
