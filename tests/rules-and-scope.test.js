import test from 'node:test';
import assert from 'node:assert/strict';
import {compareTitles, displayJD} from '../shared/text-rules.js';
import {VERSION, clean, classifyJD, normalizeJob, migrateDataset, needsDetail, applyCapture} from '../shared/core.js';
import {validateIdentity} from '../shared/identity.js';
import {followUpPlan} from '../shared/legacy-export.js';

const job = (id = 'a', extra = {}) => ({id: `boss:${id}`, url: `https://www.zhipin.com/job_detail/${id}.html`, title: '产品经理（电子烟）', jd: '', jd_status: 'missing', seen_count: 1, ...extra});
const dataset = jobs => ({schema_version: 2, label: 'A', jobs: Object.fromEntries(jobs.map(j => [j.id, j])), runs: [], batch_runs: []});
const conflict = (j, extra = {}) => ({state: 'needs_review', reason: 'same_id_title_conflict', identity_conflict: {expected_id: j.id, observed_id: j.id, expected_title: j.title, observed_title: j.title + '（出差美国）', ...extra}});

test('末尾出差驻地附注精确匹配，行业职级和多个附注不能模糊放行', () => {
  const title = job().title;
  assert.equal(compareTitles(title, '产品经理 (电子烟)').kind, 'exact');
  for (const note of ['（出差美国）', '（驻中国香港）', '（出差英国等）']) {
    assert.equal(compareTitles(title, title + note).kind, 'travel_suffix');
    assert.equal(compareTitles(title + note, title).kind, 'travel_suffix');
  }
  for (const other of ['产品经理', '产品总监（电子烟）（出差美国）', title + '（高级）', title + '（美国）', title + '（出差美国）（驻中国香港）', '']) {
    assert.equal(compareTitles(title, other).kind, 'conflict');
  }
  const j = job(), c = {status: 'captured', source_url: j.url, jobs: [{...j, title: title + '（出差美国）'}]};
  assert.equal(validateIdentity(c, j).kind, 'travel_suffix');
  for (const bad of [{...c, source_url: job('b').url}, {...c, jobs: [{...c.jobs[0], url: job('b').url}]}, {...c, jobs: [c.jobs[0], c.jobs[0]]}]) assert.throws(() => validateIdentity(bad, j));
});

test('归一化已知行首符号和文本间Word圆点，原JD不改、数字及未知字符仍标异常', () => {
  for (const marker of ['\uF0B7', '\uF0FC', '\uF09F', '\uF077', '\uF06C']) {
    const raw = marker + '职责：' + '业务设计'.repeat(40) + '\n  ' + marker + '\n材料审核';
    assert.equal(classifyJD(raw), 'captured_unverified');
    const n = normalizeJob({...job(), jd: raw, salary: '\uF0B7'}, {page_type: 'detail', observed_at: 'now', url: job().url});
    assert.equal(n.jd, clean(raw)); assert.equal(n.jd_display, displayJD(clean(raw)));
    assert.ok(n.quality_flags.includes('salary_encoded_font'));
    assert.ok(n.quality_flags.includes('jd_list_symbols_normalized'));
    assert.ok(!n.quality_flags.includes('jd_encoded_font'));
    assert.equal(classifyJD('要求：' + marker + '经验'), marker==='\uF0B7'?'short_unverified':'partial');
    assert.equal(classifyJD('12' + marker + '万'), 'partial');
    assert.equal(classifyJD(raw, true), 'partial');
    assert.equal(classifyJD(raw + '展开全部'), 'partial');
    assert.equal(classifyJD(raw + '登录后查看'), 'partial');
  }
  assert.equal(classifyJD('\uE123职责'), 'partial');
});

test('历史修正规则幂等且不丢原证据，标题只重新入队、不冒充已采正文', () => {
  const a = job(), b = job('b', {jd: '\uF0B7\n职责：' + '产品设计'.repeat(40), jd_status: 'partial', recruitment_signals_detail_checked_at: 'old', detail_review: {state: 'needs_review', reason: 'partial_after_retries', attempts: 3}});
  a.detail_review = conflict(a);
  const badId = job('c'); badId.detail_review = conflict(badId, {observed_id: 'boss:other'});
  const changedTitle = job('d'); changedTitle.detail_review = conflict(changedTitle, {expected_title: '不同岗位'});
  const unknown = job('e', {...b, id: 'boss:e', url: job('e').url, jd: '\uE123' + b.jd});
  const truncated = job('f', {...b, id: 'boss:f', url: job('f').url, jd_truncated: true});
  const input = dataset([a, b, badId, changedTitle, unknown, truncated]);
  const before = structuredClone(input), next = migrateDataset(input);
  assert.deepEqual(input, before); assert.deepEqual(migrateDataset(next), next);
  assert.equal(next.jobs[a.id].detail_review.state, 'retry_ready');
  assert.equal(next.jobs[a.id].jd_status, 'missing');
  assert.equal(next.jobs[a.id].detail_review.requeued_by_version, VERSION);
  assert.deepEqual(next.jobs[a.id].detail_review.identity_conflict, a.detail_review.identity_conflict);
  assert.equal(next.jobs[b.id].jd, b.jd); assert.equal(next.jobs[b.id].jd_status, 'captured_unverified');
  assert.equal(next.jobs[b.id].detail_review.resolution, 'list_symbol_rule_updated');
  assert.equal(next.jobs[b.id].detail_review.attempts, 3);
  assert.equal(next.jobs[b.id].recruitment_signals_detail_checked_at, 'old');
  for (const j of [badId, changedTitle, unknown, truncated]) assert.equal(next.jobs[j.id].detail_review.state, 'needs_review');
  assert.equal(needsDetail(next.jobs[a.id]), true); assert.equal(needsDetail(next.jobs[b.id]), false);
  const captured = applyCapture(next, {source_url: a.url, page_type: 'detail', status: 'captured', jobs: [{...a, jd: '设计'.repeat(100)}]}, 'new');
  assert.equal(captured.dataset.jobs[a.id].detail_review.state, 'resolved');
});

test('全库不依赖搜索历史，普通和异常分流、有限快照与身份校验', () => {
  const d = migrateDataset(dataset([
    job('old'), job('new'), job('review', {detail_review: {state: 'needs_review'}}),
    job('done', {jd: '产品'.repeat(100), jd_status: 'captured_unverified', recruitment_signals_detail_checked_at: 'old'}),
    job('closed', {recruitment_signals_detail_checked_at: 'old', recruitment_signals: {availability: {value: 'explicit_unavailable'}}}),
    job('missing', {link_access: {state: 'unavailable'}})
  ]));
  assert.throws(() => followUpPlan(d), /尚无搜索/);
  const plan = followUpPlan(d, undefined, false, 1, 'dataset');
  assert.equal(plan.sourceBatchId, null); assert.equal(plan.pending, 2); assert.equal(plan.deferred, 1);
  assert.equal(plan.review_pending, 1); assert.deepEqual(Object.keys(plan.jobs[0]), ['id', 'title', 'url']);
  assert.deepEqual(followUpPlan(d, null, true, null, 'dataset').jobs.map(j => j.id), ['boss:review']);
  d.batch_runs.push({id: 's', kind: 'search', seen_job_ids: ['boss:new']});
  assert.equal(followUpPlan(d).pending, 1); assert.equal(followUpPlan(d, null, false, null, 'dataset').pending, 2);
  d.jobs['boss:later'] = job('later'); assert.equal(plan.jobs.length, 1);
  assert.throws(() => followUpPlan(d, 's', false, null, 'dataset'), /不能同时/);
  assert.throws(() => followUpPlan(d, null, false, null, 'unknown'), /范围无效/);
  d.jobs['boss:new'].id = 'boss:other';
  assert.throws(() => followUpPlan(d, null, false, null, 'dataset'), /不一致/);
});
