// Presentation only. Never rewrite observations, queue fingerprints or model results.
import {activitySnapshots} from '../shared/activity.js';
export function activityDisplay(job){
  const current=job.recruitment_signals;
  const snapshots=activitySnapshots(job);
  const raw=s=>Array.isArray(s?.recruiter_activity?.raw)?s.recruiter_activity.raw.filter(v=>typeof v==='string'&&v.trim()).map(v=>v.trim()):[];
  const time=s=>typeof s?.checked_at==='string'?Date.parse(s.checked_at):NaN;
  const dated=snapshots.filter(s=>Number.isFinite(time(s))).sort((a,b)=>time(b)-time(a));
  const latest=dated[0]||current;
  // Undated historical evidence cannot reliably be ordered and is not promoted.
  const observed=dated.find(s=>raw(s).length)||(raw(current).length?current:null);
  const historical=Boolean(observed&&observed!==latest&&(time(observed)!==time(latest)||!raw(latest).length));
  return {
    state:observed?(historical?'historical':'observed'):'unknown',raw:observed?raw(observed):[],
    observed_at:observed&&Number.isFinite(time(observed))?observed.checked_at:null,
    page_type:observed?.page_type||null,
    latest_checked_at:latest&&Number.isFinite(time(latest))?latest.checked_at:null,
    latest_page_type:latest?.page_type||null,
    ...(observed?.time_precision ? {time_precision:observed.time_precision,time_basis:observed.time_basis} : {}),
    reason:observed?null:job.activity_check?.reason==='title_conflict'?'identity_conflict':job.activity_check?.reason==='recruiter_panel_without_activity'?'not_displayed':job.activity_check?.reason==='activity_label_unrecognized'?'label_unrecognized':job.activity_check?.snapshot||job.recruitment_signals_detail_checked_at?'not_observed':'detail_not_checked'
  };
}
export function activityReport(job){
  const a=activityDisplay(job),page={list:'列表页',detail:'详情页'}[a.page_type]||'来源未记录';
  if(a.state==='unknown')return `未知（${a.reason==='identity_conflict'?'岗位身份待核对，未采纳本次状态':a.reason==='detail_not_checked'?'尚未完成详情状态采集':a.reason==='not_displayed'?'招聘者区块已加载，页面未展示活跃标签':a.reason==='label_unrecognized'?'存在未识别的活跃标签，待核查':'已检查但未读到活跃标签'}）；不等于不活跃`;
  return `${a.state==='historical'?'历史记录':'采集记录'}：${a.raw.join('、')}；${a.time_precision==='batch'?'采集批次时间（非精确观察时间）':'观察时间'}：${a.observed_at||'未记录'}；来源：${page}${a.state==='historical'?`；最新检查 ${a.latest_checked_at||'时间未记录'} 未读到标签`:''}；原文相对于观察时刻，不代表当前在线`;
}
// Relative label ordering only, not a reconstructed last-online timestamp.
// Calendar labels (本周/本月) use the same product tier as 7日/1月内.
export function activityRecency(label){
  const value=String(label).normalize('NFKC').replace(/\s+/g,'');
  const known={'在线':0,'当前在线':0,'刚刚活跃':0,'今日活跃':1,'今天活跃':1,'本周活跃':7,'本月活跃':31,'半年内活跃':186,'一年内活跃':372};
  if(Object.hasOwn(known,value))return known[value];
  const match=value.match(/^([1-9]\d?|一|二|两|三|四|五|六|七|八|九|十)(分钟|小时|日|天|周|个月|月|年)内活跃$/);
  if(!match)return null;
  const numbers={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  const n=numbers[match[1]]||Number(match[1]);
  return n*({分钟:1/1440,小时:1/24,日:1,天:1,周:7,个月:31,月:31,年:372}[match[2]]);
}
export function activityFilterOptions(jobs){
  const labels=activityFilterLabels(jobs),ranges=new Map([[0,'在线 / 刚刚活跃'],[1,'今日及更近期'],[3,'3日内及更近期'],[7,'本周及更近期'],[14,'2周内及更近期'],[31,'本月及更近期']]);
  for(const label of labels){const tier=activityRecency(label);if(tier!==null&&!ranges.has(tier))ranges.set(tier,label.replace(/活跃$/,'')+'及更近期');}
  return [['','全部活跃状态'],...[...ranges].sort(([a],[b])=>a-b).map(([tier,label])=>['within:'+tier,label]),
    ['state:unknown','未知 / 未采到'],['state:historical','仅历史记录'],...labels.filter(label=>activityRecency(label)===null).map(label=>['label:'+label,'原文：'+label])];
}
export function activityMatches(job,filter=''){
  if(!filter)return true;
  const a=activityDisplay(job);
  if(filter==='state:unknown')return a.state==='unknown';
  if(filter==='state:historical')return a.state==='historical';
  if(filter.startsWith('within:')){
    const raw=filter.slice(7),limit=Number(raw);
    if(!raw||!Number.isFinite(limit)||limit<0||limit>36828)return false;
    return a.raw.some(label=>{const tier=activityRecency(label);return tier!==null&&tier<=limit;});
  }
  return filter.startsWith('label:')&&a.raw.includes(filter.slice(6));
}
export function activityFilterLabels(jobs){
  return [...new Set(jobs.flatMap(job=>activityDisplay(job).raw))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
}
