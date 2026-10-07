// Isolated browser acceptance. Static synthetic prototypes only, never production.
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Cdp} from '../local/boss-cdp.mjs';
const origin='http://127.0.0.1:17461',dir=mkdtempSync(join(tmpdir(),'xunxu-ux-')),profile=join(dir,'edge');mkdirSync(profile);
const artifacts=resolve('artifacts/usability-prototypes');mkdirSync(artifacts,{recursive:true});
const child=spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
let cdp,session;const errors=[],external=[],checks=[];
async function evaluate(expression){const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(r.exceptionDetails)throw Error(r.exceptionDetails.text+': '+r.exceptionDetails.exception?.description);return r.result.value;}
async function until(expr){for(let i=0;i<60;i++){if(await evaluate(expr))return;await delay(100);}throw Error('UI wait failed: '+expr);}
async function click(selector){await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);}
async function screenshot(name){const r=await cdp.send('Page.captureScreenshot',{format:'png'},session);writeFileSync(join(artifacts,name+'.png'),Buffer.from(r.data,'base64'));}
async function load(v,width){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:width===410?650:900,deviceScaleFactor:1,mobile:false},session);await cdp.send('Page.navigate',{url:origin+'/?v='+v},session);await until("document.querySelector('.job-row')");}
try{
 for(let i=0;i<80&&!existsSync(join(profile,'DevToolsActivePort'));i++)await delay(100);
 const port=Number(readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);cdp=await Cdp.connect('http://127.0.0.1:'+port);
 const {targetId}=await cdp.send('Target.createTarget',{url:'about:blank'});session=(await cdp.send('Target.attachToTarget',{targetId,flatten:true})).sessionId;
 cdp.on('event',e=>{if(e.sessionId!==session)return;if(e.method==='Runtime.exceptionThrown')errors.push(e.params.exceptionDetails.text);if(e.method==='Network.requestWillBeSent'&&!e.params.request.url.startsWith(origin+'/'))external.push(e.params.request.url);});
 await cdp.send('Runtime.enable',{},session);await cdp.send('Network.enable',{},session);
 for(const variant of ['a','b','c'])for(const width of [1366,1920,410]){
  await load(variant,width);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,`${variant}/${width} overflow`);
  const firstRow=await evaluate("document.querySelector('.job-row').getBoundingClientRect().top");assert.ok(firstRow<400,`${variant}/${width} first row ${firstRow}`);
  if(variant==='c'&&width>800)assert.equal(await evaluate("document.querySelector('.reading-pane .detail-bottom').getBoundingClientRect().bottom<=innerHeight"),true,'C actions below viewport');
  await screenshot(`${variant}-${width}-jobs`);
  await click('[data-page="tasks"]');await until("document.querySelector('[data-action=mock-login]')");
  await click('[data-action="mock-login"]');assert.equal(await evaluate("Boolean(document.querySelector('.notice'))"),false);
  await click('[data-action="research-toggle"]');assert.match(await evaluate("document.querySelector('.task-list').textContent"),/已暂停后续背调/);
  await click('[data-action="research-toggle"]');
  await click('[data-page="profile"]');await click('[data-action="update-resume"]');assert.equal(await evaluate("document.querySelector('#resume-update').open"),true);await click('[data-action="use-example"]');assert.match(await evaluate("document.querySelector('.simple-sheet').textContent"),/v2/);
  await click('[data-page="settings"]');await click('[data-settings="rules"]');
  await evaluate("document.querySelector('#style').value='简洁直接';document.querySelector('#style').dispatchEvent(new Event('change',{bubbles:true}))");
  await click('[data-page="jobs"]');assert.equal(await evaluate("document.querySelector('#dirty-warning').hidden"),false);
  await click('[data-action="save-settings"]');await click('[data-settings="preferences"]');await click('[data-settings="rules"]');assert.equal(await evaluate("document.querySelector('#style').value"),'简洁直接');await click('[data-page="jobs"]');
  await click('[data-view="recommended"]');await click('[data-action="filter"]');
  await evaluate("document.querySelector('#salary').value='30';document.querySelector('#activity').value='week'");await click('#apply-filters');
  assert.match(await evaluate("document.querySelector('#chips').textContent"),/30K/);assert.equal(await evaluate("document.querySelectorAll('.job-row').length"),3);
  await evaluate("document.querySelector('#search').value='不存在的职位';document.querySelector('#search').dispatchEvent(new Event('input',{bubbles:true}))");assert.equal(await evaluate("Boolean(document.querySelector('.empty'))"),true);
  await click('[data-action="reset-filter"]');await click('[data-view="recommended"]');await click('[data-open="1"]');
  const scope=variant==='c'&&width>800?'.reading-pane':'#drawer';
  if(scope==='#drawer')assert.equal(await evaluate("document.querySelector('#drawer').open"),true);
  await click(scope+' [data-detail="research"]');assert.match(await evaluate(`document.querySelector('${scope} .detail-body').textContent`),/虚构演示/);await screenshot(`${variant}-${width}-research`);
  await click(scope+' [data-action="greet"]');assert.match(await evaluate(`document.querySelector('${scope}').textContent`),/待HR回复/);
  assert.match(await evaluate(`document.querySelector('${scope} h2').textContent`),/B端产品经理/);
  await click(scope+' [data-action="mock-reply"]');await click(scope+' [data-action="takeover"]');
  await evaluate(`document.querySelector('${scope} #reply').value='这是一条本地模拟回复'`);await click(scope+' [data-action="send-reply"]');assert.match(await evaluate(`document.querySelector('${scope}').textContent`),/这是一条本地模拟回复/);
  if(scope==='#drawer')await click('#drawer [data-action="close"]');
  await click('[data-view="attention"]');await click('[data-open="7"]');await click(scope+' [data-action="reconcile"]');assert.match(await evaluate(`document.querySelector('${scope}').textContent`),/待HR回复/);
  if(scope==='#drawer')await click('#drawer [data-action="close"]');
  await click('[data-view="recommended"]');await click('[data-open="2"]');await click(scope+' [data-action="manage"]');assert.match(await evaluate(`document.querySelector('${scope}').textContent`),/AI沟通中/);await click(scope+' [data-action="takeover"]');assert.match(await evaluate(`document.querySelector('${scope}').textContent`),/由我跟进/);
  checks.push({variant,width,firstRowY:Math.round(firstRow),views:4,flows:'filter, report, greeting, HR reply, takeover, reconciliation, task recovery, settings guard'});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 const report={ok:true,checks,runtimeErrors:errors,externalRequests:external,productionRequests:0,realHRMessages:0};writeFileSync(join(artifacts,'acceptance.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(cdp){await cdp.send('Browser.close').catch(()=>{});cdp.close();}else child.kill();}
