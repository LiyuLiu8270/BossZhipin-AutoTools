import {jobIdentity} from './core.js';
import {signalSnapshot, mergeSignals} from './signals.js';

// Keep the activity-only observation separate: rereading this field must not
// redate older availability evidence or replace JD/contact/matching inputs.
export function activitySnapshots(job) {
  return [job.activity_check?.snapshot, job.recruitment_signals, ...Object.values(job.scraper_activity_observations || {}),
    ...Object.values(job.recruitment_signals_by_page || {}),
    ...(job.recruitment_signal_history || [])].filter(s => s && typeof s === 'object');
}
export function hasActivity(job) {
  return activitySnapshots(job).some(s => (s === job.recruitment_signals || Number.isFinite(Date.parse(s.checked_at))) &&
    Array.isArray(s.recruiter_activity?.raw) && s.recruiter_activity.raw.some(v => typeof v === 'string' && v.trim()));
}
export const activityEligible = job => !hasActivity(job) && job.link_access?.state !== 'unavailable' &&
  job.recruitment_signals?.availability?.value !== 'explicit_unavailable' && job.activity_check?.state !== 'unavailable';
export const needsActivity = job => activityEligible(job) && !['needs_review','not_displayed'].includes(job.activity_check?.state);
// Verified absence completes collection; it is not an invitation to retry.
export const needsActivityBackfill = job => activityEligible(job) && job.activity_check?.state !== 'not_displayed';

export function applyActivityCapture(dataset, capture, expectedId, now = new Date().toISOString()) {
  const old = dataset.jobs[expectedId];
  if (!old || jobIdentity(capture.source_url)?.id !== expectedId) throw new Error('活跃状态补采的岗位身份不一致');
  if (!['captured', 'empty', 'identity_conflict', 'job_unavailable'].includes(capture.status))
    return {dataset, run: {status: capture.status, matched: 0, block_reason: capture.block_reason}};
  const identified = ['captured', 'job_unavailable'].includes(capture.status);
  if (identified && (capture.jobs?.length !== 1 || jobIdentity(capture.jobs[0].url)?.id !== expectedId))
    throw new Error('活跃状态补采的详情身份不明确');
  const raw = identified ? capture.jobs[0] : null;
  const observed = signalSnapshot(raw?.recruitment_signals, {url: old.url, observed_at: now, page_type: 'detail'});
  const closed = capture.status === 'job_unavailable';
  if (closed && observed.availability.value !== 'explicit_unavailable') throw new Error('关闭提示缺少可见证据，未保存');
  const found = !closed && observed.recruiter_activity.raw.length > 0;
  const conflict = capture.status === 'identity_conflict';
  const diagnostic = capture.diagnostics?.activity;
  const notDisplayed = !closed && !found && capture.status === 'captured' && capture.diagnostics?.activity_settled === true && diagnostic?.recruiter_panel_ready === true && diagnostic?.unrecognized_labels?.length === 0;
  const check = {state: closed ? 'unavailable' : found ? 'found' : notDisplayed ? 'not_displayed' : 'needs_review', observed_at: now, source_url: old.url,
    reason: closed ? 'job_unavailable' : found ? 'visible_activity_label' : conflict ? 'title_conflict' : notDisplayed ? 'recruiter_panel_without_activity' : diagnostic?.unrecognized_labels?.length ? 'activity_label_unrecognized' : 'activity_not_observed',
    reader_version: 'activity-2',
    ...(conflict ? {identity_conflict: capture.diagnostics?.identity_conflict} : {
      snapshot: {checked_at: now, page_type: 'detail', source_url: old.url, recruiter_activity: observed.recruiter_activity}})};
  const next = {...old, activity_check: check};
  // Explicit closure is a separate real observation and must affect readiness.
  if (closed) Object.assign(next, mergeSignals(old, {recruitment_signals: observed}));
  const run = {status: capture.status, page_type: 'detail', mode: 'activity_only', source_url: old.url, captured_at: now,
    matched: 1, added: 0, skipped: 0, seen_job_ids: [expectedId], new_job_ids: [], activity_check: check};
  return {dataset: {...dataset, jobs: {...dataset.jobs, [expectedId]: next}, runs: [...(dataset.runs || []).slice(-99), run]}, run};
}
