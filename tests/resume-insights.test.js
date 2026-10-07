import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createWebHandler} from '../local/web-handler.mjs';
import {IntakeStore} from '../local/intake.mjs';
import {WebController} from '../local/web-controller.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {resumeProfile,privateText} from '../local/resume-profile.mjs';
import {promptFor} from '../local/codex-runner.mjs';
import {ResumeInsights,validateInsight,DIMENSIONS,insightsPrompt} from '../local/resume-insights.mjs';
const doc={id:'doc1',sha256:'hash',filename:'resume.docx',text:'参与企业系统需求梳理。\n\n负责跨团队交付验证。',blocks:[{id:'B0001',text:'参与企业系统需求梳理。'},{id:'B0002',text:'负责跨团队交付验证。'}],warnings:[]};
const evidence=[{block_id:'B0001',quote:'企业系统需求梳理'}];
const roles={kind:'roles',summary:'适合企业服务产品方向',roles:[{keyword:'B端产品经理',fit:'直接匹配',reason:'有业务需求梳理经验',evidence,gaps:['行业待核实']}],dimensions:[],strengths:[],improvements:[],limitations:['无具体JD'],total:null,score_reason:''};
const score={kind:'score',summary:'内容评价',roles:[],dimensions:[{id:'business',name:'业务分析证据',score:82,reason:'具备需求分析经验',evidence},{id:'delivery',name:'交付能力表达',score:68,reason:'成果细节还可补充',evidence}],total:73,score_reason:'综合考虑业务分析及交付成果表达，非各项求和',strengths:['职责明确'],improvements:[{issue:'结果需更具体',action:'补充真实交付成果，不编造数字',evidence}],limitations:['未查看原始排版']};
function setup(runner){
 const store=new IntakeStore(':memory:'),worker=new MatchWorker(store,{mode:'resume_missing',facts:{}},{dataDir:mkdtempSync(join(tmpdir(),'resume-insights-')),runner:async()=>{throw new Error('unexpected_match_call');}});
 const controller=new WebController(store,worker,{resumeOnly:true});
 controller.resumeDocuments.parser=async()=>doc;
 const insights=new ResumeInsights(controller,{runner});controller.resumeInsights=insights;
 return {store,worker,controller,insights};
}
const upload={filename:'resume.docx',base64:Buffer.from('synthetic').toString('base64')};
test('岗位解析和评分均使用已保存Skill及完整事实，不混入招呼风格',async()=>{
 const prompts=[],e=setup(async(prompt)=>{prompts.push(prompt);return {output:prompt.includes('kind=roles')?roles:score};});try{
  await e.controller.importResume(upload);
  e.controller.saveMatchingPolicy({matchingSkill:'  优先分析跨团队交付\r\n区分参与与主导  ',greetingStyle:'风格哨兵不应进入评价'});
  for(const kind of ['roles','score']){
   e.insights.start({kind,resume_id:e.controller.resumeDocuments.current().id});await e.insights.promise;
   const run=e.insights.status()[kind];assert.equal(run.state,'completed');assert.equal(run.outdated,false);assert.equal(run.matching_skill_applied,true);
   const prompt=prompts.at(-1);assert.equal(JSON.parse(prompt.split('MATCHING_SKILL_JSON:\n')[1].split('\nINPUT_DATA_JSON:')[0]),'优先分析跨团队交付\n区分参与与主导');
   assert.deepEqual(JSON.parse(prompt.split('INPUT_DATA_JSON:\n')[1]).resume.facts,resumeProfile(doc).facts);assert.doesNotMatch(prompt,/风格哨兵/);
  }
  e.controller.saveMatchingPolicy({...e.worker.policy,greetingStyle:'另一种风格'});
  assert.equal(e.insights.status().roles.outdated,false);assert.equal(e.insights.status().score.outdated,false);
  e.controller.saveMatchingPolicy({...e.worker.policy,matchingSkill:'改成强调业务分析'});
  assert.equal(e.insights.status().roles.outdated,true);assert.equal(e.insights.status().score.outdated,true);
  assert.equal(e.insights.status().score.result.total,73);assert.equal(prompts.length,2);
 }finally{e.store.close();}
});
test('开始时冻结Skill，运行中修改仅标旧，不丢结果；留空仍可分析',async()=>{
 let release,captured;const e=setup(prompt=>{captured=prompt;return new Promise(ok=>{release=ok;});});try{
  await e.controller.importResume(upload);const id=e.controller.resumeDocuments.current().id;
  e.controller.saveMatchingPolicy({matchingSkill:'任务开始前规则'});e.insights.start({kind:'score',resume_id:id});
  e.controller.saveMatchingPolicy({matchingSkill:'任务开始后规则'});await new Promise(r=>setImmediate(r));release({output:score});await e.insights.promise;
  assert.match(captured,/任务开始前规则/);assert.doesNotMatch(captured,/任务开始后规则/);assert.equal(e.insights.status().score.outdated,true);
  assert.equal(new ResumeInsights(e.controller).status().score.outdated,true);
  e.controller.saveMatchingPolicy({});e.insights.runner=async()=>({output:roles});e.insights.start({kind:'roles',resume_id:id});await e.insights.promise;
  assert.equal(e.insights.status().roles.matching_skill_applied,false);assert.equal(e.insights.status().roles.outdated,false);
  assert.match(insightsPrompt('score',doc),/MATCHING_SKILL_JSON:\n""/);
 }finally{e.store.close();}
});

test('简历分析等待共享名额，领取时占每日额度；排队中换简历不调用模型',async()=>{
 let calls=0,release;const e=setup(async()=>{calls++;return {output:score};});
 try{
  await e.controller.importResume(upload);const id=e.controller.resumeDocuments.current().id;
  const hold=e.controller.modelQueue.submit({id:'held',kind:'research',run:()=>new Promise(r=>{release=r;})});await new Promise(r=>setImmediate(r));
  e.insights.start({kind:'score',resume_id:id});await new Promise(r=>setImmediate(r));assert.equal(calls,0);assert.equal(e.insights.status().score.phase,'waiting_model');
  release();await hold;await e.insights.promise;assert.equal(calls,1);assert.equal(e.worker.status().daily_used,1);
  e.worker.dailyLimit=1;e.insights.start({kind:'score',resume_id:id});await e.insights.promise;assert.equal(calls,1);assert.equal(e.insights.status().score.error,'daily_limit');
  e.worker.dailyLimit=10;const hold2=e.controller.modelQueue.submit({id:'held2',kind:'research',run:()=>new Promise(r=>{release=r;})});await new Promise(r=>setImmediate(r));
  e.insights.start({kind:'score',resume_id:id});await e.controller.importResume({...upload,base64:Buffer.from('changed').toString('base64')});release();await hold2;await e.insights.promise;
  assert.equal(calls,1);assert.equal(e.worker.status().daily_used,1);
 }finally{release?.();await e.controller.modelQueue.close();e.store.close();}
});
test('全文逐段进入匹配，不混入旧摘要，遮蔽联系方式而保留工作细节',()=>{
 const p=resumeProfile(doc);assert.deepEqual(Object.values(p.facts),doc.blocks.map(b=>b.text));assert.equal(p.mode,'resume_fulltext');
 assert.match(promptFor(p,[]),/负责跨团队交付验证/);assert.equal(p.target,undefined);
 assert.equal(privateText('电话13800138000，邮箱 test@example.com，项目300万'),'电话[手机号已隐藏]，邮箱 [邮箱已隐藏]，项目300万');
});
test('生产模式拒绝旧摘要覆盖；新简历版本更换hash，同文件不变，自动分析开关不变',async()=>{
 const e=setup();try{
  e.controller.write('profile',{target:'旧摘要',facts:{C01:'虚拟旧信息'}});
  const missing=e.worker.profileHash;await e.controller.importResume(upload);assert.notEqual(e.worker.profileHash,missing);
  assert.deepEqual(Object.values(e.worker.profile.facts),doc.blocks.map(b=>b.text));const hash=e.worker.profileHash;
  await e.controller.importResume(upload);assert.equal(e.worker.profileHash,hash);assert.equal(e.controller.settings.autoAnalyze,false);
  const restored=new WebController(e.store,e.worker,{resumeOnly:true});assert.equal(restored.worker.profileHash,hash);assert.throws(()=>restored.saveProfile({}),/resume_only/);
  e.controller.busy=true;await assert.rejects(e.controller.importResume(upload),/analysis_busy/);
 }finally{e.store.close();}
});
test('维度和整体分由AI决定，程序仅校验结构、范围和引文',()=>{
 assert.equal(validateInsight(score,'score',doc).total,73);
 assert.equal(validateInsight({...score,total:100},'score',doc).total,100);
 assert.equal(validateInsight({...score,total:null,dimensions:[]},'score',doc).total,null);
 assert.throws(()=>validateInsight({...score,total:101},'score',doc),/invalid/);
 assert.throws(()=>validateInsight({...roles,roles:[null]},'roles',doc),/invalid/);
 assert.throws(()=>validateInsight({...roles,roles:[{...roles.roles[0],evidence:[{block_id:'B0001',quote:'不存在的经历'}]}]},'roles',doc),/evidence/);
 assert.throws(()=>validateInsight({...score,dimensions:score.dimensions.map(d=>({...d,id:'clarity'}))},'score',doc),/invalid/);
 assert.throws(()=>validateInsight({...roles,roles:[{...roles.roles[0],keyword:'产品经理\n自动启用'}]},'roles',doc),/invalid/);
});

test('全文资料接口鉴权、异步分析、拒绝旧摘要写入与结果重载',async()=>{
 const e=setup(async()=>({output:roles})),server=createServer();
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port,base=`http://127.0.0.1:${port}`;
 server.on('request',createWebHandler({controller:e.controller,port,token:'t'.repeat(64)}));
 try{
  const root=await fetch(base),html=await root.text(),cookie=root.headers.get('set-cookie').split(';')[0];
  assert.match(html,/岗位解析/);assert.match(html,/简历评分/);assert.doesNotMatch(html,/id="profile-form"/);
  const headers={Cookie:cookie,'X-Local-UI':'1',Origin:base,'Content-Type':'application/json'};
  const post=(path,body)=>fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/api/profile/insights')).status,403);
  assert.equal((await post('/api/profile/insights',{kind:'roles',resume_id:'x'})).status,400);
  assert.equal((await post('/api/profile',{})).status,400);
  const imported=await (await post('/api/profile/resume',upload)).json();assert.equal(imported.document.matching_connected,true);
  const body={kind:'roles',resume_id:imported.document.id};
  assert.equal((await fetch(base+'/api/profile/insights',{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:JSON.stringify(body)})).status,403);
  assert.equal((await post('/api/profile/insights',{...body,resume_id:'wrong'})).status,400);
  const started=await post('/api/profile/insights',body);assert.equal(started.status,202);assert.equal((await started.json()).state,'running');await e.insights.promise;
  const status=await (await fetch(base+'/api/profile/insights',{headers})).json();assert.equal(status.roles.state,'completed');assert.equal(status.roles.requires_confirmation,true);assert.deepEqual(e.controller.settings.keywords,[]);
  assert.equal(new ResumeInsights(e.controller).status().roles.id,status.roles.id);
  const profile=await (await fetch(base+'/api/profile',{headers})).json();assert.equal(profile.mode,'resume_fulltext');assert.equal(profile.target,undefined);assert.deepEqual(Object.keys(profile.facts),['B0001','B0002']);
 }finally{await new Promise(r=>server.close(r));e.store.close();}
});
test('岗位解析只建议不自动加入；保留停用词和最新设置，评分不改变关键词',async()=>{
 let release;const e=setup(()=>new Promise(ok=>{release=ok;}));try{
  await e.controller.importResume(upload);const current=e.controller.resumeDocuments.current();
  e.insights.start({kind:'roles',resume_id:current.id});assert.throws(()=>e.insights.start({kind:'score',resume_id:current.id}),/busy/);
  e.controller.saveSettings({...e.controller.settings,keywords:[{text:'B端产品经理',enabled:false},{text:'现有词',enabled:true}]});
  await new Promise(r=>setImmediate(r));const extra={...roles.roles[0],keyword:'企业服务产品经理'};release({output:{...roles,roles:[...roles.roles,extra]}});await e.insights.promise;
  assert.equal(e.insights.status().roles.state,'completed');assert.equal(e.insights.status().roles.requires_confirmation,true);
  assert.deepEqual(e.controller.settings.keywords,[{text:'B端产品经理',enabled:false},{text:'现有词',enabled:true}]);
  const before=JSON.stringify(e.controller.settings);e.insights.runner=async()=>({output:score});e.insights.start({kind:'score',resume_id:current.id});await e.insights.promise;
  assert.equal(e.insights.status().score.result.total,73);assert.equal(JSON.stringify(e.controller.settings),before);
 }finally{e.store.close();}
});
test('简历更换、无简历、模型失败、假引文都不得同步关键词',async()=>{
 let release;const e=setup(()=>new Promise(ok=>{release=ok;}));try{
  assert.throws(()=>e.insights.start({kind:'roles',resume_id:'x'}),/resume_required/);
  await e.controller.importResume(upload);const old=e.controller.resumeDocuments.current();e.insights.start({kind:'roles',resume_id:old.id});
  await new Promise(r=>setImmediate(r));await e.controller.importResume({...upload,base64:Buffer.from('new').toString('base64')});release({output:roles});await e.insights.promise;
  assert.equal(e.controller.settings.keywords.length,0);assert.equal(e.insights.status().roles,null);
  const current=e.controller.resumeDocuments.current();e.insights.runner=async()=>{throw new Error('codex_turn_failed');};e.insights.start({kind:'roles',resume_id:current.id});await e.insights.promise;
  assert.equal(e.insights.status().roles.error,'codex_turn_failed');assert.equal(e.controller.settings.keywords.length,0);
  e.insights.runner=async()=>({output:{...roles,roles:[{...roles.roles[0],evidence:[{block_id:'B0001',quote:'编造的产品经验'}]}]}});e.insights.start({kind:'roles',resume_id:current.id});await e.insights.promise;
  assert.equal(e.insights.status().roles.error,'insight_evidence_invalid');assert.equal(e.controller.settings.keywords.length,0);
 }finally{e.store.close();}
});

test('评价使用当前模块的固定格式快照并记录失败阶段，旧失败明确标为旧版本',async()=>{
 const e=setup(async(_,options)=>{assert.ok(options.schema.hash);assert.ok(options.schema.text.includes('score_reason'));assert.equal(options.schemaPath,undefined);assert.equal(options.diagnosticContext.stage,'resume_score');return {output:score};});try{
  await e.controller.importResume(upload);const current=e.controller.resumeDocuments.current();e.insights.start({kind:'score',resume_id:current.id});await e.insights.promise;assert.equal(e.insights.status().score.state,'completed');assert.equal(e.insights.status().score.outdated,false);
  const legacy={...e.insights.status().score,id:'legacy',version:'resume-insights-v1',state:'failed',error:'insight_invalid'};e.insights.save(legacy);assert.equal(e.insights.status().score.outdated,true);
  e.insights.runner=async()=>({output:{invalid:true}});e.insights.start({kind:'score',resume_id:current.id});await e.insights.promise;assert.equal(e.insights.status().score.failure_stage,'validating_output');assert.match(e.insights.status().score.schema_hash,/^[a-f0-9]{64}$/);
 }finally{e.store.close();}
});
