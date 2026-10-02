// Explicit visible text badges or user-confirmed static icons. No company inference.
const badgeType = text => /^(猎头|猎头代招)$/.test(text) ? 'headhunter' : text === '代招' ? 'agency' : null;
const iconRules = new Map([
  ['https://img.bosszhipin.com/static/file/2022/cbdau7t7qt1661512634122.png', {text: '猎头', rule: 'boss-headhunter-static-icon-v1'}],
  ['https://img.bosszhipin.com/static/file/2022/xkthl0qxyk1661512634054.png', {text: '代招', rule: 'boss-agency-static-icon-v1'}]
]);
export function hiringParty(raw, context) {
  if (!raw || !Array.isArray(raw.evidence)) return null;
  const evidence = raw.evidence.filter(e => e?.field === 'type' && badgeType(e.text) && typeof e.selector === 'string' &&
    (!e.image_url || iconRules.get(e.image_url)?.text === e.text)).map(e => ({field: 'type', text: e.text, selector: e.selector,
    ...(e.raw_text ? {raw_text: String(e.raw_text).slice(0, 220)} : {}), ...(e.rendered_as ? {rendered_as: e.rendered_as} : {}), ...(e.node ? {node: e.node} : {}),
    ...(e.image_url ? {image_url: e.image_url, recognition_rule: iconRules.get(e.image_url).rule} : {})}));
  if (!evidence.length) return null;
  const types = [...new Set(evidence.map(e => badgeType(e.text)))];
  return {type: types.length === 1 ? types[0] : 'conflicting', evidence, source_url: context.url, observed_at: context.observed_at, page_type: context.page_type};
}
const hasType = (job, type) => job?.hiring_party?.type === type &&
  Array.isArray(job.hiring_party.evidence) && job.hiring_party.evidence.some(e => e?.field === 'type' && badgeType(e.text) === type && typeof e.selector === 'string');
export const isHeadhunter = job => hasType(job, 'headhunter');
export const isAgency = job => hasType(job, 'agency');
export const isCompanyExempt = job => isHeadhunter(job) || isAgency(job);

export function applyHiringParty(job, party) {
  let next = party ? {...job, hiring_party: party} : job;
  if (!isCompanyExempt(next)) return next;
  const type = next.hiring_party.type;
  // Company stays unknown; only the missing-company requirement is exempted.
  if (next.quality_flags?.includes('company_missing')) next = {...next, quality_flags: next.quality_flags.filter(f => f !== 'company_missing')};
  if (!String(next.company || '').trim() && next.company_check?.state === 'needs_review' &&
      (!next.company_check.reason || next.company_check.reason === 'company_not_identified')) {
    next = {...next, company_check: {state: 'not_required', reason: type + '_badge',
      policy: type + '_company_exempt_v1', previous_check: next.company_check}};
  } else if (next.company_check?.state === 'not_required' && ['headhunter_badge', 'agency_badge'].includes(next.company_check.reason) && next.company_check.reason !== type + '_badge') {
    next = {...next, company_check: {...next.company_check, reason: type + '_badge', policy: type + '_company_exempt_v1'}};
  }
  return next;
}
