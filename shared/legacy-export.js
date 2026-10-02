import {jobIdentity, needsDetail} from './core.js';
import {companyEligible, needsCompany} from './company.js';
import {activityEligible, needsActivity} from './activity.js';

// null means all pending jobs in the selected scope snapshot, not endless polling.
export function detailLimit(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  if (!['number', 'string'].includes(typeof value)) throw new Error('详情数量上限需为正整数，留空表示不限。');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('详情数量上限需为正整数，留空表示不限。');
  return limit;
}

// Scope comes only from stored observed jobs/search results, never title relevance.
export function followUpPlan(dataset, sourceBatchId, reviewOnly = false, maxDetails = null, scope = 'recent') {
  if (!['recent', 'dataset', 'company', 'activity'].includes(scope)) throw new Error('详情采集范围无效');
  if (scope !== 'recent' && sourceBatchId) throw new Error('全库范围不能同时指定搜索批次');
  const limit = detailLimit(maxDetails);
  const batch = sourceBatchId
    ? (dataset.batch_runs || []).find(b => b.kind === 'search' && b.id === sourceBatchId)
    : (dataset.batch_runs || []).filter(b => b.kind === 'search').at(-1);
  if (!batch && scope === 'recent') throw new Error('尚无搜索记录，请先启动关键词采集。');
  const ids = scope !== 'recent' ? Object.keys(dataset.jobs || {}) : [...new Set(batch.seen_job_ids || [])];
  const all = ids.map(id => {
    const job = dataset.jobs[id];
    if (!job || job.id !== id || jobIdentity(job.url)?.id !== id) throw new Error('采集范围内的岗位链接缺失或不一致，请导出诊断。');
    return job;
  });
  const review = all.filter(job => scope === 'activity' ? activityEligible(job) && job.activity_check?.state === 'needs_review' : scope === 'company' ? companyEligible(job) && job.company_check?.state === 'needs_review' : job.detail_review?.state === 'needs_review');
  const jobs = reviewOnly ? review : all.filter(scope === 'activity' ? needsActivity : scope === 'company' ? needsCompany : needsDetail);
  const selected = limit === null ? jobs : jobs.slice(0, limit);
  // The controller needs identity only; do not transfer hundreds of full JDs/history.
  return {sourceBatchId: scope !== 'recent' ? null : batch.id, scope, jobs: selected.map(({id, title, url}) => ({id, title, url})), pending: jobs.length,
    deferred: jobs.length - selected.length, maxDetails: limit, seen: ids.length, review_pending: review.length, reviewOnly};
}
