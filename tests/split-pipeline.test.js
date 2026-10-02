import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IntakeStore} from '../local/intake.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {WebController} from '../local/web-controller.mjs';
import {MatchScheduler} from '../local/match-scheduler.mjs';
import {validateGreeting,greetingPrompt} from '../local/greeting-runner.mjs';
import {promptFor} from '../local/codex-runner.mjs';
const facts={C01:'参与企业服务需求调研，推动平台上线，2025年完成一次迭代优化并持续稳定运行。'};
const profile={facts,target:'产品经理',boundaries:[]};
const assessment=(jobs,priority='可以尝试')=>({results:jobs.map(j=>({id:j.id,priority,reason:'业务分析经验相关',evidence:[{fact_id:'C01',jd_quote:'企业服务需求调研',relation:'直接经验'}],gaps:['范围待确认'],questions:['主要场景？'],keywords:['B端产品经理'],greeting:'',greeting_fact_ids:[]}))});
const greeting=()=>({greeting:'您好，我参与过企业服务需求调研，并推动平台上线。希望进一步了解这个岗位的业务场景和职责范围。',greeting_fact_ids:['C01'],claims:[{text:'参与过企业服务需求调研，并推动平台上线',fact_id:'C01',quote:'参与企业服务需求调研，推动平台上线'}]});
function setup({count=1,runner=async(p,j)=>({output:assessment(j)}),greetingRunner=async()=>({output:greeting()})}={}){
 const dataDir=mkdtempSync(join(tmpdir(),'split-pipeline-')),store=new IntakeStore(join(dataDir,'jobs.sqlite')),worker=new MatchWorker(store,profile,{dataDir,runner,greetingRunner}),controller=new WebController(store,worker);
 store.importPayload({schema_version:2,label:'synthetic',exported_at:new Date().toISOString(),jobs:Array.from({length:count},(_,i)=>({id:`boss:split${i}`,url:`https://www.zhipin.com/job_detail/split${i}.html`,title:'B端产品经理',jd:'负责企业服务需求调研与产品设计，推动项目实施并与研发团队协作交付。'.repeat(8),jd_status:'captured_unverified'}))});
 return {store,worker,controller};
}
const turn=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}assert.ok(fn(),'condition timed out');}

test('先匹配后招呼；风格变更只重写草稿且匹配指纹、时间、预算次数可核对',async()=>{
 let matches=0,greets=0;const e=setup({runner:async(p,j,o)=>{matches++;assert.equal(o.policy.greetingStyle,'');return {output:assessment(j)};},greetingRunner:async(p,j,a)=>{greets++;assert.equal(a.priority,'可以尝试');return {output:greeting()};}});
 try{
  await e.worker.nextStep();const before=e.store.db.prepare('SELECT * FROM match_runs').get();assert.equal(e.controller.detail('synthetic','boss:split0').greeting_state,'pending');
  await e.worker.nextStep();assert.equal(e.controller.detail('synthetic','boss:split0').result.greeting,greeting().greeting);
  const saved=e.controller.saveMatchingPolicy({greetingStyle:'自然简短'});assert.equal(saved.matchingChanged,false);assert.equal(saved.greetingChanged,true);
  assert.deepEqual(e.store.db.prepare('SELECT * FROM match_runs').get(),before);assert.equal(e.controller.detail('synthetic','boss:split0').greeting_state,'pending');
  await e.worker.nextStep();assert.equal(matches,1);assert.equal(greets,2);assert.equal(e.worker.status().daily_used,3);
  assert.deepEqual(e.store.db.prepare('SELECT * FROM match_runs').get(),before);assert.equal((await e.worker.nextStep()).status,'idle');
 }finally{e.store.close();}
});
test('低优先级不调用招呼；招呼超时/核查失败不删除匹配且有独立重试',async()=>{
 const low=setup({runner:async(p,j)=>({output:assessment(j,'低优先级')}),greetingRunner:()=>{throw new Error('unexpected_greeting');}});
 try{await low.worker.nextStep();assert.equal((await low.worker.nextStep()).status,'idle');assert.equal(low.worker.status().daily_used,1);assert.equal(low.worker.render().jobs[0].greeting_state,'not_required');}finally{low.store.close();}
 const e=setup({greetingRunner:async()=>{throw new Error('codex_timeout');}});
 try{
  await e.worker.nextStep();assert.equal((await e.worker.nextStep()).status,'failed');assert.equal(e.controller.detail('synthetic','boss:split0').greeting_state,'retry');assert.equal(e.controller.state().recommended,1);
  e.store.db.exec('UPDATE greeting_runs SET retry_at=0');e.worker.greetingRunner=async()=>({output:{...greeting(),claims:[{...greeting().claims[0],quote:'虚构证据'}]}});
  await e.worker.nextStep();assert.equal(e.controller.detail('synthetic','boss:split0').greeting_state,'failed');assert.equal(e.controller.detail('synthetic','boss:split0').result.greeting,'');assert.equal(e.controller.state().recommended,1);
 }finally{e.store.close();}
});
test('风格更改中旧招呼丢弃；匹配不受影响；重新生成使用新风格',async()=>{
 let release;const e=setup({greetingRunner:async()=>{await new Promise(r=>release=r);return {output:greeting()};}});
 try{await e.worker.step(1);const match=e.store.db.prepare('SELECT result FROM match_runs').get().result;const task=e.worker.greetingStep();e.controller.saveMatchingPolicy({greetingStyle:'新版'});release();assert.equal((await task).status,'superseded');assert.equal(e.store.db.prepare('SELECT result FROM match_runs').get().result,match);assert.equal(e.store.db.prepare('SELECT COUNT(*) n FROM greeting_runs').get().n,0);}finally{e.store.close();}
});
test('招呼审核拒绝参与升为主导、数字膨胀、一次迭代变持续迭代及漏列证据',()=>{
 assert.equal(validateGreeting(greeting(),profile).greeting,greeting().greeting);
 for(const phrase of ['主导企业服务需求调研','独立推动平台上线','推动平台持续迭代','完成100次迭代','有25年经验']){
  const g={greeting:`您好，我${phrase}。希望进一步了解贵司的具体业务场景及岗位职责范围。`,greeting_fact_ids:['C01'],claims:[{text:phrase,fact_id:'C01',quote:facts.C01}]};assert.throws(()=>validateGreeting(g,profile),/greeting_claim_overstatement/);
 }
 assert.throws(()=>validateGreeting({...greeting(),greeting:greeting().greeting+'累计100个项目。'},profile),/greeting_claim_uncovered/);
 const style={greetingStyle:'只影响招呼的独特风格',matchingSkill:'匹配方法'};
 assert.ok(!promptFor(profile,[],style).includes(style.greetingStyle));assert.ok(greetingPrompt(profile,{},assessment([]),style).includes(style.greetingStyle));
});
test('复用令牌池：快任务完成立刻补位，不等待慢任务；动态升降与暂停、排空',async()=>{
 let limit=2,enabled=true,started=0;const releases=[];
 const scheduler=new MatchScheduler({nextStep:()=>new Promise(r=>{started++;releases.push(()=>r({status:'completed'}));})},{canRun:()=>enabled,capacity:()=>limit,pollMs:10000});
 try{
  scheduler.start();await until(()=>started===2);releases[1]();await until(()=>started===3);assert.equal(scheduler.active,2);
  limit=3;scheduler.wake();await until(()=>started===4);assert.equal(scheduler.active,3);
  limit=1;releases[2]();await turn();await turn();assert.equal(started,4);releases[3]();await turn();await turn();assert.equal(started,4);
  releases[0]();await until(()=>started===5);enabled=false;releases[4]();await until(()=>scheduler.active===0);assert.equal(started,5);
  enabled=true;scheduler.wake();await until(()=>started===6);const closing=scheduler.close();let closed=false;closing.then(()=>closed=true);await turn();assert.equal(closed,false);releases[5]();await closing;assert.equal(started,6);
 }finally{scheduler.stop();releases.forEach(r=>r());await scheduler.close();}
});
test('并发下单岗位请求、无重复领取、共享额度不超发，停服不再领取',async()=>{
 let calls=0,active=0,max=0;const e=setup({count:12,runner:async(p,j)=>{assert.equal(j.length,1);calls++;active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,15));active--;return {output:assessment(j,'低优先级')};}});
 try{
  e.controller.saveSettings({...e.controller.settings,autoAnalyze:true,modelConcurrency:3,dailyLimit:7});e.controller.scheduler.start();await until(()=>calls===7&&e.controller.scheduler.active===0);
  assert.equal(max,3);assert.equal(e.worker.status().daily_used,7);assert.equal(e.store.db.prepare("SELECT COUNT(*) n FROM match_runs WHERE state='completed'").get().n,7);
  const hash=e.worker.profileHash;e.controller.saveSettings({...e.controller.settings,modelConcurrency:1});assert.equal(e.worker.profileHash,hash);
  assert.equal(new WebController(e.store,e.worker).settings.modelConcurrency,1);
  for(const x of [0,17,-1,1.5,null,'3'])assert.throws(()=>e.controller.saveSettings({...e.controller.settings,modelConcurrency:x}),/invalid_settings/);
 }finally{await e.controller.scheduler.close();e.store.close();}
});
test('失败任务释放令牌，后续任务继续；两阶段共用而非分别叠加并发',async()=>{
 let calls=0,active=0,max=0;const wrap=fn=>async(...args)=>{active++;max=Math.max(max,active);try{await new Promise(r=>setTimeout(r,5));return fn(...args);}finally{active--;}};
 const e=setup({count:3,runner:wrap((p,j)=>{if(calls++===0)throw new Error('codex_timeout');return {output:assessment(j)};}),greetingRunner:wrap(()=>({output:greeting()}))});
 try{e.controller.saveSettings({...e.controller.settings,autoAnalyze:true,modelConcurrency:2,dailyLimit:5});e.controller.scheduler.start();await until(()=>e.worker.status().daily_used===5&&e.controller.scheduler.active===0);assert.equal(max,2);assert.equal(e.worker.greetingRows().filter(r=>r.state==='completed').length,2);}finally{await e.controller.scheduler.close();e.store.close();}
});
