import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IntakeStore} from '../local/intake.mjs';
import {Collector} from '../local/collector.mjs';
import {CollectionBudget,collectionDay} from '../local/collection-budget.mjs';

function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'collection-daily-')),store=new IntakeStore(':memory:');let now=Date.parse('2026-10-01T10:00:00+08:00');const calls=[];
 const controller={settings:{keywords:[]}};
 const runner=async(mode,input)=>{calls.push(mode);return {ok:true,payload:[{...input.job,jd:'产品需求分析设计与交付。'.repeat(30)}]};};
 const c=new Collector(store,controller,{dataDir:dir,now:()=>now,browser:async()=>{},runner});c.detailIntervalMs=0;
 function queue(id,dataset=c.config.dataset){const job={title:'产品经理',job_link:`https://www.zhipin.com/job_detail/${id}.html`,encrypt_job_id:id},list={scraped_at:'2026-10-01T09:00:00+08:00',keyword:'test',jobs:[job]};store.importScraper({list,label:dataset,timezoneOffset:'+08:00'});store.db.prepare("INSERT INTO collection_details(dataset,id,body,state) VALUES(?,?,?,'pending')").run(dataset,'boss:'+id,JSON.stringify({list}));}
 return {dir,store,c,calls,queue,controller,runner,now:()=>now,advance:ms=>now+=ms,cleanup:async()=>{await c.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('仅采详情无需关键词，跨轮累计、空队列不计、保留搜索计划与缺口',async()=>{
 const f=fixture();try{
  const {c}=f;c.save({...c.config,enabled:true,dailyDetailLimit:2});const next=c.config.nextRun;
  c.saveRun({id:'search-old',dataset:c.config.dataset,trigger:'manual',state:'partial',startedAt:f.now()-1,searchDiagnostics:[{keyword:'missing',partial:true}]});
  f.queue('a');c.startDetails();await c.promise;assert.deepEqual(f.calls,['detail']);assert.equal(c.config.nextRun,next);assert.equal(c.status().dailyDetails.used,1);assert.deepEqual(c.status().incompleteKeywords,['missing']);assert.equal(c.status().latestSearchId,'search-old');
  f.advance(1);c.startDetails();await c.promise;assert.equal(c.latest().detailTotal,0);assert.equal(c.status().dailyDetails.used,1);
  f.queue('b');f.queue('c');f.advance(1);c.startDetails();await c.promise;
  assert.equal(c.latest().state,'daily_limit');assert.equal(c.status().dailyDetails.used,2);assert.equal(c.config.blocked,null);assert.equal(c.status().backlog[0].count,1);assert.throws(()=>c.startDetails(),/detail_daily_limit/);
  c.save({...c.config,dailyDetailLimit:3});c.startDetails();await c.promise;assert.equal(c.status().dailyDetails.used,3);assert.equal(c.status().backlog.length,0);assert.equal(c.config.nextRun,next);
 }finally{await f.cleanup();}
});

test('每日额度全局共用，重启不重置，北京时间零点自动换日',async()=>{
 const f=fixture();try{
  const {c}=f;c.save({...c.config,dailyDetailLimit:1});f.queue('a');c.startDetails();await c.promise;
  c.save({...c.config,dataset:'second'});f.queue('b');assert.throws(()=>c.startDetails(),/detail_daily_limit/);
  const reloaded=new Collector(f.store,f.controller,{dataDir:f.dir,now:f.now,browser:async()=>{},runner:f.runner});reloaded.detailIntervalMs=0;
  assert.equal(reloaded.status().dailyDetails.used,1);assert.throws(()=>reloaded.startDetails(),/detail_daily_limit/);
  f.advance(14*3600000-1);assert.equal(reloaded.status().dailyDetails.remaining,0);f.advance(1);assert.equal(reloaded.status().dailyDetails.remaining,1);
  reloaded.startDetails();await reloaded.promise;assert.equal(reloaded.latest().details,1);assert.equal(reloaded.status().dailyDetails.used,1);
  assert.equal(collectionDay(Date.parse('2026-10-01T16:00:00Z')),'2026-10-02');
 }finally{await f.cleanup();}
});

test('失败、重试和字段补采共享额度；门禁返还给请求发起日',async()=>{
 const f=fixture();try{
  const {c}=f;c.config.dailyDetailLimit=3;
  c.runner=async()=>({ok:false,error:'detail_not_readable'});f.queue('a');c.startDetails();await c.promise;assert.equal(c.status().dailyDetails.used,1);
  f.advance(3600001);c.startDetails();await c.promise;assert.equal(c.status().dailyDetails.used,2);
  c.runner=async()=>({ok:true,payload:{}});await c.readDetail('backfill',{},{});assert.equal(c.status().dailyDetails.used,3);await assert.rejects(c.readDetail('detail',{},{}),/detail_daily_limit/);
  f.advance(24*3600000);const prior=c.status().dailyDetails.day;
  c.runner=async()=>{f.advance(24*3600000);return {ok:false,error:'login_required'};};await c.readDetail('detail',{},{});
  assert.equal(c.status().dailyDetails.used,0);assert.equal(f.store.db.prepare('SELECT used FROM collection_daily_usage WHERE day=?').get(prior).used,0);
 }finally{await f.cleanup();}
});

test('在途占额持久化、停止/异常不返还，调低额度不超发',async()=>{
 const f=fixture();try{
  const {c}=f;c.config.dailyDetailLimit=2;c.runner=async()=>{throw new Error('collection_timeout');};await assert.rejects(c.readDetail('detail',{},{}),/timeout/);assert.equal(c.status().dailyDetails.used,1);
  c.config.dailyDetailLimit=1;await assert.rejects(c.readDetail('detail',{},{}),/detail_daily_limit/);
  const abort=new AbortController();abort.abort();await assert.rejects(c.readDetail('detail',{}, {signal:abort.signal}),/cancelled/);assert.equal(c.status().dailyDetails.used,1);
  c.config.dailyDetailLimit=2;c.runner=async()=>{throw new Error('cancelled');};await assert.rejects(c.readDetail('detail',{},{}),/cancelled/);assert.equal(c.status().dailyDetails.used,2);
 }finally{await f.cleanup();}
});

test('旧配置迁移保留数值；跨日逐项日志回填一次，缺日志保守按末日计入',async()=>{
 const f=fixture();try{
  const {db}=f.store;db.prepare("DELETE FROM collection_config WHERE key='daily_budget_migrated'").run();
  db.prepare("INSERT INTO collection_config VALUES('settings',?)").run(JSON.stringify({...f.c.config,dailyDetailLimit:undefined,maxDetails:300}));
  f.c.saveRun({id:'legacy',details:2,failedDetails:1,startedAt:Date.parse('2026-09-30T23:00:00+08:00'),finishedAt:f.now()});
  mkdirSync(join(f.dir,'collection','legacy'),{recursive:true});writeFileSync(join(f.dir,'collection','legacy','task-debug.jsonl'),[
   {event:'detail_result',at:'2026-09-30T23:59:00+08:00',ok:true},
   {event:'detail_result',at:'2026-10-01T00:01:00+08:00',ok:true},
   {event:'detail_result',at:'2026-10-01T00:02:00+08:00',ok:false,error:'login_required'}
  ].map(x=>JSON.stringify(x)).join('\n'));
  const reloaded=new Collector(f.store,f.controller,{dataDir:f.dir,now:f.now});
  assert.equal(reloaded.config.dailyDetailLimit,300);assert.equal(reloaded.config.maxDetails,undefined);
  assert.equal(reloaded.status().dailyDetails.used,2);assert.equal(db.prepare('SELECT used FROM collection_daily_usage WHERE day=?').get('2026-09-30').used,1);
  new CollectionBudget(db,{dataDir:f.dir,now:f.now});assert.equal(reloaded.status().dailyDetails.used,2);
 }finally{await f.cleanup();}
});

test('额度跨午夜按启动日计，当前任务可在新日继续而非绑定原轮',async()=>{
 const f=fixture();try{
  f.c.config.dailyDetailLimit=1;f.advance(14*3600000-1000);f.queue('a');f.queue('b');
  f.c.runner=async(mode,input)=>{f.advance(2000);return f.runner(mode,input);};f.c.startDetails();await f.c.promise;
  assert.equal(f.c.latest().details,2);assert.equal(f.c.latest().state,'completed');assert.equal(f.c.status().dailyDetails.used,1);
 }finally{await f.cleanup();}
});

test('字段补采也在日额度耗尽处暂停，搜索仍可执行且不消耗详情额度',async()=>{
 const f=fixture();try{
  const {c}=f;c.config.dailyDetailLimit=1;c.budget.reserve(1);f.queue('a');c.backfill();await c.promise;
  assert.equal(c.latest().state,'daily_limit');assert.equal(c.latest().processed,0);assert.equal(c.config.blocked,null);assert.deepEqual(f.calls,[]);
  f.advance(1);f.controller.settings.keywords=[{text:'search',enabled:true}];c.runner=async(mode)=>{f.calls.push(mode);return {ok:true,payload:{scraped_at:'2026-10-01T09:00:00+08:00',keyword:'search',jobs:[]}};};
  c.start();await c.promise;assert.deepEqual(f.calls,['list']);assert.equal(c.latest().state,'daily_limit');assert.equal(c.status().dailyDetails.used,1);
 }finally{await f.cleanup();}
});
