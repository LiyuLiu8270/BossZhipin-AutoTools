import {signalSnapshot, mergeSignals, signalPages, SIGNAL_FIELDS} from './signals.js';
import {compareTitles, displayJD} from './text-rules.js';
import {hiringParty, applyHiringParty, isCompanyExempt} from './hiring-party.js';
export const VERSION = '0.13.0';
export const clean = value => String(value ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
const encoding = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
export function classifyJD(value, truncated = false) {
  const jd = clean(value);
  if (!jd) return 'missing';
  if (/登录(?:后)?(?:查看|后查看)|注册后查看|展开全部|展开更多/.test(jd) || encoding.test(displayJD(jd)) || truncated) return 'partial';
  return jd.length < 120 ? 'short_unverified' : 'captured_unverified';
}
export const readableJD = job => ['captured_unverified', 'short_unverified'].includes(job?.jd_status);
export const needsDetail = job => job.link_access?.state !== 'unavailable' && job.detail_review?.state !== 'needs_review' &&
  (job.detail_review?.state === 'retry_ready' || !job.recruitment_signals_detail_checked_at || (!readableJD(job) && job.recruitment_signals?.availability?.value !== 'explicit_unavailable'));
const benefitPattern = /五险|一金|社保|医保|商业保险|福利|补贴|补助|奖金|年终奖|绩效奖|工龄奖|全勤奖|假期|年假|双休|周末休|包吃|包住|餐补|房补|交通补|通讯补|团建|旅游|体检|下午茶|零食|生日礼|节日礼|股票期权/;
export const cleanCompany = value => clean(value).replace(/^公司名称(?:[ \t]*[:：][ \t]*|[ \t]*\n+[ \t]*)/, '').trim();
export function splitTags(values) {
  const raw = [...new Set((values || []).map(clean).filter(Boolean))];
  const compensation = /底薪|提成|薪资|薪酬|\d+薪/;
  return {tags_raw: raw, tags: raw.filter(t => !benefitPattern.test(t) && !compensation.test(t)), benefits: raw.filter(t => benefitPattern.test(t) && !compensation.test(t)), compensation_tags: raw.filter(t => compensation.test(t))};
}
export function qualityOf(job) {
  const flags = [];
  if (!cleanCompany(job.company) && !isCompanyExempt(job)) flags.push('company_missing');
  if (encoding.test(job.salary)) flags.push('salary_encoded_font');
  if (encoding.test(displayJD(job.jd))) flags.push('jd_encoded_font');
  if (displayJD(job.jd) !== String(job.jd ?? '').replace(/\r\n/g, '\n')) flags.push('jd_list_symbols_normalized');
  if (job.jd_truncated) flags.push('jd_truncated');
  if (classifyJD(job.jd, job.jd_truncated) === 'short_unverified') flags.push('jd_short');
  return flags;
}
function betterLocation(oldValue, newValue) {
  if (!newValue) return oldValue;
  const compact = value => clean(value).replace(/[·\s\-]/g, '');
  const a = compact(oldValue), b = compact(newValue);
  return a.startsWith(b) ? oldValue : newValue;
}
export function pendingJobs(dataset, limit = 3) {
  const n = Math.min(5, Math.max(1, Number.parseInt(limit, 10) || 3));
  return Object.values(dataset.jobs).filter(j => (!readableJD(j) || j.detail_review?.state === 'retry_ready') && j.link_access?.state !== 'unavailable' && j.detail_review?.state !== 'needs_review' && jobIdentity(j.url)?.id === j.id).slice(0, n);
}

// Lossless in-place schema upgrade: keep raw fields and metadata, split benefits.
export function migrateDataset(dataset) {
  const jobs = {};
  for (const [id, old] of Object.entries(dataset.jobs || {})) {
    const job = {...old, company_raw: old.company_raw || old.company || '', company: cleanCompany(old.company),
      ...splitTags([...(old.tags_raw || old.tags || []), ...(old.benefits || []), ...(old.compensation_tags || [])]),
      locations: [...new Set([...(old.locations || []), old.location].filter(Boolean))],
      jd_truncated: old.jd_truncated || (old.quality_flags || []).includes('jd_truncated')};
    const classification = classifyJD(old.jd, job.jd_truncated);
    if (old.jd_status === 'partial' && old.recruitment_signals_detail_checked_at && ['short_unverified', 'captured_unverified'].includes(classification)) {
      job.jd_status = classification;
      if (old.detail_review?.state === 'needs_review' && old.detail_review.reason === 'partial_after_retries' && displayJD(old.jd) !== old.jd) {
        job.detail_review = {...old.detail_review, state: 'resolved', resolution: 'list_symbol_rule_updated', resolved_by_version: VERSION};
      }
    }
    const conflict = old.detail_review?.identity_conflict;
    if (old.detail_review?.state === 'needs_review' && old.detail_review.reason === 'same_id_title_conflict' &&
      conflict?.expected_id === id && conflict.observed_id === id && compareTitles(old.title, conflict.expected_title).kind === 'exact' &&
      compareTitles(conflict.expected_title, conflict.observed_title).kind === 'travel_suffix') {
      // A previous rejected capture contained no saved JD. Requeue it; do not
      // pretend the old title observation alone completed detail collection.
      job.detail_review = {...old.detail_review, state: 'retry_ready', requeued_by_version: VERSION};
    }
    if (displayJD(job.jd) !== job.jd && job.jd) job.jd_display = displayJD(job.jd); else delete job.jd_display;
    Object.assign(job, applyHiringParty(job, null));
    job.quality_flags = qualityOf(job);
    job.recruitment_signals ||= signalSnapshot(null, {});
    job.recruitment_signal_history ||= [];
    job.recruitment_signals_detail_checked_at ||= null;
    job.recruitment_signals_by_page = signalPages(job);
    jobs[id] = job;
  }
  return {...dataset, schema_version: 2, collector_version: VERSION, jobs};
}

export function sourceUrl(value) {
  try {
    const u = new URL(value);
    if (u.origin !== 'https://www.zhipin.com') return '';
    if (!/^\/web\/geek\/(jobs|recommend)\/?$/.test(u.pathname) && !jobIdentity(u.href)) return '';
    const safe = new URL(u.origin + u.pathname);
    for (const key of ['query', 'city']) {
      if (u.searchParams.has(key)) safe.searchParams.set(key, u.searchParams.get(key));
    }
    return safe.href;
  } catch { return ''; }
}

export function jobIdentity(value) {
  try {
    const u = new URL(value, 'https://www.zhipin.com');
    const m = /^\/job_detail\/([\w~-]+)\.html$/.exec(u.pathname);
    if (u.origin !== 'https://www.zhipin.com' || !m) return null;
    return {id: `boss:${m[1]}`, job_id: m[1], url: u.origin + u.pathname};
  } catch { return null; }
}

export function normalizeJob(raw, context) {
  const identity = jobIdentity(raw.url);
  const title = clean(raw.title).slice(0, 300);
  if (!identity || !title) return null;
  const jd = clean(raw.jd).slice(0, 40000);
  const salary = clean(raw.salary).slice(0, 150);
  const quality = [];
  if (!cleanCompany(raw.company)) quality.push('company_missing');
  if (encoding.test(salary)) quality.push('salary_encoded_font');
  if (jd && encoding.test(displayJD(jd))) quality.push('jd_encoded_font');
  if (displayJD(jd) !== jd) quality.push('jd_list_symbols_normalized');
  if (raw.jd_truncated) quality.push('jd_truncated');
  const jdStatus = classifyJD(jd, raw.jd_truncated);
  if (jdStatus === 'short_unverified') quality.push('jd_short');
  const normalized = {
    ...identity, title, company: cleanCompany(raw.company).slice(0, 300), company_raw: clean(raw.company).slice(0, 300), salary,
    ...(context.page_type === 'detail' ? {title_detail_raw: clean(raw.title_detail_raw || raw.title).slice(0, 300)} : {title_list_raw: title}),
    ...(raw.title_match_evidence ? {title_match_evidence: raw.title_match_evidence} : {}),
    ...(raw.company_evidence ? {company_evidence: {...raw.company_evidence, source_url: sourceUrl(context.url), observed_at: context.observed_at}} : {}),
    salary_source: 'rendered_dom_unverified',
    location: clean(raw.location).slice(0, 300),
    locations: clean(raw.location) ? [clean(raw.location).slice(0, 300)] : [],
    ...splitTags((raw.tags || []).slice(0, 60)),
    jd, jd_truncated: !!raw.jd_truncated, jd_status: jdStatus, jd_observed_at: jd ? context.observed_at : null,
    ...(displayJD(jd) !== jd ? {jd_display: displayJD(jd)} : {}),
    quality_flags: quality, data_source: 'visible_dom',
    first_seen_at: context.observed_at, last_seen_at: context.observed_at,
    seen_count: 1,
    keywords: context.keyword ? [clean(context.keyword)] : [],
    source_urls: sourceUrl(context.url) ? [sourceUrl(context.url)] : [],
    contact_status: 'unknown',
    recruitment_signals: signalSnapshot(raw.recruitment_signals, {...context, url: sourceUrl(context.url)}),
    recruitment_signal_history: [],
    recruitment_signals_detail_checked_at: context.page_type === 'detail' ? context.observed_at : null,
    // The checkbox is a user's assertion, not an automated login check.
    login_evidence: 'user_confirmed_not_automatically_verified'
  };
  return applyHiringParty(normalized, hiringParty(raw.hiring_party, {...context, url: sourceUrl(context.url)}));
}

export function mergeJob(old, next) {
  if (!old) return next;
  if (old.id !== next.id) throw new Error('岗位 ID 不一致，拒绝合并');
  const out = {...old, ...next, first_seen_at: old.first_seen_at, seen_count: old.seen_count + 1};
  for (const field of ['title', 'company', 'company_raw', 'salary']) out[field] = next[field] || old[field];
  if (next.company && next.company !== old.company && !next.company_evidence) delete out.company_evidence;
  if (old.salary && !encoding.test(old.salary) && encoding.test(next.salary)) out.salary = old.salary;
  out.location = betterLocation(old.location, next.location);
  for (const field of ['keywords', 'source_urls', 'locations']) out[field] = [...new Set([...(old[field] || []), ...(next[field] || [])])];
  Object.assign(out, splitTags([...(old.tags_raw || old.tags || []), ...(next.tags_raw || next.tags || []), ...(old.benefits || []), ...(next.benefits || []), ...(old.compensation_tags || []), ...(next.compensation_tags || [])]));
  const rank = {missing: 0, partial: 1, short_unverified: 2, captured_unverified: 3};
  if (rank[next.jd_status] < rank[old.jd_status]) {
    for (const field of ['jd', 'jd_status', 'jd_observed_at', 'jd_truncated']) out[field] = old[field];
  }
  out.quality_flags = qualityOf(out);
  if (displayJD(out.jd) !== out.jd) out.jd_display = displayJD(out.jd); else delete out.jd_display;
  out.contact_status = old.contact_status;
  Object.assign(out, mergeSignals(old, next));
  return applyHiringParty(out, next.hiring_party || old.hiring_party);
}

export function emptyDataset(label) {
  return {schema_version: 2, collector_version: VERSION, label, jobs: {}, runs: []};
}

// A URL-bound observation, distinct from recruitment availability. Preserve all
// previous JD/business fields and never create a job from a generic error page.
export function recordMissingLink(dataset, gate, expectedId, batchId, now = new Date().toISOString()) {
  const identity = jobIdentity(gate.source_url), old = dataset.jobs[expectedId];
  const evidence = gate.evidence;
  if (gate.kind !== 'link_unavailable' || !identity || identity.id !== expectedId || !old || jobIdentity(old.url)?.id !== expectedId ||
    !Array.isArray(evidence) || evidence.length !== 3 || evidence[0] !== 'Oops!' ||
    !/^(?:您|你)访问的页面不存在[~～。.!！]?$/.test(evidence[1]) || !/^将于\d+秒后自动跳转首页$/.test(evidence[2])) throw new Error('页面不存在提示未能绑定目标岗位，未标记。');
  const job = {...old, link_access: {state: 'unavailable', reason: 'explicit_page_missing', observed_at: now, source_url: identity.url, evidence: [...evidence]}};
  if (['needs_review', 'retry_ready'].includes(job.detail_review?.state)) job.detail_review = {...job.detail_review, state: 'resolved', resolved_at: now, resolution: 'link_unavailable'};
  const run = {captured_at: now, source_url: identity.url, page_type: 'detail', status: 'link_unavailable', mode: 'detail_queue',
    batch_id: batchId, added: 0, matched: 1, skipped: 0, new_job_ids: [], seen_job_ids: [expectedId],
    diagnostics: {link_access: job.link_access}, warnings: ['明确页面不存在，仅标记链接不可访问；不等于岗位已关闭，旧JD保留。']};
  return {dataset: {...dataset, jobs: {...dataset.jobs, [expectedId]: job}, runs: [...(dataset.runs || []).slice(-99), run]}, run};
}

export function applyCapture(dataset, capture, now = new Date().toISOString()) {
  const jobs = {...dataset.jobs};
  const context = {url: sourceUrl(capture.source_url), keyword: capture.keyword, observed_at: now, page_type: capture.page_type};
  const normalized = new Map();
  // A blocked/unknown page must never write jobs, even if it contains stale cards.
  for (const raw of capture.status === 'captured' ? capture.jobs || [] : []) {
    const job = normalizeJob(raw, context);
    if (job) normalized.set(job.id, mergeJob(normalized.get(job.id), job));
  }
  // Closed pages may have no title. Update only the existing URL-bound record,
  // never fabricate a new job from a generic error page or replace saved text.
  if (capture.status === 'job_unavailable' && capture.page_type === 'detail' && capture.jobs?.length === 1) {
    const raw = capture.jobs[0], id = jobIdentity(capture.source_url)?.id;
    const old = jobs[id], snapshot = signalSnapshot(raw.recruitment_signals, context);
    if (old && jobIdentity(raw.url)?.id === id && snapshot.availability.value === 'explicit_unavailable') {
      const name = value => clean(value).replace(/\s/g, '').replace(/（/g, '(').replace(/）/g, ')');
      if (!raw.title || name(raw.title) === name(old.title)) normalized.set(id, {...old, last_seen_at: now, recruitment_signals: snapshot});
    }
  }
  let added = 0;
  const newIds = [];
  for (const [key, job] of normalized) {
    if (!jobs[key]) { added++; newIds.push(key); }
    jobs[key] = mergeJob(jobs[key], {...job, seen_count: 1});
    if (capture.page_type === 'detail' && (readableJD(job) || capture.status === 'job_unavailable') && jobs[key].link_access?.state === 'unavailable') {
      jobs[key].link_access = {...jobs[key].link_access, state: 'restored', restored_at: now};
    }
    if (capture.page_type === 'detail' && (readableJD(job) || capture.status === 'job_unavailable') && ['needs_review', 'retry_ready'].includes(jobs[key].detail_review?.state)) {
      jobs[key].detail_review = {...jobs[key].detail_review, state: 'resolved', resolved_at: now};
    }
  }
  const run = {
    captured_at: now, source_url: sourceUrl(capture.source_url), keyword: clean(capture.keyword),
    page_type: capture.page_type, status: capture.status, added, matched: normalized.size,
    block_reason: capture.block_reason || null,
    mode: capture.mode || 'manual', keyword_source: capture.keyword_source || (capture.keyword ? 'url' : 'unknown'),
    keyword_evidence: capture.keyword_evidence || 'unknown',
    new_job_ids: newIds, seen_job_ids: [...normalized.keys()],
    skipped: (capture.jobs || []).length - normalized.size,
    diagnostics: capture.diagnostics || {}, warnings: capture.warnings || []
  };
  return {dataset: {...dataset, jobs, runs: [...dataset.runs.slice(-99), run]}, run};
}

export function exportData(dataset) {
  return {
    schema_version: 2, collector_version: VERSION, exported_at: new Date().toISOString(),
    label: dataset.label,
    notice: '用户启动采集；登录态未自动验证；薪资为 DOM 文本待核对；JD 捕获不代表完整；首次发现不代表发布时间；last_seen_at 不是招聘者上线时间。招聘状态为页面标签观察，不保证岗位真实有效；未知不等于不活跃。未发送消息。',
    jobs: Object.values(dataset.jobs), runs: dataset.runs, batch_runs: dataset.batch_runs || [],
    ...(dataset.transport_diagnostics ? {transport_diagnostics: dataset.transport_diagnostics} : {})
  };
}

export function exportLatestSearch(dataset) {
  const batch = (dataset.batch_runs || []).filter(run => run.kind === 'search').at(-1);
  if (!batch) throw new Error('尚无关键词搜索记录，请先启动搜索队列。');
  const data = exportData(dataset);
  return {...data, export_scope: 'latest_search_new_to_dataset',
    notice: data.notice + ' 此文件仅包含最近一轮首次进入此数据集的岗位，停止的轮次也可能包含已保存的部分结果。',
    jobs: (batch.new_job_ids || []).map(id => dataset.jobs[id]).filter(Boolean), batch_runs: [batch],
    runs: dataset.runs.filter(run => run.batch_id === batch.id)};
}

export function exportLatestCapture(dataset, selectedRun = dataset.runs?.at(-1)) {
  if (!selectedRun) throw new Error('尚无已保存的采集记录，请先采集当前页面。');
  // Never substitute the last successful run for an empty/blocked current run.
  // Identity conflicts have diagnostics, not a successfully merged job snapshot.
  const ids = [...new Set(selectedRun.seen_job_ids || [])];
  const missing = ids.filter(id => !dataset.jobs[id]);
  if (missing.length) throw new Error('本次采集关联的岗位记录缺失，请导出完整岗位库诊断。');
  const subset = {label: dataset.label, jobs: Object.fromEntries(ids.map(id => [id, dataset.jobs[id]])), runs: [selectedRun], batch_runs: []};
  const result = exportData(subset);
  return structuredClone({...result, export_scope: 'latest_capture', total_jobs_in_dataset: Object.keys(dataset.jobs).length,
    selection: {captured_at: selectedRun.captured_at, source_url: selectedRun.source_url, page_type: selectedRun.page_type,
      status: selectedRun.status, mode: selectedRun.mode, job_count: ids.length, job_snapshot_kind: 'stored_records_after_capture'},
    notice: result.notice + ' 仅含所选一次已保存采集涉及的岗位及该次诊断；岗位是库中合并记录，可能保留此前JD/标识，不代表字段均在本次重新获取。无岗位时仅导出诊断，不回退到整库。不含历史批次或整库通信记录。'});
}

export function csv(dataset) {
  const fields = ['job_id', 'title', 'company', 'salary', 'location', 'tags', 'benefits', 'compensation_tags', 'jd_status', 'detail_review_state', 'detail_review_reason', 'link_access_state', 'link_access_reason', 'link_access_observed_at', 'jd', 'url', 'first_seen_at', 'last_seen_at', 'contact_status', ...SIGNAL_FIELDS.map(f => f + '_raw'), 'signals_checked_at', 'signals_source_url'];
  const cell = value => {
    let text = Array.isArray(value) ? value.join(' | ') : String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  fields.push('hiring_type', 'hiring_type_raw', 'hiring_type_observed_at', 'hiring_type_source_url');
  return '\uFEFF' + [fields, ...Object.values(dataset.jobs).map(job => {
    const flat = {...job, link_access_state: job.link_access?.state || '', link_access_reason: job.link_access?.reason || '', link_access_observed_at: job.link_access?.observed_at || '', detail_review_state: job.detail_review?.state || '', detail_review_reason: job.detail_review?.reason || '', signals_checked_at: job.recruitment_signals?.checked_at, signals_source_url: job.recruitment_signals?.source_url};
    for (const f of SIGNAL_FIELDS) flat[f + '_raw'] = job.recruitment_signals?.[f]?.raw?.length ? job.recruitment_signals[f].raw : '未知';
    Object.assign(flat, {hiring_type: job.hiring_party?.type || 'unknown', hiring_type_raw: job.hiring_party?.evidence?.map(e => e.text) || [], hiring_type_observed_at: job.hiring_party?.observed_at || '', hiring_type_source_url: job.hiring_party?.source_url || ''});
    return fields.map(field => flat[field]);
  })].map(row => row.map(cell).join(',')).join('\r\n');
}
