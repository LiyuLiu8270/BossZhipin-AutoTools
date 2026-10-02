import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyJD, migrateDataset, applyCapture, VERSION} from '../shared/core.js';
import {followUpPlan} from '../shared/legacy-export.js';

const shortJD = '保密高阶职位，可以是治理/服务体验/商品/商家/履约等，最好负责过多个域。\n任职要求：\n大厂背景+团队管理经验+好学历';
const job = {id: 'boss:a', url: 'https://www.zhipin.com/job_detail/a.html', title: '产品经理', jd: shortJD, jd_status: 'partial', recruitment_signals_detail_checked_at: '2026-09-29'};
test('59字真实短正文计为已采集，迁移不丢字段、不重复进入普通补采', () => {
  assert.equal(shortJD.length, 59); assert.equal(classifyJD(shortJD), 'short_unverified');
  for (const text of ['请登录查看', '短描述展开全部', '\uE111']) assert.equal(classifyJD(text), 'partial');
  assert.equal(classifyJD(shortJD, true), 'partial');
  const old = {schema_version: 2, collector_version: '0.7.3', jobs: {'boss:a': job}, runs: [], batch_runs: [{id: 's', kind: 'search', seen_job_ids: ['boss:a']}]};
  const migrated = migrateDataset(old);
  assert.equal(migrated.jobs['boss:a'].jd_status, 'short_unverified');
  assert.equal(migrated.jobs['boss:a'].jd, shortJD); assert.equal(old.jobs['boss:a'].jd_status, 'partial');
  assert.equal(followUpPlan(migrated).pending, 0);
});
