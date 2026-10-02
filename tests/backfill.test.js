import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mergeBackfill,missingFields} from '../local/backfill.mjs';
import {IntakeStore} from '../local/intake.mjs';
import {Collector} from '../local/collector.mjs';
const job={id:'boss:abc',url:'https://www.zhipin.com/job_detail/abc.html',title:'产品经理',company:'',salary:'20-25K',jd:'负责需求分析和产品设计。'.repeat(40),jd_status:'captured_unverified',contact_status:'contacted'};
const capture={source_url:job.url,status:'captured',jobs:[{...job,company:'测试公司',company_evidence:{text:'测试公司',selector:'.company-name'},recruitment_signals:{recruiter_activity:[{text:'今日活跃',selector:'.boss-active-time'}]}}]};
test('定向补公司和活跃，保留JD、薪资、联系状态，不接受错页或不同标题',()=>{
 const next=mergeBackfill(job,capture);
 assert.equal(next.company,'测试公司');assert.equal(next.activity_check.state,'found');
 for(const key of ['jd','salary','contact_status','title','url'])assert.equal(next[key],job[key]);
 assert.equal(missingFields(next).length,0);
 assert.throws(()=>mergeBackfill(job,{...capture,source_url:'https://www.zhipin.com/job_detail/other.html'}),/page_changed/);
 assert.throws(()=>mergeBackfill(job,{...capture,jobs:[{...capture.jobs[0],title:'销售'}]}),/identity_conflict/);
 assert.throws(()=>mergeBackfill(job,{...capture,status:'blocked'}),/not_readable/);
});
test('页面不展示保留未知；已有公司不覆盖；确认关闭岗位不进入补采',()=>{
 const next=mergeBackfill({...job,company:'原公司'},{...capture,jobs:[{...job,recruitment_signals:{}}]});
 assert.equal(next.company,'原公司');assert.equal(next.activity_check.state,'needs_review');
 assert.deepEqual(missingFields({...job,link_access:{state:'unavailable'}}),[]);
 assert.deepEqual(missingFields({...job,company_check:{state:'unavailable'}}),[]);
});

test('已验证未展示是完成态；不按猎头身份推断，其他缺失字段仍可补',()=>{
 for(const type of ['headhunter','agency']){
  const j={...job,hiring_party:{type,evidence:[{field:'type',text:type==='headhunter'?'猎头':'代招',selector:'.badge'}]},activity_check:{state:'not_displayed',reason:'recruiter_panel_without_activity'}};
  assert.deepEqual(missingFields(j),[]);
  assert.deepEqual(missingFields({...j,activity_check:undefined}),['activity']);
  assert.deepEqual(missingFields({...j,activity_check:{state:'needs_review'}}),['activity']);
 }
 const j={...job,activity_check:{state:'not_displayed',reason:'recruiter_panel_without_activity'}};
 assert.deepEqual(missingFields(j),['company']);
 const next=mergeBackfill(j,capture);assert.deepEqual(next.activity_check,j.activity_check);assert.equal(next.company,'测试公司');
});

test('验证即暂停且不改岗位；采集中修改联系状态不会被补采覆盖',async()=>{
 const store=new IntakeStore(':memory:'),dir=mkdtempSync(join(tmpdir(),'backfill-gate-'));
 store.importPayload({schema_version:2,label:'我的求职',exported_at:new Date().toISOString(),jobs:[job]});
 let result={ok:false,error:'verification_required'};
 const c=new Collector(store,{settings:{autoAnalyze:false,keywords:[]}},{dataDir:dir,browser:async()=>{},runner:async()=>{
  if(result.ok){const current=store.get('我的求职',job.id);store.importPayload({schema_version:2,label:'我的求职',exported_at:new Date().toISOString(),jobs:[{...current,contact_status:'manual-updated'}]});}
  return result;
 }});
 try{
  const before=JSON.stringify(store.get('我的求职',job.id));c.backfill();await c.promise;
  assert.equal(c.config.blocked,'verification_required');assert.equal(c.status().history[0].state,'needs_attention');assert.equal(JSON.stringify(store.get('我的求职',job.id)),before);
  result={ok:true,payload:capture};c.backfill();await c.promise;
  assert.equal(c.config.blocked,null);assert.equal(store.get('我的求职',job.id).contact_status,'manual-updated');
 }finally{await c.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
test('补采持有采集锁、回写最新记录、不更改自动分析与定时设置',async()=>{
 const store=new IntakeStore(':memory:'),dir=mkdtempSync(join(tmpdir(),'backfill-test-'));
 store.importPayload({schema_version:2,label:'我的求职',exported_at:new Date().toISOString(),jobs:[job]});
 const controller={settings:{autoAnalyze:false,keywords:[]}};
 const c=new Collector(store,controller,{dataDir:dir,browser:async()=>{},runner:async()=>({ok:true,payload:capture})});
 try{
  const config=JSON.stringify(c.config);c.backfill();assert.throws(()=>c.start(),/busy/);assert.throws(()=>c.backfill(),/busy/);await c.promise;
  assert.equal(c.status().history[0].activityFound,1);assert.equal(c.status().history[0].companyResolved,1);
  assert.equal(store.get('我的求职',job.id).company,'测试公司');assert.equal(controller.settings.autoAnalyze,false);assert.equal(JSON.stringify(c.config),config);
 }finally{await c.close();store.close();rmSync(dir,{recursive:true,force:true});}
});

test('浏览器断连立即暂停，连续读取失败三次停止，不消耗剩余队列',async()=>{
 for(const error of ['browser_unavailable','capture_not_readable']){
  const store=new IntakeStore(':memory:'),dir=mkdtempSync(join(tmpdir(),'backfill-circuit-'));
  const jobs=Array.from({length:5},(_,i)=>({...job,id:'boss:job'+i,url:`https://www.zhipin.com/job_detail/job${i}.html`}));
  store.importPayload({schema_version:2,label:'我的求职',exported_at:new Date().toISOString(),jobs});
  let calls=0;const c=new Collector(store,{settings:{autoAnalyze:false,keywords:[]}},{dataDir:dir,browser:async()=>{},runner:async()=>{calls++;return {ok:false,error};}});c.backfillDelayMs=0;
  try{
    const before=JSON.stringify(store.get('我的求职',jobs[0].id));c.backfill();await c.promise;
    const run=c.status().history[0];assert.equal(run.state,'needs_attention');
    assert.equal(calls,error==='browser_unavailable'?1:3);assert.equal(run.remaining,error==='browser_unavailable'?5:2);
    assert.equal(c.config.blocked,error==='browser_unavailable'?'browser_unavailable':'backfill_repeated_failure');
    assert.equal(JSON.stringify(store.get('我的求职',jobs[0].id)),before);
  }finally{await c.close();store.close();rmSync(dir,{recursive:true,force:true});}
 }
});

test('页面未展示按原因计数，与读取失败和公司缺失分开',async()=>{
 const store=new IntakeStore(':memory:'),dir=mkdtempSync(join(tmpdir(),'backfill-absent-'));
 store.importPayload({schema_version:2,label:'我的求职',exported_at:new Date().toISOString(),jobs:[{...job,company:'原公司'}]});
 const payload={...capture,jobs:[{...capture.jobs[0],recruitment_signals:{}}],diagnostics:{activity_settled:true,activity:{recruiter_panel_ready:true,unrecognized_labels:[]}}};
 const c=new Collector(store,{settings:{autoAnalyze:false,keywords:[]}},{dataDir:dir,browser:async()=>{},runner:async()=>({ok:true,payload})});
 try{c.backfill();await c.promise;const run=c.status().history[0];assert.equal(run.activityMissing,0);assert.equal(run.activityNotDisplayed,1);assert.equal(run.companyMissing,0);assert.equal(run.failedDetails,0);assert.equal(run.state,'completed');assert.equal(run.unresolved,0);
  assert.deepEqual(missingFields(store.get('我的求职',job.id)),[]);
  c.browser=async()=>{throw new Error('should_not_open_browser');};c.runner=async()=>{throw new Error('should_not_retry');};
  c.backfill();await c.promise;const repeated=c.status().history[0];assert.equal(repeated.detailTotal,0);assert.equal(repeated.state,'completed');
 }
 finally{await c.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
