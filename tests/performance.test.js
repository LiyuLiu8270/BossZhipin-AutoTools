import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {cachedRead,trackReadTables} from '../local/read-cache.mjs';
import {IntakeStore} from '../local/intake.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {WebController} from '../local/web-controller.mjs';

test('读缓存复用且对本连接写入、外部提交、配置和时间边界失效，容量有界',()=>{
 const path=join(mkdtempSync(join(tmpdir(),'career-cache-')),'t.sqlite'),db=new DatabaseSync(path),external=new DatabaseSync(path);
 try{
  db.exec('CREATE TABLE t(n INTEGER)');const owner={db};let builds=0,now=100;
  const read=(identity='a')=>cachedRead(owner,'x',identity,()=>++builds,{clock:()=>now,expiresAt:()=>110});
  assert.equal(read(),1);assert.equal(read(),1);db.exec('INSERT INTO t VALUES(1)');assert.equal(read(),2);
  external.exec('INSERT INTO t VALUES(2)');assert.equal(read(),3);assert.equal(read('b'),4);now=110;assert.equal(read('b'),5);
  for(let i=0;i<100;i++)cachedRead(owner,'key'+i,'',()=>i);assert.equal(owner._readCache.size,24);
 }finally{external.close();db.close();}
});

function fixture(){
 const dataDir=mkdtempSync(join(tmpdir(),'career-perf-')),store=new IntakeStore(join(dataDir,'jobs.sqlite'));
 const worker=new MatchWorker(store,{mode:'resume_fulltext',facts:{C01:'需求分析'}},{dataDir,runner:async()=>{throw Error('should_not_call')}});
 const controller=new WebController(store,worker);
 store.importPayload({schema_version:2,label:'synthetic',exported_at:'2026-09-30T01:00:00Z',jobs:Array.from({length:40},(_,i)=>({id:'boss:perf_'+i,url:`https://www.zhipin.com/job_detail/perf_${i}.html`,title:'产品经理'+i,company:'合成公司',jd:'负责需求分析和产品设计。'.repeat(20),jd_status:'captured_unverified',contact_status:'unknown'}))});
 return {dataDir,store,worker,controller};
}
test('额度耗尽不扫描统计、不领取、不调用模型；提高额度后重新可执行',async()=>{
 const e=fixture();try{
  e.store.db.prepare('INSERT INTO match_budget VALUES(?,?)').run(e.worker.day(Date.now()),e.worker.dailyLimit);
  e.worker.status=()=>{throw Error('full scan')};e.worker.claimGreeting=()=>{throw Error('claim')};
  for(let i=0;i<10;i++)assert.equal((await e.worker.nextStep()).reason,'daily_limit');
  assert.equal(e.worker.budgetAvailable(),false);e.worker.dailyLimit++;assert.equal(e.worker.budgetAvailable(),true);
 }finally{e.store.close();}
});
test('模型写入不重读正文；岗位原文更新立即失效；详情队列变化和到期自动刷新',()=>{
 const e=fixture();try{
  const snapshot=e.store.jobsSnapshot();const q=e.store.db.prepare('SELECT fingerprint FROM intake_analysis_queue LIMIT 1').get();
  e.store.db.prepare('INSERT INTO match_runs(dataset,id,fingerprint,profile,state,updated) VALUES(?,?,?,?,?,?)').run('synthetic','boss:perf_0',q.fingerprint,e.worker.profileHash,'pending',Date.now());
  assert.equal(e.store.jobsSnapshot(),snapshot);
  e.store.db.prepare("UPDATE intake_jobs SET body=json_set(body,'$.company',?) WHERE id=?").run('更新公司','boss:perf_0');assert.notEqual(e.store.jobsSnapshot(),snapshot);assert.equal(e.controller.detail('synthetic','boss:perf_0').job.company,'更新公司');
  e.store.db.exec('CREATE TABLE collection_details(dataset TEXT,id TEXT,state TEXT,retry_at INTEGER,attempts INTEGER);');trackReadTables(e.store.db,['collection_details']);
  e.store.db.prepare("UPDATE intake_jobs SET body=json_set(body,'$.jd','','$.jd_status','missing') WHERE id=?").run('boss:perf_0');assert.equal(e.controller.list().summary.detailCounts.unqueued,1);
  const original=Date.now;let now=original();try{Date.now=()=>now;e.store.db.prepare("INSERT INTO collection_details VALUES(?,?,'pending',?,0)").run('synthetic','boss:perf_0',now+1000);const before=e.controller.list();assert.equal(before.summary.detailCounts.waiting_retry,1);now+=1000;const after=e.controller.list();assert.equal(after.summary.detailCounts.pending,1);assert.notEqual(before.revision,after.revision);}finally{Date.now=original;}
 }finally{e.store.close();}
});
test('列表/状态复用快照，单岗位直接查询；人工记录及外部写入立即失效',()=>{
 const e=fixture();let all=0,single=0;const original=e.controller.readRows.bind(e.controller);
 e.controller.readRows=(dataset,id)=>{id?single++:all++;return original(dataset,id);};
 e.worker.greetingFor=()=>{throw Error('N+1 lookup')};
 try{
  assert.equal(e.controller.list().items.length,30);e.controller.list();e.controller.state();e.controller.state();assert.equal(all,1);
  e.controller.detail('synthetic','boss:perf_1');assert.equal(single,1);assert.equal(all,1);
  e.controller.action({dataset:'synthetic',id:'boss:perf_1',stage:'contacted',contact:'contacted',reply:'waiting',note:'保留人工记录'});
  assert.equal(e.controller.detail('synthetic','boss:perf_1').note,'保留人工记录');assert.equal(e.controller.list().summary.waiting,1);assert.equal(all,2);
  const external=new DatabaseSync(join(e.dataDir,'jobs.sqlite'));external.prepare("UPDATE ui_actions SET note=? WHERE dataset=? AND id=?").run('外部修改','synthetic','boss:perf_1');external.close();
  assert.equal(e.controller.detail('synthetic','boss:perf_1').note,'外部修改');
 }finally{e.store.close();}
});
test('统计缓存仍反映运行中占用和当日预算，报告合并写入且可强制刷新',()=>{
 const e=fixture();try{
  assert.equal(e.worker.status().active_stages.matching,0);e.worker.activeStages.matching=1;assert.equal(e.worker.status().active_stages.matching,1);
  let writes=0;e.worker.render=()=>{writes++;e.worker._reportDirty=false;};e.worker.scheduleReport();const timer=e.worker._reportTimer;e.worker.scheduleReport();assert.equal(e.worker._reportTimer,timer);assert.equal(writes,0);
  e.worker.flushReport();assert.equal(writes,1);assert.equal(e.worker._reportTimer,null);e.worker.flushReport();assert.equal(writes,1);
 }finally{e.store.close();}
});
