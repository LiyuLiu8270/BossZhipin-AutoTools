import test from 'node:test';
import assert from 'node:assert/strict';
import {applyCompanyCapture, needsCompany} from '../shared/company.js';
import {migrateDataset, VERSION} from '../shared/core.js';
import {followUpPlan} from '../shared/legacy-export.js';

const job = (id, extra = {}) => ({id: 'boss:' + id, url: `https://www.zhipin.com/job_detail/${id}.html`, title: '产品经理', company: '', jd: '原始JD'.repeat(40), jd_status: 'captured_unverified', contact_status: 'contacted', first_seen_at: 'old', last_seen_at: 'old', recruitment_signals_detail_checked_at: 'old', seen_count: 2, ...extra});
const dataset = jobs => migrateDataset({schema_version: 2, label: 'A', jobs: Object.fromEntries(jobs.map(j => [j.id, j])), runs: [], batch_runs: []});
const capture = (j, company = '合成公司') => ({status: 'captured', page_type: 'detail', source_url: j.url, jobs: [{...j, company, company_evidence: {text: company, selector: '.sider-company .company-name'}, jd: '不可覆盖旧JD', salary: '不可覆盖', title: '产品经理'}]});

const headhunter = {type: 'headhunter', evidence: [{field: 'type', text: '猎头', selector: 'img'}], observed_at: 'old', source_url: 'https://www.zhipin.com/job_detail/a.html'};
const agency = {...headhunter, type: 'agency', evidence: [{field: 'type', text: '代招', selector: 'img'}]};
test('代招也豁免公司缺失/普通与复查队列，保留公司原值、历史检查及JD要求', () => {
  const prior = {state: 'needs_review', reason: 'company_not_identified', observed_at: 'old'};
  const d = dataset([job('a', {hiring_party: agency, company_check: prior}), job('b', {hiring_party: agency}),
    job('c', {hiring_party: agency, company: '已知公司'}), job('d', {hiring_party: agency, jd: '', jd_status: 'missing'}), job('e')]);
  assert.equal(d.jobs['boss:a'].company_check.reason, 'agency_badge'); assert.equal(d.jobs['boss:a'].company_check.state, 'not_required');
  assert.deepEqual(d.jobs['boss:a'].company_check.previous_check, prior); assert.equal(d.jobs['boss:c'].company, '已知公司');
  assert.deepEqual(followUpPlan(d, null, false, null, 'company').jobs.map(j => j.id), ['boss:e']);
  assert.equal(followUpPlan(d, null, true, null, 'company').pending, 0);
  assert.deepEqual(followUpPlan(d, null, false, null, 'dataset').jobs.map(j => j.id), ['boss:d']);
  assert.deepEqual(migrateDataset(d), d);
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(d.jobs['boss:' + id].quality_flags.includes('company_missing'), false);
});

test('旧猎头公司缺失自动豁免，两种公司队列排除，历史检查保留且升级幂等', () => {
  const prior = {state: 'needs_review', reason: 'company_not_identified', observed_at: 'old', diagnostics: {groups: []}};
  const old = job('a', {hiring_party: headhunter, quality_flags: ['company_missing'], company_check: prior});
  const d = dataset([old, job('b'), job('c', {company_check: prior}), job('d', {hiring_party: {type: 'headhunter', evidence: []}})]);
  const saved = d.jobs[old.id];
  assert.equal(saved.company, ''); assert.equal(saved.quality_flags.includes('company_missing'), false);
  assert.equal(saved.company_check.state, 'not_required'); assert.deepEqual(saved.company_check.previous_check, prior);
  assert.equal(saved.company_check.observed_at, undefined); // Policy migration is not a new page observation.
  for (const key of ['id', 'title', 'jd', 'contact_status', 'first_seen_at', 'last_seen_at', 'hiring_party']) assert.deepEqual(saved[key], old[key], key);
  assert.deepEqual(migrateDataset(d), d);
  assert.deepEqual(followUpPlan(d, null, false, null, 'company').jobs.map(j => j.id), ['boss:b', 'boss:d']);
  assert.deepEqual(followUpPlan(d, null, true, null, 'company').jobs.map(j => j.id), ['boss:c']);
  assert.equal(d.jobs['boss:d'].quality_flags.includes('company_missing'), true);
  assert.equal(old.company_check.state, 'needs_review');
});

test('猎头免公司不免JD，也不覆盖已知公司或身份冲突证据', () => {
  const d = dataset([job('a', {hiring_party: headhunter, jd: '', jd_status: 'missing', recruitment_signals_detail_checked_at: null}),
    job('b', {hiring_party: headhunter, company: '已知公司', company_check: {state: 'found'}}),
    job('c', {hiring_party: headhunter, company_check: {state: 'needs_review', reason: 'title_conflict', identity_conflict: {expected: 'A', observed: 'B'}}})]);
  assert.deepEqual(followUpPlan(d, null, false, null, 'dataset').jobs.map(j => j.id), ['boss:a']);
  assert.equal(d.jobs['boss:b'].company, '已知公司'); assert.equal(d.jobs['boss:b'].company_check.state, 'found');
  assert.equal(d.jobs['boss:c'].company_check.reason, 'title_conflict');
  assert.equal(followUpPlan(d, null, true, null, 'company').pending, 0);
});

test('公司队列与JD队列分离，跳过已填/关闭/不可访问，无搜索记录也可补采，支持续采/复查/上限', () => {
  const d = dataset([job('a'), job('b', {company: '已有'}), job('c', {link_access: {state: 'unavailable'}}), job('d', {recruitment_signals: {availability: {value: 'explicit_unavailable'}}}), job('e', {company_check: {state: 'needs_review'}}), job('f', {jd: '', jd_status: 'missing'}), job('g')]);
  const p = followUpPlan(d, null, false, 1, 'company');
  assert.equal(p.pending, 2); assert.equal(p.jobs.length, 1); assert.equal(p.deferred, 1); assert.equal(p.review_pending, 1);
  assert.deepEqual(followUpPlan(d, null, true, null, 'company').jobs.map(j => j.id), ['boss:e']);
  assert.deepEqual(followUpPlan(d, null, false, null, 'dataset').jobs.map(j => j.id), ['boss:f']);
  assert.throws(() => followUpPlan(d, 's', false, null, 'company'), /不能同时/);
});

test('只补公司和来源，旧正文/薪资/时间/沟通状态等逐字段不变，缺名和冲突明确隔离', () => {
  const d = dataset([job('a')]), before = structuredClone(d.jobs['boss:a']);
  const r = applyCompanyCapture(d, capture(before), before.id, 'now');
  const saved = r.dataset.jobs[before.id];
  for (const [key, value] of Object.entries(before)) if (!['company', 'company_raw', 'quality_flags'].includes(key)) assert.deepEqual(saved[key], value, key);
  assert.equal(saved.company, '合成公司'); assert.equal(saved.company_check.state, 'found'); assert.equal(saved.company_evidence.observed_at, 'now');
  assert.deepEqual(d.jobs[before.id], before);
  for (const c of [capture(before, ''), {...capture(before), status: 'identity_conflict', jobs: []}, {...capture(before), status: 'empty', jobs: []}]) {
    const missing = applyCompanyCapture(d, c, before.id).dataset.jobs[before.id];
    assert.equal(missing.company_check.state, 'needs_review'); assert.equal(missing.jd, before.jd); assert.equal(needsCompany(missing), false);
  }
  const closed = applyCompanyCapture(d, {...capture(before), status: 'job_unavailable'}, before.id).dataset.jobs[before.id];
  assert.equal(closed.company_check.state, 'unavailable'); assert.equal(needsCompany(closed), false);
  const other = capture(job('b')); assert.throws(() => applyCompanyCapture(d, other, before.id), /身份/);
  const noEvidence = capture(before); delete noEvidence.jobs[0].company_evidence;
  assert.equal(applyCompanyCapture(d, noEvidence, before.id).dataset.jobs[before.id].company, '');
});
