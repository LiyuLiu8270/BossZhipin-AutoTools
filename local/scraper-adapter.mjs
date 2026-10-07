import {createHash} from 'node:crypto';
import {jobIdentity, clean, classifyJD, splitTags, readableJD} from '../shared/core.js';
import {compareTitles, displayJD} from '../shared/text-rules.js';
import {signalSnapshot} from '../shared/signals.js';

export const SCRAPER_ADAPTER_VERSION = '1';
const unique = values => [...new Set(values.filter(Boolean))];
const parts = value => unique((Array.isArray(value) ? value : String(value || '').split('|')).map(clean).filter(Boolean));
const skillParts = value => parts(value).filter(v => !/^(kanzhun|boss直聘|boss|来自boss直聘|\.\.\.)$/i.test(v));
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');

function timestamp(value, offset) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)?$/.test(value)) throw new Error('scraper_invalid_timestamp');
  const zoned = /(?:Z|[+-]\d\d:\d\d)$/.test(value);
  if (!zoned && !/^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(offset || '')) throw new Error('scraper_timezone_required');
  const date = new Date(zoned ? value : value + offset);
  if (!Number.isFinite(date.getTime())) throw new Error('scraper_invalid_timestamp');
  return date.toISOString();
}
function companyLink(raw, id) {
  if (!raw) return '';
  let u;try { u = new URL(raw); } catch { throw new Error('scraper_company_identity_conflict'); }
  const found = /^\/gongsi\/([\w~-]+)\.html$/.exec(u.pathname)?.[1];
  if (u.origin !== 'https://www.zhipin.com' || !found || (id && found !== id)) throw new Error('scraper_company_identity_conflict');
  return u.origin + u.pathname;
}
const activity = (text, at, page, url, basis) => ({checked_at: at, page_type: page, source_url: url,
  time_precision: 'batch', time_basis: basis, data_source: 'boss-zhipin-scraper',
  recruiter_activity: {state: clean(text) ? 'observed' : 'unknown', raw: clean(text) ? [clean(text)] : [],
    evidence: clean(text) ? [{text: clean(text), source_field: 'boss_active_status'}] : []}});

function listRowError(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'scraper_list_invalid_record';
  const identity = jobIdentity(raw.job_link);
  if (!identity) return 'scraper_list_invalid_link';
  if (raw.encrypt_job_id && raw.encrypt_job_id !== identity.job_id) return 'scraper_list_identity_mismatch';
  if (!clean(raw.title)) return 'scraper_list_empty_title';
  try { companyLink(raw.company_link, raw.encrypt_brand_id); } catch { return 'scraper_company_identity_conflict'; }
  return null;
}

// Automatic list intake quarantines individual invalid rows, never guesses an ID.
// Keep raw evidence in the existing private bridge output; diagnostics expose only indices/reasons.
export function prepareScraperList(list) {
  if (!list || !Array.isArray(list.jobs)) throw new Error('scraper_invalid_input');
  const groups = new Map(), issues = [], jobs = [];
  let duplicates = 0;
  for (const [index, raw] of list.jobs.entries()) {
    const reason = listRowError(raw);
    if (reason) { issues.push({index, reason}); continue; }
    const id = jobIdentity(raw.job_link).id;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({index, raw});
  }
  for (const rows of groups.values()) {
    if (rows.some(r => canonical(r.raw) !== canonical(rows[0].raw))) {
      for (const r of rows) issues.push({index:r.index, reason:'scraper_list_duplicate_conflict'});
      continue;
    }
    jobs.push(rows[0].raw); duplicates += rows.length - 1;
  }
  issues.sort((a,b)=>a.index-b.index);
  return {list:{...list,jobs}, issues, duplicates};
}

// Pure conversion. Does not browse, infer hiring intent, modify upstream or write files.
// Explicit offset is required for upstream's timezone-less scraped_at.
export function adaptScraper({list, details = [], label, timezoneOffset, detailsObservedAt = null, observationId = null}) {
  if (!list || !Array.isArray(list.jobs) || !Array.isArray(details) || typeof label !== 'string' || !label.trim() || label.trim().length > 40)
    throw new Error('scraper_invalid_input');
  const listAt = timestamp(list.scraped_at, timezoneOffset);
  const detailAt = detailsObservedAt ? timestamp(detailsObservedAt, timezoneOffset) : null;
  if (detailAt && detailAt < listAt) throw new Error('scraper_detail_time_before_list');
  const seen = new Set(), detailsById = new Map();
  for (const d of details) {
    const id = jobIdentity(d.job_link || d.link);
    if (!id || (d.link && jobIdentity(d.link)?.id !== id.id) || detailsById.has(id.id)) throw new Error('scraper_detail_identity_conflict');
    detailsById.set(id.id, d);
  }
  const batch = {keyword: clean(list.keyword), city: clean(list.city), filters: list.filters || {}, filter_desc: list.filter_desc || [],
    scraped_at: list.scraped_at, total: list.total, timezone_offset: timezoneOffset || null, list_observed_at: listAt,
    details_observed_at: detailAt, time_precision: 'batch'};
  const batchId = observationId || digest({list});
  const jobs = list.jobs.map(raw => {
    const reason = listRowError(raw);
    if (reason) throw new Error(reason);
    const identity = jobIdentity(raw.job_link);
    if (seen.has(identity.id)) throw new Error('scraper_list_duplicate_identity');
    seen.add(identity.id);
    const detail = detailsById.get(identity.id);
    if (detail && ((raw.job_id && detail.job_id && detail.job_id !== raw.job_id) || compareTitles(raw.title, detail.title).kind === 'conflict'))
      throw new Error('scraper_detail_identity_conflict');
    const requirements = parts(raw.tags), skills = skillParts(raw.skills), detailSkills = skillParts(detail?.skill_tags);
    const experience = requirements.filter(t => /^(?:经验不限|应届生|在校生|应届\/在校|\d+(?:-\d+)?年(?:以上|以下)?)$/.test(t));
    const education = requirements.filter(t => /^(?:学历不限|初中及以下|高中|中专|中技|中专\/中技|大专|本科|硕士|博士)$/.test(t));
    // Preserve the source JD. Narrow display cleaning does not pretend to prove completeness.
    const jdRaw = String(detail?.jd || '');
    const jd = clean(jdRaw.replace(/\r\n/g, '\n').replace(/\n认证资质\s*\n人力资源服务许可证\s*$/, ''));
    const warnings = [];
    if (jdRaw && clean(jdRaw) !== jd) warnings.push('trailing_recruiting_license_removed');
    if (detail && !detailAt) warnings.push('detail_observation_time_not_provided');
    if (parts(detail?.skill_tags).length !== detailSkills.length) warnings.push('skill_noise_removed');
    const jdStatus = classifyJD(jd);
    const location = clean(raw.location).split('·').map(clean).filter(Boolean).join('·');
    const company = clean(raw.boss_name);
    const signals = {list: activity(raw.boss_active_status, listAt, 'list', identity.url, 'upstream_batch_scraped_at')};
    // Equal output may be upstream's list fallback. Never redate it as a fresh detail observation.
    if (detail && clean(detail.boss_active_status) && clean(detail.boss_active_status) !== clean(raw.boss_active_status))
      signals.detail = activity(detail.boss_active_status, detailAt, 'detail', identity.url, detailAt ? 'caller_detail_batch_time' : 'unknown');
    return {...identity, title: clean(raw.title), title_list_raw: raw.title,
      company, company_raw: String(raw.boss_name || ''), company_display_name: company,
      ...(detail?.company_identity && detail.company_identity.source_url === identity.url ? {company_identity: structuredClone(detail.company_identity)} : {}),
      ...(detail?.hiring_party ? {hiring_party: structuredClone(detail.hiring_party)} : {}),
      company_name_kind: /^某|某(?:大型|中型|小型|知名)/.test(company) ? 'anonymous_description' : 'display_name_unverified',
      salary: clean(raw.salary), salary_source: clean(raw.salary_source), location, locations: location ? [location] : [],
      company_scale: clean(raw.company_scale), company_stage: clean(raw.company_stage), company_industry: clean(raw.company_industry),
      company_id: clean(raw.encrypt_brand_id), company_url: companyLink(raw.company_link, raw.encrypt_brand_id),
      recruiter_id: clean(raw.encrypt_boss_id), recruiter_title: clean(raw.boss_title),
      requirements_raw: requirements, experience: experience.join(' / '), education: education.join(' / '),
      job_labels: parts(raw.job_labels), skills: unique([...skills, ...detailSkills]),
      ...splitTags([...requirements, ...parts(raw.job_labels), ...skills, ...detailSkills, ...parts(raw.welfare)]),
      jd, jd_raw: jdRaw, jd_status: jdStatus, jd_truncated: jdStatus === 'partial', jd_observed_at: detailAt,
      first_seen_at: listAt, last_seen_at: listAt, seen_count: 1, keywords: batch.keyword ? [batch.keyword] : [], source_urls: [identity.url],
      contact_status: 'unknown', data_source: 'boss-zhipin-scraper',
      // These are defaults for a NEW record, never evidence of an actual check.
      recruitment_signals: signalSnapshot(null, {}), recruitment_signal_history: [], recruitment_signals_by_page: {}, recruitment_signals_detail_checked_at: null,
      scraper_activity_observations: signals,
      scraper_source: {adapter_version: SCRAPER_ADAPTER_VERSION, observation_id: batchId, batch,
        list: structuredClone(raw), detail: detail ? structuredClone(detail) : null, warnings},
      scraper_access: {security_id: clean(raw.security_id), lid: clean(raw.lid)}};
  });
  for (const id of detailsById.keys()) if (!seen.has(id)) throw new Error('scraper_orphan_detail');
  return {schema_version: 2, label: label.trim(), collector_version: 'scraper-adapter-' + SCRAPER_ADAPTER_VERSION,
    exported_at: detailAt || listAt, export_scope: 'scraper_observation', jobs, runs: [], scraper_batch: batch};
}

// Allowlist merge: upstream cannot write project-owned fields. Empty upstream
// fields mean unavailable, not a deletion. All raw observations remain versioned.
export function mergeScraperJob(old, incoming) {
  if (!old) return incoming;
  if (old.id !== incoming.id) throw new Error('scraper_merge_identity_conflict');
  if (compareTitles(old.title, incoming.title).kind === 'conflict') return {...old,
    scraper_source: incoming.scraper_source, scraper_review: {state: 'needs_review', reason: 'title_conflict',
      expected_title: old.title, observed_title: incoming.title, observed_at: incoming.last_seen_at}};
  const result = {...old, scraper_source: incoming.scraper_source};
  if (incoming.hiring_party) result.hiring_party = incoming.hiring_party;
  if (incoming.company_identity && (!old.company_identity?.observed_at || incoming.company_identity.observed_at >= old.company_identity.observed_at)) {
    const previous = old.company_identity, next = incoming.company_identity;
    result.company_identity = previous?.state === 'platform_verified' && next.state === 'platform_verified' && previous.full_name !== next.full_name
      ? {...next, state: 'conflict', previous_full_name: previous.full_name} : next.state === 'not_displayed' && previous?.state === 'platform_verified' ? previous : next;
  }
  // A later detail batch may carry an older list snapshot. Do not roll back list fields.
  if (old.last_seen_at && incoming.last_seen_at < old.last_seen_at) {
    incoming = {...incoming};
    for (const f of ['title', 'salary', 'location', 'company', 'company_scale', 'company_stage', 'company_industry',
      'company_id', 'company_url', 'recruiter_id', 'recruiter_title', 'experience', 'education', 'title_list_raw']) incoming[f] = '';
  }
  const fields = ['title', 'salary', 'company_scale', 'company_stage', 'company_industry', 'company_id', 'company_url',
    'recruiter_id', 'recruiter_title', 'experience', 'education', 'title_list_raw'];
  for (const f of fields) if (incoming[f]) result[f] = incoming[f];
  if (incoming.salary) result.salary_source = incoming.salary_source;
  if (incoming.company) {
    result.company_display_name = incoming.company_display_name; result.company_name_kind = incoming.company_name_kind;
    if (!old.company || incoming.company_name_kind !== 'anonymous_description') {
      result.company = incoming.company; result.company_raw = incoming.company_raw;
      // A prior DOM company evidence must not be attributed to a changed API name.
      if (old.company !== result.company) result.company_evidence = {text: result.company, source_field: 'brandName',
        data_source: 'boss-zhipin-scraper', observed_at: incoming.last_seen_at, time_precision: 'batch'};
    }
  }
  const compact = s => clean(s).replace(/[·\s-]/g, '');
  if (incoming.location && !compact(old.location).startsWith(compact(incoming.location))) result.location = incoming.location;
  for (const f of ['locations', 'keywords', 'source_urls', 'requirements_raw', 'job_labels', 'skills'])
    result[f] = unique([...(old[f] || []), ...(incoming[f] || [])]);
  Object.assign(result, splitTags([...(old.tags_raw || old.tags || []), ...(old.benefits || []), ...(old.compensation_tags || []), ...(incoming.tags_raw || [])]));
  const rank = {missing: 0, partial: 1, short_unverified: 2, captured_unverified: 3};
  const jdNewEnough = !readableJD(old) || old.jd === incoming.jd || (incoming.jd_observed_at && (!old.jd_observed_at || incoming.jd_observed_at >= old.jd_observed_at));
  if (incoming.jd && jdNewEnough && (!old.jd || (readableJD(incoming) && (rank[incoming.jd_status] || 0) >= (rank[old.jd_status] || 0)))) {
    for (const f of ['jd', 'jd_raw', 'jd_status', 'jd_truncated', 'jd_observed_at']) result[f] = incoming[f];
    delete result.jd_display; // Recomputed for the accepted source, never retained from another JD.
    if (displayJD(result.jd) !== result.jd) result.jd_display = displayJD(result.jd);
    if (!incoming.jd_observed_at && incoming.jd === old.jd) result.jd_observed_at = old.jd_observed_at || null;
  }
  result.scraper_activity_observations = {...old.scraper_activity_observations};
  for (const [page, next] of Object.entries(incoming.scraper_activity_observations || {})) {
    const previous = result.scraper_activity_observations[page];
    if (!previous || (next.checked_at && (!previous.checked_at || next.checked_at >= previous.checked_at))) {
      if (previous?.recruiter_activity?.raw?.length && !next.recruiter_activity.raw.length) continue;
      result.scraper_activity_observations[page] = next;
    }
  }
  result.scraper_access = {...old.scraper_access};
  for (const [key, value] of Object.entries(incoming.scraper_access || {})) if (value) result.scraper_access[key] = value;
  result.seen_count = (old.seen_count || 0) + (old.scraper_source?.observation_id === incoming.scraper_source.observation_id ? 0 : 1);
  result.last_seen_at = old.last_seen_at && old.last_seen_at > incoming.last_seen_at ? old.last_seen_at : incoming.last_seen_at;
  if (result.company) result.quality_flags = (result.quality_flags || []).filter(f => f !== 'company_missing');
  // Only existing validated evidence can establish closed, headhunter or contacted states.
  return result;
}
