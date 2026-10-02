// Observations, not a model score or a claim about hiring intent.
export const SIGNAL_FIELDS = ['recruiter_activity', 'recruiter_response', 'availability', 'published', 'updated'];
export function signalPages(job) {
  const pages = {...job.recruitment_signals_by_page};
  for (const snapshot of [...(job.recruitment_signal_history || []), job.recruitment_signals]) {
    if (!snapshot?.checked_at || !['list', 'detail'].includes(snapshot.page_type)) continue;
    const old = pages[snapshot.page_type];
    if (!old || snapshot.checked_at >= old.checked_at) pages[snapshot.page_type] = snapshot;
  }
  return pages;
}
export function signalSnapshot(raw, context) {
  const snapshot = {version: 1, checked_at: context.observed_at || null, page_type: context.page_type || 'unknown', source_url: context.url || ''};
  for (const field of SIGNAL_FIELDS) {
    const evidence = Array.isArray(raw?.[field]) ? raw[field].filter(e => typeof e?.text === 'string' && e.text.trim()).slice(0, 8).map(e => ({text: e.text.trim().slice(0, 100), selector: String(e.selector || '').slice(0, 200)})) : [];
    snapshot[field] = {state: evidence.length ? 'observed' : 'unknown', raw: evidence.map(e => e.text), evidence};
  }
  const values = snapshot.availability.raw;
  const closed = values.some(v => /关闭|下架|失效|停止招聘|结束招聘|暂停招聘|不再招聘/.test(v));
  const openPattern = /^(?:(?:该|此|本)?(?:岗位|职位)\s*)?(?:招聘中|正在招聘|开放招聘)[。！!]?$/;
  const open = values.some(v => openPattern.test(v));
  snapshot.availability.value = closed && open ? 'conflicting' : closed ? 'explicit_unavailable' : open ? 'explicit_recruiting' : 'unknown';
  return snapshot;
}
export function mergeSignals(old, next) {
  const current = next.recruitment_signals;
  const pages = signalPages(old);
  if (current?.checked_at && ['list', 'detail'].includes(current.page_type)) pages[current.page_type] = current;
  if (!current?.checked_at) return {recruitment_signals: old.recruitment_signals, recruitment_signals_by_page: pages, recruitment_signal_history: old.recruitment_signal_history || [], recruitment_signals_detail_checked_at: old.recruitment_signals_detail_checked_at || null};
  const history = [...(old.recruitment_signal_history || [])];
  if (old.recruitment_signals?.checked_at && JSON.stringify(old.recruitment_signals) !== JSON.stringify(current)) history.push(old.recruitment_signals);
  return {recruitment_signals: current, recruitment_signal_history: history.slice(-10), recruitment_signals_by_page: pages,
    recruitment_signals_detail_checked_at: current.page_type === 'detail' ? current.checked_at : old.recruitment_signals_detail_checked_at || null};
}
