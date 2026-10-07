// Standalone acceptance: synthetic DB and model only, own headless Edge; no BOSS access.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {IntakeStore} from '../local/intake.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {WebController} from '../local/web-controller.mjs';
import {CompanyResearch} from '../local/company-research.mjs';
import {Communications} from '../local/communication.mjs';
import {createIntakeServer} from '../local/service.mjs';
import {createWebHandler} from '../local/web-handler.mjs';
import {Cdp} from '../local/boss-cdp.mjs';
import {VERSION} from '../shared/core.js';
const dir=mkdtempSync(join(tmpdir(),'company-ui-')),store=new IntakeStore(join(dir,'test.sqlite')),port=17329,dataset='合成验收',id='boss:synthetic';
const worker=new MatchWorker(store,{facts:{C01:'企业服务产品设计'},target:'产品经理'},{dataDir:dir,runtimeStatus:()=>({available:true}),runner:async(p,jobs)=>({output:{results:jobs.map(j=>({id:j.id,priority:'优先沟通',reason:'合成测试',evidence:[{fact_id:'C01',jd_quote:'企业服务产品设计',relation:'直接经验'}],gaps:[],questions:[],greeting:'',greeting_fact_ids:[],keywords:[]}))}})});
const controller=new WebController(store,worker);controller.resumeInsights={status:()=>({busy:false,keywords:null,score:null})};
store.importPayload({schema_version:2,label:dataset,exported_at:'2026-10-03T00:00:00Z',jobs:[{id,url:'https://www.zhipin.com/job_detail/synthetic.html',title:'合成产品经理',company:'合成公司有限公司',location:'深圳',jd:'企业服务产品设计与需求分析。'.repeat(15),jd_status:'captured_unverified'}]});await worker.step(1);
controller.companyResearch=new CompanyResearch(controller,{dataDir:dir,identityResolver:job=>({state:'platform_verified',full_name:job.company,source_url:job.url,observed_at:new Date().toISOString()}),model:async subject=>({subject,status:'completed',identity_status:'confirmed',generated_at:new Date().toISOString(),disclaimer:'未查到不代表没有风险',research_method:'codex_directed_public_tools',model_calls:3,tool_trace:[{tool:'search',ok:true},{tool:'open',ok:true}],sections:[{topic:'主营业务',statements:[{text:'合成证据 <img src=x onerror=alert(1)>',quote:'合成网页的连续原文',source_id:'S1'}],unknowns:['团队规模待核实']}],sources:[{id:'S1',title:'合成来源',url:'https://example.com/about',accessed_at:new Date().toISOString(),published_at:''}],questions:['实际签约主体？'],warnings:[]})});
controller.communications=new Communications(controller,{dataDir:dir,portFactory:()=>{throw Error('no_browser_allowed');},model:async()=>{throw Error('no_model_allowed');}});
const server=createIntakeServer({worker,token:'a'.repeat(64),port,webHandler:createWebHandler({controller,port})});await new Promise(r=>server.listen(port,'127.0.0.1',r));
const profile=join(dir,'edge');mkdirSync(profile);const executable=process.env.BOSS_TOOLS_EDGE||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});let cdp,session;
const errors=[];
async function evaluate(expression){const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(r.exceptionDetails)throw Error('ui_expression_failed');return r.result.value;}
async function until(expression){for(let i=0;i<80;i++){if(await evaluate(expression))return;await delay(100);}throw Error('ui_wait_failed: '+expression);}
try{
 let debugPort;for(let i=0;i<80&&!debugPort;i++){try{debugPort=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);}catch{/* Edge may still hold its startup file. */}if(!debugPort)await delay(100);}
 assert.ok(debugPort,'Edge debug port unavailable');cdp=await Cdp.connect('http://127.0.0.1:'+debugPort);
 cdp.on('event',e=>{if(e.method==='Runtime.exceptionThrown')errors.push('runtime_exception');});
 const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});session=(await cdp.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;await cdp.send('Runtime.enable',{},session);
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1366,height:900,deviceScaleFactor:1,mobile:false},session);await cdp.send('Page.navigate',{url:`http://127.0.0.1:${port}/`},session);
 await until("document.querySelector('#jobs .job-title')");await evaluate("document.querySelector('#jobs .job-title').click()");await until("document.querySelector('#job-drawer').open");
 assert.equal(await evaluate("document.querySelector('#research-download').disabled"),true);
 await controller.companyResearch.tick();await evaluate('refreshResearch()');await evaluate("showTab('research');document.querySelector('#research-details').open=true");assert.equal(await evaluate("document.querySelectorAll('#research-report img').length"),0);
 assert.match(await evaluate("document.querySelector('#research-report').textContent"),/Codex自主背调 · 3轮模型分析 · 1次搜索 · 1页正文读取/);assert.match(await evaluate("document.querySelector('#research-report').textContent"),/合成证据/);assert.equal(await evaluate("document.querySelector('#research-download').disabled"),false);
 const artifact=resolve('artifacts/company-ui');mkdirSync(artifact,{recursive:true});const capture=await cdp.send('Page.captureScreenshot',{format:'png'},session);writeFileSync(join(artifact,'report-1366.png'),Buffer.from(capture.data,'base64'));
 const exported=await evaluate(`api('company-research/report?'+new URLSearchParams({dataset:${JSON.stringify(dataset)},id:${JSON.stringify(id)}}))`);assert.match(exported.markdown,/公司背调/);
 const denied=await fetch(`http://127.0.0.1:${port}/api/company-research?dataset=test&id=x`);assert.equal(denied.status,403);
 await evaluate("document.querySelector('#close-drawer').click()");
 for(const view of ['tasks','profile','settings','recommend']){await evaluate(`document.querySelector('[data-view="${view}"]').click()`);await until(`!document.querySelector('#view-${view}').hidden`);}
 await evaluate("document.querySelector('[data-view=tasks]').click()");await until("!document.querySelector('#view-tasks').hidden");await evaluate("document.querySelector('#research-task-panel').scrollIntoView();document.querySelector('#research-enabled').click();document.querySelector('#research-save').click()");await until("document.querySelector('#toast').textContent==='背调设置已保存。'");assert.equal(controller.companyResearch.enabled,false);assert.equal(controller.settings.autoAnalyze,false);
 await cdp.send('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false},session);const second=await cdp.send('Page.captureScreenshot',{format:'png'},session);writeFileSync(join(artifact,'settings-1920.png'),Buffer.from(second.data,'base64'));
 assert.equal(await evaluate("document.querySelector('#app-version').textContent"),'v'+VERSION);assert.deepEqual(errors,[]);console.log(JSON.stringify({ui:'passed',views:4,widths:[1366,1920],report:true,export:true,xss:'text only',auth:403,settingsPreserved:true,realModelCalls:0,realHRMessages:0}));
}finally{cdp?.close();browser.kill();await controller.companyResearch.close();await controller.communications.close();await controller.scheduler.close();await new Promise(r=>server.close(r));store.close();}
