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
import {ResumeInsights,validateInsight,DIMENSIONS} from '../local/resume-insights.mjs';
const doc={id:'doc1',sha256:'hash',filename:'resume.docx',text:'参与企业系统需求梳理。\n\n负责跨团队交付验证。',blocks:[{id:'B0001',text:'参与企业系统需求梳理。'},{id:'B0002',text:'负责跨团队交付验证。'}],warnings:[]};
const evidence=[{block_id:'B0001',quote:'企业系统需求梳理'}];
const roles={kind:'roles',summary:'适合企业服务产品方向',roles:[{keyword:'B端产品经理',fit:'直接匹配',reason:'有业务需求梳理经验',evidence,gaps:['行业待核实']}],dimensions:[],strengths:[],improvements:[],limitations:['无具体JD']};
const score={kind:'score',summary:'内容评价',roles:[],dimensions:Object.keys(DIMENSIONS).map(id=>({id,score:15,reason:'有事实描述，细节可补充',evidence})),strengths:['职责明确'],improvements:[{issue:'结果需更具体',action:'补充真实交付成果，不编造数字',evidence}],limitations:['未查看原始排版']};
function setup(runner){
 const store=new IntakeStore(':memory:'),worker=new MatchWorker(store,{mode:'resume_missing',facts:{}},{dataDir:mkdtempSync(join(tmpdir(),'resume-insights-')),runner:async()=>{throw new Error('unexpected_match_call');}});
 const controller=new WebController(store,worker,{resumeOnly:true});
 controller.resumeDocuments.parser=async()=>doc;
 const insights=new ResumeInsights(controller,{runner});controller.resumeInsights=insights;
 return {store,worker,controller,insights};
}
const upload={filename:'resume.docx',base64:Buffer.from('synthetic').toString('base64')};
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
test('引文和维度校验，分数由程序相加，不接受虚构引用或重复维度',()=>{
  assert.equal(validateInsight(score,'score',doc).total,75);
 assert.throws(()=>validateInsight({...score,total:100},'score',doc),/invalid/);
 assert.throws(()=>validateInsight({...roles,roles:[null]},'roles',doc),/invalid/);
 assert.throws(()=>validateInsight({...roles,roles:[{...roles.roles[0],evidence:[{block_id:'B0001',quote:'不存在的经历'}]}]},'roles',doc),/evidence/);
 assert.throws(()=>validateInsight({...score,dimensions:score.dimensions.map(d=>({...d,id:'clarity'}))},'score',doc),/invalid/);
 assert.throws(()=>validateInsight({...roles,roles:[{...roles.roles[0],keyword:'https://evil.example'}]},'roles',doc),/invalid/);
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
  const status=await (await fetch(base+'/api/profile/insights',{headers})).json();assert.equal(status.roles.state,'completed');assert.deepEqual(status.roles.sync.added,['B端产品经理']);
  assert.equal(new ResumeInsights(e.controller).status().roles.id,status.roles.id);
  const profile=await (await fetch(base+'/api/profile',{headers})).json();assert.equal(profile.mode,'resume_fulltext');assert.equal(profile.target,undefined);assert.deepEqual(Object.keys(profile.facts),['B0001','B0002']);
 }finally{await new Promise(r=>server.close(r));e.store.close();}
});
test('岗位解析自动去重追加，保留停用词和最新设置，评分不改变关键词',async()=>{
 let release;const e=setup(()=>new Promise(ok=>{release=ok;}));try{
  await e.controller.importResume(upload);const current=e.controller.resumeDocuments.current();
  e.insights.start({kind:'roles',resume_id:current.id});assert.throws(()=>e.insights.start({kind:'score',resume_id:current.id}),/busy/);
  e.controller.saveSettings({...e.controller.settings,keywords:[{text:'B端产品经理',enabled:false},{text:'现有词',enabled:true}]});
  const extra={...roles.roles[0],keyword:'企业服务产品经理'};release({output:{...roles,roles:[...roles.roles,extra]}});await e.insights.promise;
  assert.equal(e.insights.status().roles.state,'completed');assert.deepEqual(e.insights.status().roles.sync.added,['企业服务产品经理']);
  assert.deepEqual(e.controller.settings.keywords,[{text:'B端产品经理',enabled:false},{text:'现有词',enabled:true},{text:'企业服务产品经理',enabled:true}]);
  const before=JSON.stringify(e.controller.settings);e.insights.runner=async()=>({output:score});e.insights.start({kind:'score',resume_id:current.id});await e.insights.promise;
  assert.equal(e.insights.status().score.result.total,75);assert.equal(JSON.stringify(e.controller.settings),before);
 }finally{e.store.close();}
});
test('简历更换、无简历、模型失败、假引文都不得同步关键词',async()=>{
 let release;const e=setup(()=>new Promise(ok=>{release=ok;}));try{
  assert.throws(()=>e.insights.start({kind:'roles',resume_id:'x'}),/resume_required/);
  await e.controller.importResume(upload);const old=e.controller.resumeDocuments.current();e.insights.start({kind:'roles',resume_id:old.id});
  await e.controller.importResume({...upload,base64:Buffer.from('new').toString('base64')});release({output:roles});await e.insights.promise;
  assert.equal(e.controller.settings.keywords.length,0);assert.equal(e.insights.status().roles,null);
  const current=e.controller.resumeDocuments.current();e.insights.runner=async()=>{throw new Error('codex_turn_failed');};e.insights.start({kind:'roles',resume_id:current.id});await e.insights.promise;
  assert.equal(e.insights.status().roles.error,'codex_turn_failed');assert.equal(e.controller.settings.keywords.length,0);
  e.insights.runner=async()=>({output:{...roles,roles:[{...roles.roles[0],evidence:[{block_id:'B0001',quote:'编造的产品经验'}]}]}});e.insights.start({kind:'roles',resume_id:current.id});await e.insights.promise;
  assert.equal(e.insights.status().roles.error,'insight_evidence_invalid');assert.equal(e.controller.settings.keywords.length,0);
 }finally{e.store.close();}
});
