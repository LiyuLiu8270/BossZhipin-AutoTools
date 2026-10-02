import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createContext,runInContext} from 'node:vm';
import {DEFAULT_HR_ACTIVITY,normalizeHrActivity,hrActivityDecision} from '../local/hr-activity-policy.mjs';
import {IntakeStore} from '../local/intake.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {WebController} from '../local/web-controller.mjs';
import {createWebHandler} from '../local/web-handler.mjs';
import {createIntakeServer} from '../local/service.mjs';
import {applyActivityCapture} from '../shared/activity.js';

const at='2026-09-30T01:00:00Z';
const signals=(raw,checked_at=at)=>({checked_at,page_type:'detail',recruiter_activity:{raw}});
const active=(label)=>({recruitment_signals:signals(label?[label]:[])});
const policy=(extra={})=>({...DEFAULT_HR_ACTIVITY,enabled:true,...extra});
const profile={target:'产品经理',facts:{C01:'参与企业服务需求调研，推动平台上线。'},boundaries:[]};
const runner=async(p,jobs)=>({output:{results:jobs.map(j=>({id:j.id,priority:'可以尝试',reason:'业务经验相关',evidence:[{fact_id:'C01',jd_quote:'企业服务需求调研',relation:'直接经验'}],gaps:['待核实'],questions:['业务方向？'],keywords:['B端产品经理'],greeting:'',greeting_fact_ids:[]}))}});
const greeting=()=>({output:{greeting:'您好，我参与过企业服务需求调研，并推动平台上线。希望进一步了解岗位的业务场景和职责范围。',greeting_fact_ids:['C01'],claims:[{text:'参与过企业服务需求调研，并推动平台上线',fact_id:'C01',quote:'参与企业服务需求调研，推动平台上线'}]}});
const job=(id,label)=>({id:'boss:'+id,url:'https://www.zhipin.com/job_detail/'+id+'.html',title:'B端产品经理',company:'合成公司',jd:'负责企业服务需求调研与产品设计，推动项目实施并与研发团队协作交付。'.repeat(8),jd_status:'captured_unverified',...active(label)});
function setup(options={}){
  const dataDir=mkdtempSync(join(tmpdir(),'hr-gate-')),store=new IntakeStore(join(dataDir,'jobs.sqlite'));
  const worker=new MatchWorker(store,profile,{dataDir,runner,greetingRunner:async()=>greeting(),...options}),controller=new WebController(store,worker);
  const add=(jobs,time=at)=>store.importPayload({schema_version:2,label:'synthetic',exported_at:time,jobs});
  return {dataDir,store,worker,controller,add};
}
const count=(worker,state,stage='states')=>worker.status()[stage].find(r=>r.state===state)?.count||0;

test('活跃条件累计包含，支持自定义范围、在线、中文/日历标签及未知',()=>{
  for(const label of ['在线','刚刚活跃','今日活跃','3日内活跃','本周活跃','一周内活跃'])assert.equal(hrActivityDecision(active(label),policy()).allowed,true,label);
  for(const label of ['2周内活跃','本月活跃','半年前活跃','一年前活跃'])assert.deepEqual(hrActivityDecision(active(label),policy()),{allowed:false,reason:'outside_range'},label);
  assert.equal(hrActivityDecision(active('本周活跃'),policy({maxDays:6})).allowed,false);
  assert.equal(hrActivityDecision(active('本月活跃'),policy({maxDays:31})).allowed,true);
  assert.equal(hrActivityDecision(active('在线'),policy({maxDays:0})).allowed,true);
  assert.equal(hrActivityDecision(active('今日活跃'),policy({maxDays:0})).allowed,false);
  for(const label of ['', '近期活跃','未识别原文']){
    assert.deepEqual(hrActivityDecision(active(label),policy()),{allowed:true,reason:'unknown_included'});
    assert.deepEqual(hrActivityDecision(active(label),policy({includeUnknown:false})),{allowed:false,reason:'unknown_excluded'});
  }
  assert.equal(hrActivityDecision(active('半年前活跃'),policy({maxDays:365,includeUnknown:false})).reason,'unknown_excluded');
  assert.equal(hrActivityDecision(active('半年前活跃'),DEFAULT_HR_ACTIVITY).allowed,true);
});

test('历史证据独立选择且仍须通过范围，最新证据优先，不更改观察',()=>{
  const j={recruitment_signals:signals([], '2026-10-01T01:00:00Z'),recruitment_signal_history:[signals(['本周活跃'])]};
  const before=JSON.stringify(j);
  assert.equal(hrActivityDecision(j,policy()).reason,'historical_excluded');
  assert.equal(hrActivityDecision(j,policy({includeHistorical:true})).allowed,true);
  assert.equal(hrActivityDecision(j,policy({includeHistorical:true,maxDays:1})).reason,'outside_range');
  assert.equal(JSON.stringify(j),before);
  j.recruitment_signals=signals(['半年前活跃'],'2026-10-01T01:00:00Z');
  assert.equal(hrActivityDecision(j,policy()).reason,'outside_range');
});

test('设置校验与重启持久化，旧客户端省略不重置、不改开关/预算/资料指纹',()=>{
  const e=setup();try{
    const hash=e.worker.profileHash;
    assert.deepEqual(e.controller.settings.hrActivity,DEFAULT_HR_ACTIVITY);
    const chosen=policy({maxDays:14,includeUnknown:false,includeHistorical:true});
    e.controller.saveSettings({...e.controller.settings,hrActivity:chosen});
    const {hrActivity,...legacy}=e.controller.settings;e.controller.saveSettings(legacy);
    assert.deepEqual(e.controller.settings.hrActivity,chosen);
    const restored=new WebController(e.store,e.worker);assert.deepEqual(restored.settings.hrActivity,chosen);
    assert.deepEqual(e.worker.hrActivity,chosen);assert.equal(e.worker.profileHash,hash);
    assert.equal(restored.settings.autoAnalyze,false);assert.equal(e.worker.status().daily_used,0);
    for(const invalid of [null,[],{},policy({enabled:1}),policy({maxDays:-1}),policy({maxDays:0.5}),policy({maxDays:3721}),policy({maxDays:'7'}),policy({includeUnknown:null})]){
      assert.throws(()=>normalizeHrActivity(invalid),/invalid_hr_activity/);
      assert.throws(()=>restored.saveSettings({...restored.settings,hrActivity:invalid}),/invalid_settings/);
      assert.deepEqual(restored.settings.hrActivity,chosen);
    }
  }finally{e.store.close();}
});

test('领取前过滤不饥饿，跳过不占额度、不改队列指纹，放宽即恢复',async()=>{
  const e=setup();try{
    e.add([job('a_inactive','本月活跃'),job('z_active','今日活跃'),job('b_unknown','')]);
    const before=e.store.db.prepare('SELECT * FROM intake_analysis_queue ORDER BY id').all(),hash=e.worker.profileHash;
    e.controller.saveSettings({...e.controller.settings,hrActivity:policy({includeUnknown:false})});
    assert.equal(count(e.worker,'pending'),1);assert.equal(count(e.worker,'activity_skipped'),2);
    assert.equal((await e.worker.step(1)).status,'completed');
    assert.equal(e.controller.detail('synthetic','boss:z_active').analysis_state,'completed');
    assert.equal((await e.worker.step()).status,'idle');assert.equal(e.worker.status().daily_used,1);
    assert.equal(e.store.db.prepare('SELECT COUNT(*) n FROM match_runs').get().n,1);
    const skipped=e.controller.detail('synthetic','boss:a_inactive');assert.equal(skipped.analysis_state,'activity_skipped');assert.equal(skipped.activity_gate.reason,'outside_range');
    assert.equal(e.controller.list().items.find(r=>r.id==='boss:a_inactive').analysis_state,'activity_skipped');
    assert.deepEqual(e.store.db.prepare('SELECT * FROM intake_analysis_queue ORDER BY id').all(),before);
    e.controller.saveSettings({...e.controller.settings,hrActivity:{...policy(),enabled:false}});
    assert.equal(count(e.worker,'activity_skipped'),0);assert.equal(count(e.worker,'pending'),2);
    assert.equal((await e.worker.step()).count,2);assert.equal(e.worker.profileHash,hash);
    assert.equal(e.controller.settings.autoAnalyze,false);
  }finally{e.store.close();}
});

test('招呼同样跳过且保留匹配结论，报告/抽屉/统计一致，已生成内容不删除',async()=>{
  const e=setup();try{
    e.add([job('one','本月活跃')]);await e.worker.step();
    const before=e.store.db.prepare('SELECT * FROM match_runs').all(),hash=e.worker.profileHash;
    e.controller.saveSettings({...e.controller.settings,hrActivity:policy()});
    assert.equal(count(e.worker,'completed'),1);assert.equal(count(e.worker,'activity_skipped','greeting_states'),1);
    assert.equal((await e.worker.greetingStep()).status,'idle');assert.equal(e.worker.status().daily_used,1);
    assert.equal(e.controller.detail('synthetic','boss:one').result.priority,'可以尝试');
    assert.equal(e.controller.detail('synthetic','boss:one').greeting_state,'activity_skipped');
    assert.equal(e.worker.render().jobs[0].greeting_state,'activity_skipped');
    e.controller.saveSettings({...e.controller.settings,hrActivity:policy({maxDays:31})});
    assert.equal((await e.worker.greetingStep()).status,'completed');
    const completed=e.controller.detail('synthetic','boss:one').result.greeting;
    e.controller.saveSettings({...e.controller.settings,hrActivity:policy({maxDays:0})});
    assert.equal(e.controller.detail('synthetic','boss:one').greeting_state,'completed');
    assert.equal(e.controller.detail('synthetic','boss:one').result.greeting,completed);
    assert.equal(e.worker.profileHash,hash);assert.deepEqual(e.store.db.prepare('SELECT * FROM match_runs').all(),before);
  }finally{e.store.close();}
});

test('失败重排仍受条件约束，条件改变不丢弃在途完成结果',async()=>{
  let release;const e=setup({runner:async(...args)=>{await new Promise(r=>release=r);return runner(...args);}});
  try{
    e.add([job('one','本月活跃')]);const running=e.worker.step(1);
    e.controller.saveSettings({...e.controller.settings,hrActivity:policy()});assert.equal(count(e.worker,'running'),1);
    release();assert.equal((await running).status,'completed');
    e.worker.greetingRunner=async()=>{throw new Error('codex_timeout');};
    e.controller.saveSettings({...e.controller.settings,hrActivity:{...policy(),enabled:false}});
    await e.worker.greetingStep();
    e.controller.saveSettings({...e.controller.settings,hrActivity:policy()});
    assert.equal(count(e.worker,'activity_skipped','greeting_states'),1);
    assert.equal(e.worker.retryFailed().greeting,1);assert.equal(count(e.worker,'activity_skipped','greeting_states'),1);
    assert.equal(count(e.worker,'retry','greeting_states'),0);assert.equal(count(e.worker,'pending','greeting_states'),0);
    const used=e.worker.status().daily_used;assert.equal((await e.worker.greetingStep()).status,'idle');assert.equal(e.worker.status().daily_used,used);
  }finally{e.store.close();}
});

test('同源 HTTP 设置、状态和列表反映跳过，不调用真实模型；非法值拒绝',async()=>{
  const e=setup(),token='a'.repeat(64),server=createIntakeServer({store:e.store,worker:e.worker,token});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
  server.removeAllListeners('request');const app=createIntakeServer({store:e.store,worker:e.worker,token,port,webHandler:createWebHandler({controller:e.controller,token,port})});server.on('request',app.listeners('request')[0]);
  const base='http://127.0.0.1:'+port;
  try{
    e.add([job('one','本月活跃')]);const root=await fetch(base),html=await root.text();assert.match(html,/id="hr-activity-enabled"/);assert.match(html,/id="hr-activity-status"/);
    const headers={Cookie:root.headers.get('set-cookie').split(';')[0],'X-Local-UI':'1',Origin:base,'Content-Type':'application/json'};
    const post=body=>fetch(base+'/api/settings',{method:'POST',headers,body:JSON.stringify(body)});
    assert.equal((await post({...e.controller.settings,hrActivity:policy({maxDays:-1})})).status,400);
    assert.equal((await post({...e.controller.settings,hrActivity:policy()})).status,200);
    const state=await(await fetch(base+'/api/state',{headers})).json();assert.equal(state.status.states[0].state,'activity_skipped');assert.equal(state.settings.autoAnalyze,false);
    const list=await(await fetch(base+'/api/jobs',{headers})).json();assert.equal(list.items[0].analysis_state,'activity_skipped');assert.equal(list.total,1);
    assert.equal(e.worker.status().daily_used,0);
  }finally{await new Promise(r=>server.close(r));e.store.close();}
});

test('补到更近期证据后自动恢复待处理而不改匹配指纹，匹配失败重排不绕过条件',async()=>{
  const e=setup({runner:async()=>{throw new Error('codex_timeout');}});try{
    e.add([job('one','本月活跃')]);await e.worker.step(1);
    const original=e.store.db.prepare('SELECT fingerprint FROM intake_analysis_queue').get().fingerprint;
    e.controller.saveSettings({...e.controller.settings,hrActivity:policy()});e.worker.retryFailed();
    assert.equal(count(e.worker,'activity_skipped'),1);assert.equal(e.worker.claim(1).rows.length,0);
    const stored=e.store.get('synthetic','boss:one'),updated=applyActivityCapture({jobs:{[stored.id]:stored}},
      {status:'captured',source_url:stored.url,jobs:[{url:stored.url,recruitment_signals:{recruiter_activity:[{text:'今日活跃',selector:'.boss-info span'}]}}]},stored.id,'2026-10-01T01:00:00Z').dataset.jobs[stored.id];
    e.add([updated],'2026-10-01T01:00:00Z');
    assert.equal(e.store.db.prepare('SELECT fingerprint FROM intake_analysis_queue').get().fingerprint,original);
    assert.equal(count(e.worker,'activity_skipped'),0);assert.equal(count(e.worker,'pending'),1);
    assert.equal(e.worker.claim(1).rows.length,1);
  }finally{e.store.close();}
});

test('运行设置前端真实处理函数读取/保存用户范围和独立选项，开关控制输入',()=>{
  const source=readFileSync(new URL('../local/web/app.js',import.meta.url),'utf8'),nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,disabled:false});return nodes.get(id);};
  const state={settings:{hrActivity:policy({maxDays:14,includeUnknown:false,includeHistorical:true})}},context=createContext({$,state});
  runInContext(source.slice(source.indexOf('function loadHrActivitySettings('),source.indexOf('const contacts=')),context);
  runInContext('loadHrActivitySettings()',context);assert.equal($('#hr-activity-days').value,14);assert.equal($('#hr-activity-days').disabled,false);
  $('#hr-activity-enabled').checked=false;runInContext('syncHrActivityInputs()',context);assert.equal($('#hr-activity-days').disabled,true);
  const read=JSON.parse(JSON.stringify(runInContext('readHrActivitySettings()',context)));
  assert.deepEqual(read,{enabled:false,maxDays:14,includeUnknown:false,includeHistorical:true});
});
