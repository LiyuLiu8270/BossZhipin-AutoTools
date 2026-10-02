import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanCompany, splitTags, normalizeJob, mergeJob, migrateDataset, emptyDataset, pendingJobs} from '../shared/core.js';
const ctx = {observed_at: '2026-09-29T00:00:00Z', keyword: '产品', url: 'https://www.zhipin.com/web/geek/jobs'};
const raw = {url: '/job_detail/example.html', title: '合成产品经理', company: '公司名称\n合成科技有限公司', location: '深圳·龙岗区·坂田', tags: ['B端产品', '本科', '五险一金', '年终奖'], salary: '20-40K'};
const make = extra => normalizeJob({...raw, ...extra}, ctx);
test('公司字段只清理明确标签，不破坏名称本身', () => {
  assert.equal(cleanCompany(raw.company), '合成科技有限公司');
  assert.equal(cleanCompany('公司名称：合成公司'), '合成公司');
  assert.equal(cleanCompany('公司名称设计有限公司'), '公司名称设计有限公司');
  assert.equal(make({}).company_raw, raw.company);
});
test('详细地区不会被城市覆盖；冲突地区保留两份观察值', () => {
  const old = make({});
  const merged = mergeJob(old, make({location: '深圳'}));
  assert.equal(merged.location, '深圳·龙岗区·坂田');
  assert.deepEqual(merged.locations, ['深圳·龙岗区·坂田', '深圳']);
  assert.equal(mergeJob(old, make({location: '北京·朝阳区'})).location, '北京·朝阳区');
});
test('福利与岗位标签分开，原始标签不丢失', () => {
  const result = splitTags(raw.tags);
  assert.deepEqual(result.tags, ['B端产品', '本科']);
  assert.deepEqual(result.benefits, ['五险一金', '年终奖']);
  assert.deepEqual(result.tags_raw, raw.tags);
});
test('后续列表乱码不覆盖已获取的普通薪资，质量标记按最终字段计算', () => {
  const merged = mergeJob(make({}), make({salary: '\uE133-\uE155K', company: ''}));
  assert.equal(merged.salary, '20-40K');
  assert.equal(merged.company, '合成科技有限公司');
  assert.equal(merged.quality_flags.includes('salary_encoded_font'), false);
  assert.equal(merged.quality_flags.includes('company_missing'), false);
});
test('升级旧数据不改变身份、时间、沟通状态或 JD，且幂等', () => {
  const old = make({jd: '合成 JD'.repeat(50)});
  delete old.benefits; delete old.tags_raw; old.tags = raw.tags; old.company = raw.company;
  old.contact_status = 'user_marked_contacted';
  const before = {schema_version: 1, collector_version: '0.1.0', label: '测试', jobs: {[old.id]: old}, runs: []};
  const original = JSON.stringify(before);
  const after = migrateDataset(before);
  assert.equal(JSON.stringify(before), original);
  assert.equal(after.schema_version, 2);
  assert.equal(after.jobs[old.id].company, '合成科技有限公司');
  for (const field of ['id', 'jd', 'first_seen_at', 'seen_count', 'contact_status']) assert.equal(after.jobs[old.id][field], old[field]);
  assert.deepEqual(migrateDataset(after), after);
});
test('队列只选缺失/可能截断正文的岗位，最多5条，拒绝无效链接', () => {
  const dataset = emptyDataset('测试');
  for (let i = 0; i < 10; i++) { const job = make({url: `/job_detail/id${i}.html`}); dataset.jobs[job.id] = job; }
  assert.equal(pendingJobs(dataset, 100).length, 5);
  assert.equal(pendingJobs(dataset).length, 3);
  dataset.jobs['boss:id0'].jd_status = 'captured_unverified';
  dataset.jobs['boss:id1'].url = 'https://other.example';
  assert.equal(pendingJobs(dataset)[0].id, 'boss:id2');
});
