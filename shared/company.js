import {cleanCompany, jobIdentity, readableJD} from './core.js';
import {hiringParty, applyHiringParty, isCompanyExempt} from './hiring-party.js';

export const companyEligible = job => !isCompanyExempt(job) && !cleanCompany(job.company) && readableJD(job) && job.company_check?.state !== 'unavailable' && job.link_access?.state !== 'unavailable' && job.recruitment_signals?.availability?.value !== 'explicit_unavailable';
export const needsCompany = job => companyEligible(job) && job.company_check?.state !== 'needs_review';

// A company-only pass must never replace an existing JD, contact state, identity,
// salary or observation timestamp with a fresh detail capture.
export function applyCompanyCapture(dataset, capture, expectedId, now = new Date().toISOString()) {
  const old = dataset.jobs[expectedId];
  if (!old || jobIdentity(capture.source_url)?.id !== expectedId) throw new Error('公司补采的岗位身份不一致');
  if (!['captured', 'empty', 'identity_conflict', 'job_unavailable'].includes(capture.status)) return {dataset, run: {status: capture.status, matched: 0, block_reason: capture.block_reason}};
  const raw = capture.status === 'captured' && capture.jobs?.length === 1 && jobIdentity(capture.jobs[0].url)?.id === expectedId ? capture.jobs[0] : null;
  const company = cleanCompany(raw?.company);
  const evidence = raw?.company_evidence;
  const valid = company && company.length <= 200 && !company.includes('\n') && evidence?.text === raw.company && evidence?.selector;
  const next = {...applyHiringParty(old, hiringParty(raw?.hiring_party, {url: old.url, observed_at: now, page_type: 'detail'})), company_check: {state: valid ? 'found' : capture.status === 'job_unavailable' ? 'unavailable' : 'needs_review', observed_at: now,
    reason: valid ? 'visible_company_label' : capture.status === 'identity_conflict' ? 'title_conflict' : capture.status === 'job_unavailable' ? 'job_unavailable' : 'company_not_identified',
    diagnostics: capture.diagnostics?.company || null,
    ...(capture.status === 'identity_conflict' ? {identity_conflict: capture.diagnostics?.identity_conflict} : {}),
    ...(capture.status === 'job_unavailable' ? {availability_evidence: capture.jobs?.[0]?.recruitment_signals?.availability || []} : {})}};
  if (valid && !cleanCompany(old.company)) {
    next.company = company; next.company_raw = raw.company;
    next.company_evidence = {...evidence, source_url: old.url, observed_at: now};
    next.quality_flags = (old.quality_flags || []).filter(f => f !== 'company_missing');
  }
  Object.assign(next, applyHiringParty(next, null));
  const run = {status: capture.status, page_type: 'detail', mode: 'company_only', source_url: old.url, captured_at: now,
    matched: 1, added: 0, skipped: 0, seen_job_ids: [expectedId], new_job_ids: [], diagnostics: capture.diagnostics || {}, company_check: next.company_check};
  return {dataset: {...dataset, jobs: {...dataset.jobs, [expectedId]: next}, runs: [...(dataset.runs || []).slice(-99), run]}, run};
}
