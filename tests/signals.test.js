import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCapture, emptyDataset, migrateDataset, csv, exportData} from '../shared/core.js';
import {followUpPlan} from '../shared/legacy-export.js';
import {signalSnapshot} from '../shared/signals.js';
import {validateIdentity} from '../shared/identity.js';
const url = 'https://www.zhipin.com/job_detail/a.html';
const raw = {url, title: '产品经理', jd: '产品工作内容'.repeat(40)};
const evidence = text => [{text, selector: '.boss-info span'}];
const capture = (signals, extra = {}) => ({source_url: url, page_type: 'detail', status: 'captured', jobs: [{...raw, recruitment_signals: signals}], ...extra});
const t1 = '2026-09-29T01:00:00Z', t2 = '2026-09-30T01:00:00Z';

test('活动原文+观察时间+净化来源留存；不将今日活跃转成精确上线时间', () => {
  const r = applyCapture(emptyDataset('A'), capture({recruiter_activity: evidence('今日活跃')}, {source_url: url + '?securityId=secret'}), t1);
  const j = r.dataset.jobs['boss:a'];
  assert.deepEqual(j.recruitment_signals.recruiter_activity.raw, ['今日活跃']);
  assert.equal(j.recruitment_signals.checked_at, t1);
  assert.equal(j.recruitment_signals.source_url, url);
  assert.equal(j.recruitment_signals.availability.value, 'unknown');
  assert.equal(j.recruitment_signals_detail_checked_at, t1);
  assert.equal(JSON.stringify(j).includes('secret'), false);
  assert.equal(j.recruiter_last_online_at, undefined);
});

test('最新未读取到标未知；旧状态保留原观察时间，不能冒充最新', () => {
  const a = applyCapture(emptyDataset('A'), capture({recruiter_activity: evidence('今日活跃')}), t1);
  const b = applyCapture(a.dataset, capture({}), t2).dataset.jobs['boss:a'];
  assert.equal(b.recruitment_signals.recruiter_activity.state, 'unknown');
  assert.equal(b.recruitment_signal_history[0].checked_at, t1);
  assert.deepEqual(b.recruitment_signal_history[0].recruiter_activity.raw, ['今日活跃']);
  assert.equal(b.recruitment_signals.checked_at, t2);
  assert.equal(b.first_seen_at, t1); assert.equal(b.last_seen_at, t2);
});

test('历史有界；JSON和CSV保留信号，未识别可区分', () => {
  let d = emptyDataset('A');
  for (let i = 0; i < 15; i++) d = applyCapture(d, capture({recruiter_activity: evidence('较久未活跃')}), `2026-09-29T01:00:${String(i).padStart(2, '0')}Z`).dataset;
  const exported = exportData(d);
  assert.equal(exported.jobs[0].recruitment_signal_history.length, 10);
  assert.ok(csv(d).includes('recruiter_activity_raw')); assert.ok(csv(d).includes('较久未活跃')); assert.ok(csv(d).includes('未知'));
});

test('关闭页无标题只更新已有同ID状态，不覆盖JD；伪造或未入库ID不建档', () => {
  const before = applyCapture(emptyDataset('A'), capture({}), t1).dataset;
  const stopped = {source_url: url, page_type: 'detail', status: 'job_unavailable', jobs: [{url, title: '', recruitment_signals: {availability: evidence('该职位已关闭')}}]};
  validateIdentity(stopped, before.jobs['boss:a']);
  const after = applyCapture(before, stopped, t2);
  assert.equal(after.run.matched, 1); assert.equal(after.run.added, 0);
  assert.equal(after.dataset.jobs['boss:a'].jd, raw.jd);
  assert.equal(after.dataset.jobs['boss:a'].recruitment_signals.availability.value, 'explicit_unavailable');
  assert.equal(after.dataset.jobs['boss:a'].last_seen_at, t2);
  const queued = {...after.dataset, batch_runs: [{id: 's', kind: 'search', seen_job_ids: ['boss:a']}]};
  assert.equal(followUpPlan(queued).jobs.length, 0);
  assert.equal(applyCapture(emptyDataset('A'), stopped).run.matched, 0);
  assert.equal(applyCapture(before, {...stopped, source_url: url.replace('/a.', '/b.')}).run.matched, 0);
  assert.throws(() => validateIdentity({...stopped, jobs: [{...stopped.jobs[0], title: '其他岗位'}]}, before.jobs['boss:a']), /名称/);
});

test('验证状态即使带关闭标签也不能写入；冲突状态不强判为关闭', () => {
  const d = applyCapture(emptyDataset('A'), capture({}), t1).dataset;
  const after = applyCapture(d, capture({availability: evidence('该职位已关闭')}, {status: 'blocked'}), t2);
  assert.equal(after.run.matched, 0); assert.deepEqual(after.dataset.jobs, d.jobs);
  assert.equal(signalSnapshot({availability: [...evidence('职位已关闭'), ...evidence('招聘中')]}, {}).availability.value, 'conflicting');
});

test('旧版升级不编造活跃记录；已存正文也补读一次状态，未知不无限重试', () => {
  const old = {schema_version: 2, collector_version: '0.4.1', jobs: {'boss:a': {...raw, id: 'boss:a', jd_status: 'captured_unverified'}}, runs: [], batch_runs: [{id: 's', kind: 'search', seen_job_ids: ['boss:a']}]};
  const d = migrateDataset(old);
  assert.equal(d.jobs['boss:a'].recruitment_signals.checked_at, null);
  assert.equal(followUpPlan(d).jobs.length, 1);
  const after = applyCapture(d, capture({}), t1).dataset;
  assert.equal(followUpPlan(after).jobs.length, 0);
  assert.equal(after.jobs['boss:a'].jd, raw.jd);
});

test('反复滚动列表不会挤掉上次详情活跃证据；详情时间不被列表时间刷新', () => {
  let d = applyCapture(emptyDataset('A'), capture({recruiter_activity: evidence('今日活跃')}), t1).dataset;
  for (let i = 0; i < 20; i++) d = applyCapture(d, capture({}, {page_type: 'list'}), `2026-09-30T01:00:${String(i).padStart(2, '0')}Z`).dataset;
  const j = d.jobs['boss:a'];
  assert.equal(j.recruitment_signals.recruiter_activity.state, 'unknown');
  assert.equal(j.recruitment_signals_by_page.detail.checked_at, t1);
  assert.deepEqual(j.recruitment_signals_by_page.detail.recruiter_activity.raw, ['今日活跃']);
  assert.equal(j.recruitment_signals_detail_checked_at, t1);
});
