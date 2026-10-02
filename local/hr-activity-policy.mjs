import {activityDisplay,activityRecency} from './activity-display.mjs';

export const DEFAULT_HR_ACTIVITY=Object.freeze({enabled:false,maxDays:7,includeUnknown:true,includeHistorical:false});
export function normalizeHrActivity(value=DEFAULT_HR_ACTIVITY){
  if(!value||Array.isArray(value)||typeof value!=='object'||typeof value.enabled!=='boolean'||
    !Number.isInteger(value.maxDays)||value.maxDays<0||value.maxDays>3720||
    typeof value.includeUnknown!=='boolean'||typeof value.includeHistorical!=='boolean')throw new Error('invalid_hr_activity');
  return {enabled:value.enabled,maxDays:value.maxDays,includeUnknown:value.includeUnknown,includeHistorical:value.includeHistorical};
}
// A label with "前" supplies a conservative lower bound, never an exact timestamp.
function distantLowerBound(label){
  const v=String(label).normalize('NFKC').replace(/\s+/g,'');
  if(v==='半年前活跃')return 186;
  if(v==='一年前活跃')return 372;
  const m=v.match(/^([1-9]\d?|一|二|两|三|四|五|六|七|八|九|十)(日|天|周|个月|月|年)前活跃$/);
  if(!m)return null;
  const n=({一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}[m[1]])||Number(m[1]);
  return n*({日:1,天:1,周:7,个月:31,月:31,年:372}[m[2]]);
}
export function hrActivityDecision(job,policy=DEFAULT_HR_ACTIVITY){
  if(!policy.enabled)return {allowed:true,reason:'disabled'};
  const a=activityDisplay(job);
  if(a.state==='historical'&&!policy.includeHistorical)return {allowed:false,reason:'historical_excluded'};
  const tiers=a.raw.map(activityRecency).filter(v=>v!==null);
  if(tiers.some(v=>v<=policy.maxDays))return {allowed:true,reason:'within_range'};
  // Do not infer inactivity from fuzzy or absent evidence. All labels must be
  // definitely outside the selected range to use the outside_range reason.
  const outside=a.raw.length>0&&a.raw.every(label=>{
    const tier=activityRecency(label),lower=distantLowerBound(label);
    return tier!==null?tier>policy.maxDays:lower!==null&&lower>policy.maxDays;
  });
  if(outside)return {allowed:false,reason:'outside_range'};
  return {allowed:policy.includeUnknown,reason:policy.includeUnknown?'unknown_included':'unknown_excluded'};
}
export function hrActivityQueueState(state,decision){
  return ['pending','retry'].includes(state)&&!decision.allowed?'activity_skipped':state;
}
