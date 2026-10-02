import test from 'node:test';
import assert from 'node:assert/strict';
import {exportLatestCapture, exportData, VERSION} from '../shared/core.js';

const job = id => ({id: `boss:${id}`, title: `岗位${id}`, company: '', url: `https://www.zhipin.com/job_detail/${id}.html`, jd: '原有正文', jd_status: 'captured_unverified'});
const run = (ids, extra = {}) => ({captured_at: '2026-09-29T14:00:00Z', source_url: job(ids[0] || 'empty').url, page_type: 'detail', status: 'captured', mode: 'manual', seen_job_ids: ids.map(id => `boss:${id}`), new_job_ids: [], matched: ids.length, added: 0, warnings: [], diagnostics: {headhunter_badges_found: 1}, ...extra});
const dataset = ids => ({label: 'A', jobs: Object.fromEntries(ids.map(id => [job(id).id, job(id)])), runs: [run([ids[0]])], batch_runs: [{id: 'huge', seen_job_ids: ids}], transport_diagnostics: {unrelated: 'not in small file'}});

test('单页更新已有岗位也能小导出，不按新增筛选，不携带全库历史/其他岗位', () => {
  const d = dataset(Array.from({length: 1603}, (_, i) => String(i))), before = structuredClone(d);
  d.runs.push(run(['3'])); before.runs.push(run(['3']));
  const out = exportLatestCapture(d);
  assert.equal(out.export_scope, 'latest_capture'); assert.equal(out.total_jobs_in_dataset, 1603);
  assert.deepEqual(out.jobs.map(j => j.id), ['boss:3']); assert.equal(out.runs.length, 1); assert.deepEqual(out.batch_runs, []);
  assert.equal(out.transport_diagnostics, undefined); assert.equal(out.selection.job_count, 1);
  assert.equal(out.runs[0].diagnostics.headhunter_badges_found, 1);
  assert.deepEqual(d, before); assert.equal(exportData(d).jobs.length, 1603);
  assert.ok(JSON.stringify(out).length < JSON.stringify(exportData(d)).length / 20);
  d.jobs['boss:3'].title = '后续变化'; assert.equal(out.jobs[0].title, '岗位3');
});

test('列表按本次seen去重；空页/验证/冲突只导出当前诊断，不回退旧成功或全库', () => {
  const d = dataset(['a', 'b', 'c']);
  d.runs.push(run(['a', 'b', 'a'], {page_type: 'list'}));
  assert.deepEqual(exportLatestCapture(d).jobs.map(j => j.id), ['boss:a', 'boss:b']);
  for (const status of ['blocked', 'empty', 'identity_conflict', 'login_required']) {
    d.runs.push(run([], {status, diagnostics: {reason: status}}));
    const out = exportLatestCapture(d); assert.equal(out.jobs.length, 0); assert.equal(out.runs[0].status, status); assert.equal(out.selection.status, status);
  }
  assert.throws(() => exportLatestCapture({...d, runs: []}), /尚无/);
  assert.throws(() => exportLatestCapture(d, run(['missing'])), /记录缺失/);
});
