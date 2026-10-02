import test from 'node:test';
import assert from 'node:assert/strict';
import {activityDisplay,activityReport,activityMatches,activityFilterLabels,activityRecency,activityFilterOptions} from '../local/activity-display.mjs';
const snapshot=(at,raw=[],page='detail')=>({checked_at:at,page_type:page,recruiter_activity:{raw}});
const t1='2026-09-28T22:00:00Z',t2='2026-09-29T22:00:00Z';
test('累计活跃范围逐级包含，较早/模糊/未知标签不混入，不修改原始证据',()=>{
 const labels=['在线','刚刚活跃','今日活跃','3日内活跃','本周活跃','2周内活跃','本月活跃','2月内活跃','4月内活跃'];
 const jobs=labels.map(label=>({recruitment_signals:snapshot(t2,[label])})),before=JSON.stringify(jobs);
 for(const [range,count] of [[0,2],[1,3],[3,4],[7,5],[14,6],[31,7],[62,8],[124,9]]){
  assert.deepEqual(jobs.filter(job=>activityMatches(job,'within:'+range)),jobs.slice(0,count));
 }
 for(const label of ['半年前活跃','一年前活跃','近期活跃','不活跃','3天前活跃','非在线']){
  const job={recruitment_signals:snapshot(t2,[label])};assert.equal(activityMatches(job,'within:186'),false);assert.equal(activityMatches(job,'label:'+label),true);
 }
 assert.equal(activityMatches({},'within:31'),false);
 for(const invalid of ['within:','within:no','within:Infinity','within:-1','within:999999'])assert.equal(activityMatches(jobs[0],invalid),false);
 assert.equal(JSON.stringify(jobs),before);
});
test('筛选项按近期到远期排列，中文/单位同义标签归一，历史仍显式标注',()=>{
 assert.equal(activityRecency('三日内活跃'),3);assert.equal(activityRecency('３天内活跃'),3);
 assert.equal(activityRecency('两周内活跃'),14);assert.equal(activityRecency('1个月内活跃'),31);
 assert.equal(activityRecency('半年内活跃'),186);assert.equal(activityRecency('半年前活跃'),null);
 const old={recruitment_signals:snapshot(t2),recruitment_signal_history:[snapshot(t1,['今日活跃'])]};
 assert.equal(activityMatches(old,'within:7'),true);assert.equal(activityDisplay(old).state,'historical');
 const options=activityFilterOptions([old,...['本周活跃','7日内活跃','2月内活跃','半年前活跃','近期活跃'].map(label=>({recruitment_signals:snapshot(t2,[label])}))]);
 assert.equal(options.filter(([value])=>value==='within:7').length,1);assert.ok(options.some(([value])=>value==='within:62'));
 assert.ok(options.some(([value])=>value==='label:半年前活跃'));assert.ok(options.some(([value])=>value==='label:近期活跃'));
 assert.deepEqual(options.filter(([value])=>value.startsWith('within:')).map(([value])=>Number(value.slice(7))),[0,1,3,7,14,31,62]);
});
test('活跃筛选按原文精确匹配，未知独立，历史标签可筛但不冒充当前在线',()=>{
 const observed={recruitment_signals:snapshot(t2,['今日活跃'])},old={recruitment_signals:snapshot(t2),recruitment_signal_history:[snapshot(t1,['在线'])]};
 assert.equal(activityMatches(observed,'label:今日活跃'),true);assert.equal(activityMatches(observed,'label:活跃'),false);
 assert.equal(activityMatches(old,'label:在线'),true);assert.equal(activityMatches(old,'state:historical'),true);assert.equal(activityDisplay(old).state,'historical');
 assert.equal(activityMatches({},'state:unknown'),true);assert.equal(activityMatches({},'label:半年前活跃'),false);
 assert.equal(activityMatches(observed,'state:unknown'),false);assert.equal(activityMatches({},''),true);
 assert.deepEqual(new Set(activityFilterLabels([observed,observed,old,{}])),new Set(['今日活跃','在线']));
});
test('列表空快照不隐藏已存详情记录，不覆盖原始数据',()=>{
 const job={recruitment_signals:snapshot(t2,[],'list'),recruitment_signals_by_page:{detail:snapshot(t1,['今日活跃'])}},before=JSON.stringify(job);
 assert.deepEqual(activityDisplay(job),{state:'historical',raw:['今日活跃'],observed_at:t1,page_type:'detail',latest_checked_at:t2,latest_page_type:'list',reason:null});
 assert.equal(JSON.stringify(job),before);assert.match(activityReport(job),/历史记录/);assert.match(activityReport(job),/不代表当前在线/);
});
test('按时间选择最新的有效证据，不强行优先详情，不拼接不同观察',()=>{
 const job={recruitment_signals:snapshot(t2,['在线'],'list'),recruitment_signals_by_page:{detail:snapshot(t1,['今日活跃'])}};
 assert.equal(activityDisplay(job).state,'observed');assert.deepEqual(activityDisplay(job).raw,['在线']);
});
test('详情最近未读到时，可以引用更早历史且标明缺失',()=>{
 const job={recruitment_signals:snapshot(t2),recruitment_signal_history:[snapshot(t1,['本周活跃'])]};
 assert.equal(activityDisplay(job).state,'historical');assert.equal(activityDisplay(job).observed_at,t1);
});
test('没有证据保留未知，区分未检查与检查未读到；猎头代招不推断',()=>{
 for(const type of ['headhunter','agency','unknown']){
  assert.equal(activityDisplay({hiring_party:{type}}).reason,'detail_not_checked');
  const a=activityDisplay({hiring_party:{type},recruitment_signals_detail_checked_at:t1,recruitment_signals:snapshot(t1)});
  assert.equal(a.reason,'not_observed');assert.deepEqual(a.raw,[]);
 }
});
test('无时间的历史证据不冒充最新，当前无时间证据如实保留',()=>{
 assert.equal(activityDisplay({recruitment_signal_history:[snapshot('bad',['今日活跃'])]}).state,'unknown');
 const a=activityDisplay({recruitment_signals:snapshot(null,['在线'])});assert.equal(a.observed_at,null);assert.deepEqual(a.raw,['在线']);
});
test('旧快照原始字段为空或类型异常不报错',()=>{
 for(const job of [{},{recruitment_signals:null},{recruitment_signals:{recruiter_activity:{raw:'在线'}}}])assert.equal(activityDisplay(job).state,'unknown');
});
