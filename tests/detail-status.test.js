import test from 'node:test';
import assert from 'node:assert/strict';
import {detailState,detailSummary,detailRows,jobAvailability,collectionOverview} from '../local/detail-status.mjs';
import {IntakeStore} from '../local/intake.mjs';
import {applyActivityCapture} from '../shared/activity.js';

const job=(id,extra={})=>({id:'boss:'+id,url:`https://www.zhipin.com/job_detail/${id}.html`,title:'合成产品经理',jd:'',jd_status:'missing',...extra});
test('正文状态互斥可加总，已关闭但有正文仍算正文已采集；岗位状态独立',()=>{
 const now=1000,closed={recruitment_signals:{availability:{value:'explicit_unavailable'}}};
 const samples=[[job('a',{jd:'短描述',jd_status:'short_unverified'}),{state:'pending'},'captured'],[job('b',closed),{state:'pending'},'closed'],[job('c',{link_access:{state:'unavailable'}}),{state:'pending'},'unavailable'],[job('d'),{state:'pending',retry_at:now},'pending'],[job('e'),{state:'pending',retry_at:now+1},'waiting_retry'],[job('f'),{state:'review'},'review'],[job('g'),null,'unqueued'],[job('h',{...closed,jd:'短描述',jd_status:'short_unverified'}),{state:'pending'},'captured']];
 const rows=samples.map(([j,q,state])=>{assert.equal(detailState(j,q,now),state);return {detail_state:state,detail_retry_at:q?.retry_at||0};});
 const s=detailSummary(rows);assert.equal(s.total,s.captured+s.missing);assert.equal(s.missing,s.pending+s.waiting_retry+s.review+s.closed+s.unavailable+s.unqueued);assert.equal(s.nextRetryAt,1001);assert.equal(jobAvailability(samples[7][0]),'closed');
 assert.equal(detailState(job('invalid',{url:'https://example.org'}),{state:'pending'},now),'review');
});
test('顶部概览互斥可加总，有正文但关闭或不可用只归终止项，无正文正常项计待采',()=>{
 const closed={recruitment_signals:{availability:{value:'explicit_unavailable'}}},body={jd:'原文',jd_status:'short_unverified'};
 const rows=[job('a',body),job('b',{...body,...closed}),job('c',{...body,link_access:{state:'unavailable'}}),job('d',closed),job('e')].map(job=>({job}));
 assert.deepEqual(collectionOverview(rows),{total:5,collected:1,terminal:3,awaiting:1,closed:2,unavailable:1});
 const o=collectionOverview(rows);assert.equal(o.total,o.collected+o.terminal+o.awaiting);assert.equal(o.terminal,o.closed+o.unavailable);assert.equal(rows[1].job.jd,'原文');
});

test('同数据集同岗位关闭证据更新，历史正文和联系保留；空列表不抹掉关闭状态',()=>{
 const store=new IntakeStore(':memory:');
 try{
  const j=job('a',{jd:'已有正文',jd_status:'short_unverified',contact_status:'contacted'});
  store.importPayload({schema_version:2,label:'A',exported_at:'2026-10-01T01:00:00Z',jobs:[j]});
  const c={status:'job_unavailable',source_url:j.url,jobs:[{url:j.url,recruitment_signals:{availability:[{text:'该职位已关闭',selector:'.status'}]}}]};
  const next=applyActivityCapture({jobs:{[j.id]:store.get('A',j.id)}},c,j.id,'2026-10-01T02:00:00Z').dataset.jobs[j.id];
  store.importPayload({schema_version:2,label:'A',exported_at:'2026-10-01T02:00:00Z',jobs:[next]});
  const r=detailRows(store,'A')[0];assert.equal(jobAvailability(r.job),'closed');assert.equal(r.detail_state,'captured');assert.equal(r.job.jd,j.jd);assert.equal(r.job.contact_status,'contacted');
  assert.equal(store.db.prepare('SELECT reason FROM intake_analysis_queue').get().reason,'closed');
  store.importScraper({list:{scraped_at:'2026-10-01T03:00:00Z',jobs:[{title:j.title,job_link:j.url,encrypt_job_id:'a'}]},label:'A',timezoneOffset:'+08:00'});
  assert.equal(jobAvailability(store.get('A',j.id)),'closed');assert.equal(detailRows(store,'B').length,0);
 }finally{store.close();}
});
