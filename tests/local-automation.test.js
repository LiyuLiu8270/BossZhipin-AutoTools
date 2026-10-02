import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {IntakeStore} from '../local/intake.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {validateResults,promptFor,runCodex} from '../local/codex-runner.mjs';
import {createIntakeServer} from '../local/service.mjs';

const profile={facts:{C01:'企业服务需求调研和产品设计'},target:'产品经理'};
const job=(id='one',extra={})=>({id:`boss:${id}`,url:`https://www.zhipin.com/job_detail/${id}.html`,title:'B端产品经理',company:'合成公司',tags:['企业服务'],jd:'负责企业服务需求调研与产品设计，跨团队推进研发交付。任职要求：产品经理经验与复杂业务流程梳理能力。'.repeat(4),jd_status:'captured_unverified',seen_count:1,contact_status:'unknown',...extra});
const capture=(jobs,at='2026-09-30T01:00:00Z')=>({schema_version:2,collector_version:'0.8.14',label:'合成测试',exported_at:at,jobs,runs:[]});
const result=j=>({id:j.id,priority:'可以尝试',reason:'企业服务经验相关，具体行业待确认。',evidence:[{fact_id:'C01',jd_quote:'企业服务需求调研',relation:'直接经验'}],gaps:['行业待确认'],questions:['主要面向哪个行业？'],greeting:'您好，我负责过企业服务需求调研和产品设计，看到岗位强调业务流程与研发协同，希望进一步了解贵司的产品方向。',greeting_fact_ids:['C01'],keywords:['企业服务产品经理']});
const runner=async(p,jobs)=>({output:{results:jobs.map(j=>({...result(j),greeting:'',greeting_fact_ids:[]}))},usage:{input_tokens:1,output_tokens:1}});
function setup(options={}){const dataDir=mkdtempSync(join(tmpdir(),'boss-auto-test-')),store=new IntakeStore(join(dataDir,'jobs.sqlite'));return {store,dataDir,worker:new MatchWorker(store,profile,{dataDir,runner,...options})};}

test('本地导入幂等；不虚增采集次数；旧导出不能覆盖新快照',()=>{
  const {store}=setup();try{
    const a=capture([job()]);assert.equal(store.importPayload(a).added,1);assert.equal(store.importPayload(a).status,'already_imported');
    store.importPayload(capture([job('one',{company:'更新公司',seen_count:2})],'2026-09-30T02:00:00Z'));
    assert.equal(store.get(a.label,'boss:one').seen_count,2);
    assert.equal(store.importPayload(capture([job('one',{company:'旧公司'})],'2026-09-29T01:00:00Z')).older_skipped,1);
    assert.equal(store.get(a.label,'boss:one').company,'更新公司');
    assert.throws(()=>store.importPayload(capture([job(),job()])));
    assert.equal(store.stats()[0].jobs,1);
  }finally{store.close();}
});
test('自动完成、证据验证、报告生成、重复内容不调用、JD变化重新排队',async()=>{
  let calls=0;const {store,worker,dataDir}=setup({runner:async(...a)=>{calls++;return runner(...a);}});
  try{
    store.importPayload(capture([job()]));assert.equal((await worker.step()).status,'completed');assert.equal(calls,1);
    worker.flushReport();assert.match(readFileSync(join(dataDir,'reports/latest.md'),'utf8'),/打招呼草稿：待生成/);
    assert.equal((await worker.step()).status,'idle');
    store.importPayload(capture([job('one',{seen_count:20,last_seen_at:'2026-09-30T04:00:00Z'})],'2026-09-30T04:00:00Z'));
    assert.equal((await worker.step()).status,'idle');assert.equal(calls,1);
    worker.contact('合成测试','boss:one','contacted');
    store.importPayload(capture([job('one',{jd:job().jd+'要求熟悉保险业务。'})],'2026-09-30T05:00:00Z'));
    assert.equal(worker.render().jobs.length,0); // stale result not displayed as current
    assert.equal((await worker.step()).status,'completed');assert.equal(calls,2);
    assert.equal(worker.render().jobs[0].contact_status,'contacted');
  }finally{store.close();}
});
test('关闭、链接不可用、缺失、待复查不进入模型队列；猎头缺公司仍分析',async()=>{
  const {store,worker}=setup();try{
    store.importPayload(capture([job('closed',{recruitment_signals:{availability:{value:'explicit_unavailable'}}}),job('missing',{jd:'',jd_status:'missing'}),job('review',{detail_review:{state:'needs_review'}}),job('bad',{link_access:{state:'unavailable'}}),job('hunter',{company:'',hiring_party:{type:'headhunter',evidence:[]}})]));
    assert.equal(worker.status().deferred,4);assert.equal((await worker.step()).count,1);
  }finally{store.close();}
});
test('失败不算完成；有限重试、租约恢复和每日额度',async()=>{
  const {store,worker}=setup({runner:async()=>{throw new Error('codex_timeout');},dailyLimit:3});try{
    store.importPayload(capture([job()]));assert.equal((await worker.step()).status,'failed');
    assert.equal(worker.render().jobs.length,0);assert.equal((await worker.step()).status,'idle');
    for(let i=0;i<2;i++){store.db.exec('UPDATE match_runs SET retry_at=0');await worker.step();}
    assert.equal(worker.status().states[0].state,'failed');assert.equal(worker.status().daily_used,3);
    worker.retryFailed();assert.equal(worker.claim().rows.length,0);
  }finally{store.close();}
  const other=setup();try{
    other.store.importPayload(capture([job()]));const first=other.worker.claim();assert.equal(first.rows.length,1);
    assert.equal(other.worker.claim().rows.length,0);
    const later=other.worker.claim(3,Date.now()+301000);assert.equal(later.rows.length,1);assert.notEqual(later.lease,first.lease);
  }finally{other.store.close();}
});
test('简历版本变化重评，数据集隔离',async()=>{
  const {store,worker,dataDir}=setup();try{
    store.importPayload(capture([job()]));store.importPayload({...capture([job()]),label:'其他数据集'});
    assert.equal((await worker.step()).count,2);assert.equal(worker.render().jobs.length,2);
    const newer=new MatchWorker(store,{...profile,version:'new'},{dataDir,runner});assert.equal(newer.render().jobs.length,0);assert.equal((await newer.step()).count,2);
  }finally{store.close();}
});

test('手动重试将失败和待重试改为等待分析，计数守恒且可领取，不动完成/在途/旧版本/预算和原失败证据',()=>{
 const {store,worker}=setup();try{
  store.importPayload(capture([job('a_retry'),job('b_failed'),job('c_done'),job('d_running'),job('e_deferred')]));worker.claim(5);
  const db=store.db;db.prepare("UPDATE match_runs SET state='retry',error='codex_turn_failed',retry_at=?,attempts=2 WHERE id='boss:a_retry'").run(Date.now()+3600000);
  db.exec("UPDATE match_runs SET state='failed',error='evidence_not_grounded',attempts=3 WHERE id='boss:b_failed'; UPDATE match_runs SET state='completed',result='{}',lease=NULL WHERE id='boss:c_done'; UPDATE intake_analysis_queue SET state='deferred' WHERE id='boss:e_deferred'; UPDATE match_runs SET state='retry' WHERE id='boss:e_deferred';");
  const a=db.prepare("SELECT * FROM match_runs WHERE id='boss:a_retry'").get();
  db.prepare('INSERT INTO match_runs(dataset,id,fingerprint,profile,state,updated) VALUES(?,?,?,?,?,?)').run(a.dataset,a.id,a.fingerprint,'old-profile','failed',1);
  db.prepare('INSERT INTO match_runs(dataset,id,fingerprint,profile,state,updated) VALUES(?,?,?,?,?,?)').run(a.dataset,a.id,'old-fingerprint',a.profile,'retry',1);
  const preserved=db.prepare("SELECT * FROM match_runs WHERE id IN ('boss:c_done','boss:d_running','boss:e_deferred') OR profile='old-profile' OR fingerprint='old-fingerprint' ORDER BY id,profile,fingerprint").all(),used=worker.status().daily_used;
  assert.deepEqual(worker.retryFailed(),{matching:2,greeting:0,total:2});
  const counts=Object.fromEntries(worker.status().states.map(s=>[s.state,s.count]));assert.equal(counts.pending,2);assert.equal(counts.retry||0,0);assert.equal(counts.failed||0,0);assert.equal(counts.running,1);assert.equal(counts.completed,1);
  assert.equal(worker.status().daily_used,used);assert.deepEqual(db.prepare("SELECT * FROM match_runs WHERE id IN ('boss:c_done','boss:d_running','boss:e_deferred') OR profile='old-profile' OR fingerprint='old-fingerprint' ORDER BY id,profile,fingerprint").all(),preserved);
  const reset=db.prepare("SELECT * FROM match_runs WHERE id='boss:a_retry' AND profile=? AND fingerprint=?").get(worker.profileHash,a.fingerprint);assert.equal(reset.attempts,0);assert.equal(reset.retry_at,0);assert.equal(reset.lease,null);assert.equal(reset.error,'codex_turn_failed');
  assert.deepEqual(worker.retryFailed(),{matching:0,greeting:0,total:0});assert.equal(worker.claim(2).rows.length,2);assert.equal(worker.status().daily_used,used+2);
 }finally{store.close();}
});

test('招呼手动重试回到等待生成，保留完成的匹配结论及草稿，不重新匹配',async()=>{
 const {store,worker}=setup();try{
  store.importPayload(capture([job('a'),job('b'),job('c')]));await worker.step(3);
  for(const r of worker.greetingRows())store.db.prepare('INSERT INTO greeting_runs(dataset,id,fingerprint,profile,style,state,attempts,retry_at,updated,error,result) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(r.dataset,r.id,r.fingerprint,r.profile,worker.styleHash,r.id==='boss:a'?'retry':r.id==='boss:b'?'failed':'completed',2,Date.now()+3600000,Date.now(),'codex_turn_failed',r.id==='boss:c'?'{}':null);
  const before=store.db.prepare('SELECT * FROM match_runs ORDER BY id').all(),done=store.db.prepare("SELECT * FROM greeting_runs WHERE id='boss:c'").get(),used=worker.status().daily_used;
  assert.deepEqual(worker.retryFailed(),{matching:0,greeting:2,total:2});
  const counts=Object.fromEntries(worker.status().greeting_states.map(s=>[s.state,s.count]));assert.equal(counts.pending,2);assert.equal(counts.retry||0,0);assert.equal(counts.failed||0,0);assert.equal(counts.completed,1);
  assert.deepEqual(store.db.prepare('SELECT * FROM match_runs ORDER BY id').all(),before);assert.deepEqual(store.db.prepare("SELECT * FROM greeting_runs WHERE id='boss:c'").get(),done);assert.equal(worker.status().daily_used,used);
  assert.ok(worker.claimGreeting().row);assert.equal(worker.claim().rows.length,0);
 }finally{store.close();}
});
test('结果拒绝虚构引文、事实、错ID、少结果、重复结果；提示词明确不可信输入',()=>{
  const j=job(),good={results:[result(j)]};assert.equal(validateResults(good,[j],profile).length,1);
  for(const mutate of [r=>{r.results=[];},r=>{r.results[0].id='bad';},r=>{r.results[0].evidence[0].fact_id='FAKE';},r=>{r.results[0].evidence[0].jd_quote='不存在的引文';},r=>{r.results[0].greeting_fact_ids=['FAKE'];}]){const r=structuredClone(good);mutate(r);assert.throws(()=>validateResults(r,[j],profile));}
  assert.match(promptFor(profile,[j]),/不可信资料/);assert.match(promptFor(profile,[j]),/不调用工具/);
});
test('Codex子进程中文流、结构化输出、退出失败、超时和工具调用防误报',async()=>{
  const cwd=mkdtempSync(join(tmpdir(),'boss-runner-'));
  function fake(events,code=0,hang=false){return (binary,args)=>{
    assert.ok(args.includes('read-only'));assert.ok(args.includes('features.shell_tool=false'));assert.ok(!args.includes('--ignore-user-config'));
    const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{queueMicrotask(()=>child.emit('close',null));}});
    child.stdin.on('finish',()=>{if(hang)return;const bytes=Buffer.from(events.map(e=>JSON.stringify(e)+'\n').join(''));for(let i=0;i<bytes.length;i+=2)child.stdout.write(bytes.subarray(i,i+2));queueMicrotask(()=>child.emit('close',code));});return child;
  };}
  const events=[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({results:[result(job())]})}},{type:'turn.completed',usage:{output_tokens:1}}];
  const output=await runCodex(profile,[job()],{cwd,spawnProcess:fake(events)});assert.equal(output.output.results[0].priority,'可以尝试');
  await assert.rejects(runCodex(profile,[job()],{cwd,spawnProcess:fake(events,1)}),/codex_no_valid_completion/);
  await assert.rejects(runCodex(profile,[job()],{cwd,timeoutMs:10,spawnProcess:fake([],0,true)}),/codex_timeout/);
  await assert.rejects(runCodex(profile,[job()],{cwd,spawnProcess:fake([{type:'item.started',item:{type:'mcp_tool_call'}}])}),/unexpected_tool_use/);
  await assert.rejects(runCodex(profile,[job()],{cwd,spawnProcess:fake([{type:'error',message:'stream disconnected (os error 10051)'}])}),/codex_network_unavailable/);
});
test('最后一次租约过期明确失败而非永远重试等待',()=>{
  const {store,worker}=setup();try{
    store.importPayload(capture([job()]));worker.claim();store.db.exec("UPDATE match_runs SET attempts=3,retry_at=0");
    assert.equal(worker.claim().rows.length,0);assert.equal(worker.status().states[0].state,'failed');
  }finally{store.close();}
});

test('模型超时后等待子进程close才reject，不能提前归还并发令牌',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'runner-close-test-'));let child,killed=false,settled=false;
 const promise=runCodex(profile,[job()],{cwd,timeoutMs:10,spawnProcess:()=>{
  child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{killed=true;}});return child;
 }}).then(()=>{settled=true;},e=>{settled=true;assert.match(e.message,/codex_timeout/);});
 await new Promise(r=>setTimeout(r,30));assert.equal(killed,true);assert.equal(settled,false);child.emit('close',null);await promise;assert.equal(settled,true);
});
