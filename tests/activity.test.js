import test from 'node:test';
import assert from 'node:assert/strict';
import {applyActivityCapture, needsActivity} from '../shared/activity.js';
import {migrateDataset, VERSION} from '../shared/core.js';
import {followUpPlan} from '../shared/legacy-export.js';
import {activityDisplay,activityReport} from '../local/activity-display.mjs';
import {analysisInput, IntakeStore} from '../local/intake.mjs';

const at = '2026-09-30T02:00:00Z';
const snapshot = (raw = []) => ({checked_at: '2026-09-28T01:00:00Z', page_type: 'detail', recruiter_activity: {raw}});
const job = (id, extra = {}) => ({id: 'boss:' + id, url: `https://www.zhipin.com/job_detail/${id}.html`, title: '产品经理', company: '公司',
  jd: '完整原始JD'.repeat(40), jd_status: 'captured_unverified', contact_status: 'contacted', first_seen_at: 'old', last_seen_at: 'old',
  recruitment_signals_detail_checked_at: 'old', seen_count: 2, ...extra});
const dataset = jobs => migrateDataset({schema_version: 2, label: 'A', jobs: Object.fromEntries(jobs.map(j => [j.id, j])), runs: [], batch_runs: []});
const capture = (j, text = '今日活跃') => ({status: 'captured', page_type: 'detail', source_url: j.url, jobs: [{...j, jd: '不能覆盖',
  recruitment_signals: {recruiter_activity: text ? [{text, selector: '.boss-info .active-text'}] : []}}]});

test('活跃队列独立于完整JD，包含猎头代招，跳过已有证据和关闭，支持上限/续采/复查', () => {
  const d = dataset([job('a'), job('b', {hiring_party: {type: 'headhunter'}}), job('c', {hiring_party: {type: 'agency'}}),
    job('d', {recruitment_signals: snapshot(['在线'])}), job('e', {recruitment_signals_by_page: {detail: snapshot(['本周活跃'])}}),
    job('f', {recruitment_signal_history: [snapshot(['今日活跃'])]}), job('g', {activity_check: {state: 'needs_review'}}),
    job('closed', {recruitment_signals: {availability: {value: 'explicit_unavailable'}}}), job('missing', {link_access: {state: 'unavailable'}})]);
  const p = followUpPlan(d, null, false, 2, 'activity');
  assert.equal(p.pending, 3); assert.equal(p.deferred, 1); assert.equal(p.review_pending, 1);
  assert.deepEqual(p.jobs.map(j => j.id), ['boss:a', 'boss:b']);
  assert.deepEqual(followUpPlan(d, null, true, null, 'activity').jobs.map(j => j.id), ['boss:g']);
  assert.equal(followUpPlan(d, null, false, null, 'dataset').pending, 0);
  assert.throws(() => followUpPlan(d, 'search1', false, null, 'activity'), /不能同时/);
});

test('只保存新的活跃证据和时间，不覆盖原字段，不改变分析输入，后续空列表显示历史', () => {
  const d = dataset([job('a')]), before = structuredClone(d.jobs['boss:a']);
  const r = applyActivityCapture(d, capture(before), before.id, at), saved = r.dataset.jobs[before.id];
  for (const [key, value] of Object.entries(before)) assert.deepEqual(saved[key], value, key);
  assert.deepEqual(d.jobs[before.id], before); assert.deepEqual(analysisInput(saved), analysisInput(before));
  assert.equal(saved.activity_check.state, 'found'); assert.equal(needsActivity(saved), false);
  assert.equal(activityDisplay(saved).observed_at, at); assert.deepEqual(activityDisplay(saved).raw, ['今日活跃']);
  assert.equal(activityDisplay({...saved, recruitment_signals: {...snapshot(), checked_at: '2026-09-30T03:00:00Z'}}).state, 'historical');
  assert.equal(migrateDataset(r.dataset).jobs[before.id].activity_check.observed_at, at);
});

test('补采导入不重排AI，不清沟通；明确关闭仍进入暂缓', () => {
  const store = new IntakeStore(':memory:');
  try {
    const d = dataset([job('a')]), j = d.jobs['boss:a'];
    const payload = (value, time) => ({schema_version: 2, label: 'A', exported_at: time, jobs: [value]});
    store.importPayload(payload(j, '2026-09-30T01:00:00Z'));
    const before = store.db.prepare('SELECT * FROM intake_analysis_queue').get();
    const saved = applyActivityCapture(d, capture(j), j.id, at).dataset.jobs[j.id];
    assert.equal(store.importPayload(payload(saved, at)).queued, 0);
    assert.deepEqual(store.db.prepare('SELECT * FROM intake_analysis_queue').get(), before);
    assert.equal(store.get('A', j.id).contact_status, 'contacted');
    assert.equal(activityDisplay(store.get('A', j.id)).state, 'observed');
    const closed = capture(j, ''); closed.status = 'job_unavailable';
    closed.jobs[0].recruitment_signals.availability = [{text: '职位已关闭', selector: '.job-status'}];
    const result = applyActivityCapture(d, closed, j.id, at);
    store.importPayload(payload(result.dataset.jobs[j.id], '2026-09-30T03:00:00Z'));
    assert.equal(store.db.prepare('SELECT reason FROM intake_analysis_queue').get().reason, 'closed');
    assert.equal(result.dataset.jobs[j.id].jd, j.jd);
  } finally { store.close(); }
});

test('未读到和名称冲突可复查，错ID/无关闭证据拒绝；登录验证不保存检查', () => {
  const d = dataset([job('a')]), j = d.jobs['boss:a'];
  for (const status of ['captured', 'empty', 'identity_conflict']) {
    const c = {...capture(j, ''), status};
    if (status === 'identity_conflict') c.jobs = [];
    const saved = applyActivityCapture(d, c, j.id, at).dataset.jobs[j.id];
    assert.equal(saved.activity_check.state, 'needs_review'); assert.equal(needsActivity(saved), false);
    assert.equal(activityDisplay(saved).state, 'unknown');
    assert.equal(activityDisplay(saved).reason, status === 'identity_conflict' ? 'identity_conflict' : 'not_observed');
  }
  assert.throws(() => applyActivityCapture(d, capture(job('other')), j.id), /身份/);
  assert.throws(() => applyActivityCapture(d, {...capture(j), jobs: [job('other')]}, j.id), /身份/);
  assert.throws(() => applyActivityCapture(d, {...capture(j), status: 'job_unavailable'}, j.id), /证据/);
  for (const status of ['blocked', 'login_required', 'unsupported'])
    assert.equal(applyActivityCapture(d, {...capture(j), status}, j.id).dataset, d);
});

test('只有招聘者区块加载且等待完成才标页面未展示，未知标签单独待核查',()=>{
 const d=dataset([job('a')]),j=d.jobs['boss:a'];
 const c={...capture(j,''),diagnostics:{activity_settled:true,activity:{recruiter_panel_ready:true,unrecognized_labels:[]}}};
 const saved=applyActivityCapture(d,c,j.id,at).dataset.jobs[j.id];
 assert.equal(saved.activity_check.state,'not_displayed');assert.equal(needsActivity(saved),false);
 assert.equal(activityDisplay(saved).state,'unknown');assert.equal(activityDisplay(saved).reason,'not_displayed');
 assert.match(activityReport(saved),/页面未展示/);assert.deepEqual(analysisInput(saved),analysisInput(j));
 for(const diagnostics of [{},{activity_settled:false,activity:{recruiter_panel_ready:true,unrecognized_labels:[]}},{activity_settled:true,activity:{recruiter_panel_ready:false,unrecognized_labels:[]}}])
   assert.equal(applyActivityCapture(d,{...c,diagnostics},j.id,at).dataset.jobs[j.id].activity_check.state,'needs_review');
 c.diagnostics.activity.unrecognized_labels=['未适配时间标签'];
 const unknown=applyActivityCapture(d,c,j.id,at).dataset.jobs[j.id];
 assert.equal(unknown.activity_check.state,'needs_review');assert.equal(activityDisplay(unknown).reason,'label_unrecognized');
});
