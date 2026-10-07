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

test('真实工作队列按手动招呼、自动招呼、JD匹配、背调顺序领取，控制开关不变',async()=>{
 const e=setup({count:3}),order=[];let first=0;
 try{
  await e.worker.step(2);e.worker.requestGreeting('synthetic','boss:split0');
  e.worker.greetingRunner=async(_p,job)=>{order.push(job.id==='boss:split0'?'manual':'greeting');return {output:greeting()};};
  e.worker.runner=async(_p,jobs)=>{order.push('matching');return {output:assessment(jobs,'低优先级')};};
  e.controller.saveSettings({...e.controller.settings,autoAnalyze:true,autoGreeting:true,modelConcurrency:1});
  const remove=e.controller.modelQueue.register('synthetic-research',{kind:'research',ready:()=>first===0,run:()=>{first++;order.push('research');}});
  e.controller.scheduler.start();await until(()=>first===1&&e.controller.modelQueue.active===0);
  remove();assert.deepEqual(order,['manual','greeting','matching','research']);assert.equal(e.worker.status().daily_used,5);
  assert.equal(e.controller.settings.autoAnalyze,true);assert.equal(e.controller.settings.autoGreeting,true);
 }finally{await e.controller.scheduler.close();await e.controller.modelQueue.close();e.store.close();}
});

test('按四档建议预览和批量生成；低档显式选中才进入队列，不改匹配/开关/沟通',async()=>{
 const e=setup({count:4});try{
  await e.worker.step(4);const priorities=['优先沟通','可以尝试','低优先级','不匹配'];
  for(let i=0;i<4;i++)e.store.db.prepare("UPDATE match_runs SET result=json_set(result,'$.priority',?) WHERE id=?").run(priorities[i],'boss:split'+i);
  const original=e.store.db.prepare('SELECT * FROM match_runs ORDER BY id').all();
  assert.equal(e.worker.greetingRows().length,2);
  const scope={priorities:['低优先级','不匹配'],dataset:'synthetic'},preview=e.controller.previewBulkGreetings(scope);
  assert.equal(preview.stats.queueable,2);assert.equal(preview.rows,undefined);assert.deepEqual(preview.byPriority,{'低优先级':1,'不匹配':1});
  assert.equal(e.store.db.prepare('SELECT count(*) n FROM greeting_runs').get().n,0);
  assert.equal(e.controller.regenerateBulkGreetings({...scope,token:preview.token}).queued,2);
  assert.throws(()=>e.controller.regenerateBulkGreetings({...scope,token:preview.token}),/scope_changed/);
  assert.equal(e.controller.previewBulkGreetings(scope).stats.alreadyQueued,2);
  assert.equal((await e.worker.nextStep({matching:false,greeting:false})).status,'completed');
  assert.equal((await e.worker.nextStep({matching:false,greeting:false})).status,'completed');
  assert.equal((await e.worker.nextStep({matching:false,greeting:false})).status,'idle');
  assert.equal(e.controller.detail('synthetic','boss:split2').greeting_state,'completed');
  assert.ok(e.controller.detail('synthetic','boss:split3').result.greeting);
  assert.deepEqual(e.store.db.prepare('SELECT * FROM match_runs ORDER BY id').all(),original);
  assert.equal(e.controller.settings.autoAnalyze,false);assert.equal(e.controller.settings.autoGreeting,false);assert.equal(e.store.db.prepare('SELECT count(*) n FROM manual_contact').get().n,0);
 }finally{await e.controller.scheduler.close();e.store.close();}
});
test('批量范围检查及跳过统计，不重复运行中任务，预览变更拒绝整个批次',async()=>{
 const e=setup({count:5});try{
  await e.worker.step(5);e.worker.contact('synthetic','boss:split0','contacted');
  const originalDecision=e.worker.activityDecision.bind(e.worker);e.worker.activityDecision=job=>job.id==='boss:split1'?{allowed:false}:originalDecision(job);
  e.worker.requestGreeting('synthetic','boss:split2');e.worker.claimGreeting(); // split2 now running
  e.worker.requestGreeting('synthetic','boss:split3');
  const scope={priorities:['可以尝试'],dataset:'synthetic'},p=e.controller.previewBulkGreetings(scope);
  assert.deepEqual(p.stats,{selected:5,queueable:1,running:1,alreadyQueued:1,activitySkipped:1,contactedSkipped:1});
  assert.equal(e.controller.previewBulkGreetings({...scope,includeContacted:true}).stats.queueable,2);
  assert.equal(e.controller.previewBulkGreetings({...scope,dataset:'other'}).stats.selected,0);
  for(const value of [{priorities:[]},{priorities:['不存在']},{priorities:'优先沟通'},{...scope,includeContacted:'yes'}])assert.throws(()=>e.controller.previewBulkGreetings(value),/invalid_greeting_scope/);
  e.controller.saveMatchingPolicy({greetingStyle:'新风格'});
  assert.throws(()=>e.controller.regenerateBulkGreetings({...scope,token:p.token}),/scope_changed/);
  assert.equal(e.store.db.prepare('SELECT count(*) n FROM greeting_runs').get().n,0);
 }finally{await e.controller.scheduler.close();e.store.close();}
});
test('同轮16路空结果仅通知其他队列一次，不产生16次同步背调扫描',async()=>{
 let calls=0;const scheduler=new MatchScheduler({nextStep:async()=>({status:'idle'})},{canRun:()=>true,capacity:()=>16});
 scheduler.onAvailable=()=>calls++;
 try{scheduler.pump();await turn();await turn();assert.equal(calls,1);assert.equal(scheduler.active,0);
  scheduler.pump();await turn();await turn();assert.equal(calls,2);
 }finally{await scheduler.close();}
});
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
test('低优先级不自动生成；超时可重试，返回内容不再核查引文',async()=>{
 const low=setup({runner:async(p,j)=>({output:assessment(j,'低优先级')}),greetingRunner:()=>{throw new Error('unexpected_greeting');}});
 try{await low.worker.nextStep();assert.equal((await low.worker.nextStep()).status,'idle');assert.equal(low.worker.status().daily_used,1);assert.equal(low.worker.render().jobs[0].greeting_state,'not_required');}finally{low.store.close();}
 const e=setup({greetingRunner:async()=>{throw new Error('codex_timeout');}});
 try{
  await e.worker.nextStep();assert.equal((await e.worker.nextStep()).status,'failed');assert.equal(e.controller.detail('synthetic','boss:split0').greeting_state,'retry');assert.equal(e.controller.state().recommended,1);
  e.store.db.exec('UPDATE greeting_runs SET retry_at=0');e.worker.greetingRunner=async()=>({output:{...greeting(),claims:[{...greeting().claims[0],quote:'虚构证据'}]}});
  await e.worker.nextStep();assert.equal(e.controller.detail('synthetic','boss:split0').greeting_state,'completed');assert.equal(e.controller.detail('synthetic','boss:split0').result.greeting,greeting().greeting);assert.equal(e.controller.state().recommended,1);
 }finally{e.store.close();}
});
test('短招呼及冲突说明无claims也原样入库，不误触发结构失败',async()=>{
 for(const text of ['您好','固定开头存在冲突，以下是说明。','长'.repeat(2100)]){
  const e=setup({greetingRunner:async()=>({output:{greeting:text,greeting_fact_ids:[],claims:[]}})});
  try{
   await e.worker.step(1);
   assert.equal((await e.worker.greetingStep()).status,'completed');
   assert.equal(e.controller.detail('synthetic','boss:split0').result.greeting,text);
   assert.equal(e.controller.detail('synthetic','boss:split0').greeting_state,'completed');
  }finally{e.store.close();}
 }
});

test('风格更改中旧招呼丢弃；匹配不受影响；重新生成使用新风格',async()=>{
 let release;const e=setup({greetingRunner:async()=>{await new Promise(r=>release=r);return {output:greeting()};}});
 try{await e.worker.step(1);const match=e.store.db.prepare('SELECT result FROM match_runs').get().result;const task=e.worker.greetingStep();e.controller.saveMatchingPolicy({greetingStyle:'新版'});release();assert.equal((await task).status,'superseded');assert.equal(e.store.db.prepare('SELECT result FROM match_runs').get().result,match);assert.equal(e.store.db.prepare('SELECT COUNT(*) n FROM greeting_runs').get().n,0);}finally{e.store.close();}
});
test('AI聊天的旧审核规则保持：参与升主导、数字膨胀、频次扩张及漏列证据仍拒绝',()=>{
 assert.equal(validateGreeting(greeting(),profile).greeting,greeting().greeting);
 for(const phrase of ['主导企业服务需求调研','独立推动平台上线','推动平台持续迭代','完成100次迭代','有25年经验']){
  const g={greeting:`您好，我${phrase}。希望进一步了解贵司的具体业务场景及岗位职责范围。`,greeting_fact_ids:['C01'],claims:[{text:phrase,fact_id:'C01',quote:facts.C01}]};assert.throws(()=>validateGreeting(g,profile,{strictMarkers:true}),/greeting_claim_overstatement/);
 }
 assert.throws(()=>validateGreeting({...greeting(),greeting:greeting().greeting+'累计100个项目。'},profile,{strictMarkers:true}),/greeting_claim_uncovered/);
 const style={greetingStyle:'只影响招呼的独特风格',matchingSkill:'匹配方法'};
 assert.ok(!promptFor(profile,[],style).includes(style.greetingStyle));assert.ok(greetingPrompt(profile,{},assessment([]),style).includes(style.greetingStyle));
});
test('仅聊天保留引文审核；草稿提示将语义判断交给模型',()=>{
 const p={facts:{C01:'负责从零到一搭建系统，项目金额三百万元。'}};
 const phrase='负责系统0到1建设，项目金额300万元';
 const g={greeting:`您好，我${phrase}。希望进一步了解贵司的产品工作及业务场景。`,greeting_fact_ids:['C01'],claims:[{text:phrase,fact_id:'C01',quote:p.facts.C01}]};
 assert.equal(validateGreeting(g,p),g);
 assert.throws(()=>validateGreeting(g,p,{strictMarkers:true}),/greeting_claim_overstatement/);
 assert.throws(()=>validateGreeting({...g,claims:[{...g.claims[0],quote:'不存在的原文依据'}]},p),/greeting_claim_not_grounded/);
 assert.match(greetingPrompt(p,{},{}),/完整简历上下文/);
 assert.match(greetingPrompt(p,{},{}),/不把参与写成主导/);
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
 try{e.controller.saveSettings({...e.controller.settings,autoAnalyze:true,autoGreeting:true,modelConcurrency:2,dailyLimit:5});e.controller.scheduler.start();await until(()=>e.worker.status().daily_used===5&&e.controller.scheduler.active===0);assert.equal(max,2);assert.equal(e.worker.greetingRows().filter(r=>r.state==='completed').length,2);}finally{await e.controller.scheduler.close();e.store.close();}
});

test('两个自动开关独立：仅匹配不生成，仅招呼不匹配，两关均关不运行',async()=>{
 let matches=0,greets=0;const e=setup({count:2,runner:async(p,j)=>{matches++;return {output:assessment(j)};},greetingRunner:async()=>{greets++;return {output:greeting()};}});
 try{
  e.controller.scheduler.start();await turn();await turn();assert.equal(matches+greets,0);
  e.controller.saveSettings({...e.controller.settings,autoAnalyze:true});await until(()=>matches===2&&e.controller.scheduler.active===0);assert.equal(greets,0);
  e.controller.saveSettings({...e.controller.settings,autoAnalyze:false,autoGreeting:true});await until(()=>greets===2&&e.controller.scheduler.active===0);assert.equal(matches,2);
  const old=e.controller.settings;e.controller.saveSettings({...old,autoGreeting:false});assert.equal(e.controller.settings.autoAnalyze,false);
  assert.equal(new WebController(e.store,e.worker).settings.autoGreeting,false);
  for(const autoGreeting of ['true',null,1])assert.throws(()=>e.controller.saveSettings({...old,autoGreeting}),/invalid_settings/);
 }finally{await e.controller.scheduler.close();e.store.close();}
});
test('旧开关迁移继承行为；后续修改匹配开关不再牵动招呼',()=>{
 for(const enabled of [false,true]){const e=setup();try{
  e.controller.write('settings',{autoAnalyze:enabled,dailyLimit:12,keywords:[]});const c=new WebController(e.store,e.worker);
  assert.equal(c.settings.autoGreeting,enabled);c.saveSettings({...c.settings,autoAnalyze:!enabled});assert.equal(c.settings.autoGreeting,enabled);
  assert.equal(new WebController(e.store,e.worker).settings.autoGreeting,enabled);
 }finally{e.store.close();}}
});
test('手动重新生成不重匹配、不开自动、不发送；并发排队、去重、失败保留旧稿',async()=>{
 const e=setup();let release;
 try{
  await e.worker.step(1);await e.worker.greetingStep();const match=e.store.db.prepare('SELECT * FROM match_runs').get();
  const old=e.controller.detail('synthetic','boss:split0').result.greeting;
  e.worker.greetingRunner=()=>new Promise(ok=>{release=ok;}).then(()=>{throw new Error('codex_timeout');});
  assert.equal(e.controller.regenerateGreeting({dataset:'synthetic',id:'boss:split0'}).alreadyQueued,false);
  assert.equal(e.controller.regenerateGreeting({dataset:'synthetic',id:'boss:split0'}).alreadyQueued,true);
  let releaseResearch;const research=e.controller.modelQueue.submit({id:'held-research',kind:'research',run:()=>new Promise(r=>{releaseResearch=r;})});await until(()=>!!releaseResearch);
  e.controller.scheduler.start();await turn();await turn();assert.equal(release,undefined);
  releaseResearch();await research;e.controller.scheduler.wake();await until(()=>!!release);
  assert.throws(()=>e.controller.regenerateGreeting({dataset:'synthetic',id:'boss:split0'}),/greeting_busy/);
  assert.equal(e.controller.detail('synthetic','boss:split0').result.greeting,old);
  release({output:{invalid:true}});await until(()=>e.controller.scheduler.active===0);
  assert.equal(e.controller.detail('synthetic','boss:split0').result.greeting,old);assert.equal(e.worker.render().jobs[0].greeting,old);assert.equal(e.worker.status().daily_used,3);
  e.worker.greetingRunner=async()=>({output:{...greeting(),greeting:greeting().greeting+'期待进一步沟通。'}});
  e.controller.regenerateGreeting({dataset:'synthetic',id:'boss:split0'});await until(()=>e.worker.status().daily_used===4&&e.controller.scheduler.active===0);
  assert.match(e.controller.detail('synthetic','boss:split0').result.greeting,/期待进一步沟通/);
  assert.deepEqual(e.store.db.prepare('SELECT * FROM match_runs').get(),match);
  assert.equal(e.controller.settings.autoAnalyze,false);assert.equal(e.controller.settings.autoGreeting,false);
  assert.equal(e.store.db.prepare('SELECT count(*) n FROM manual_contact').get().n,0);
 }finally{release?.({output:greeting()});await e.controller.scheduler.close();e.store.close();}
});
test('手动请求遵守额度且持久保存，未匹配和低优先级拒绝',async()=>{
 const e=setup();try{
  assert.throws(()=>e.controller.regenerateGreeting({dataset:'synthetic',id:'boss:split0'}),/not_eligible/);
  await e.worker.step(1);e.controller.saveSettings({...e.controller.settings,dailyLimit:1});
  e.controller.regenerateGreeting({dataset:'synthetic',id:'boss:split0'});e.controller.scheduler.start();await turn();await turn();
  assert.equal(e.worker.hasRequestedGreeting(),true);assert.equal(e.worker.status().daily_used,1);
  e.controller.saveSettings({...e.controller.settings,dailyLimit:2});await until(()=>e.worker.status().daily_used===2&&e.controller.scheduler.active===0);
  assert.equal(e.worker.hasRequestedGreeting(),false);assert.equal(e.controller.detail('synthetic','boss:split0').greeting_state,'completed');
 }finally{await e.controller.scheduler.close();e.store.close();}
 const low=setup({runner:async(p,j)=>({output:assessment(j,'低优先级')})});try{await low.worker.step(1);assert.throws(()=>low.controller.regenerateGreeting({dataset:'synthetic',id:'boss:split0'}),/not_eligible/);}finally{low.store.close();}
});
