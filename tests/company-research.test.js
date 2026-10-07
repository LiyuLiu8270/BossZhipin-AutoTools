import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CompanyResearch,companySubject,researchMarkdown} from '../local/company-research.mjs';
import {researchCompanyNative} from '../local/company-research-native.mjs';
import {publicURL,publicIPv4,plainText,fetchPublicText} from '../local/public-source.mjs';
import {runCodexJson,runCodexResearch} from '../local/codex-runner.mjs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {ModelTaskQueue} from '../local/model-task-queue.mjs';

const company='合成科技有限公司',quote='合成科技有限公司提供企业软件产品及技术服务。';
const report=()=>({subject:{company,city:''},status:'completed',identity_status:'confirmed',generated_at:new Date().toISOString(),sections:[],sources:[],questions:[],warnings:[]});
function setup(model=async()=>report()){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE match_budget(day TEXT PRIMARY KEY,jobs INTEGER)');let at=Date.now(),enabled;
 const rows=[{dataset:'test',id:'1',job:{company,location:'深圳'},result:{priority:'优先沟通'},job_state:'unknown',stage:'new'}];
 const controller={db,settings:{modelConcurrency:1},scheduler:{active:0,wake(){}},communications:{modelActive:0},read:()=>enabled,write:(_,v)=>{enabled=v;},rows:(dataset,id)=>id?rows.filter(r=>r.dataset===dataset&&r.id===id):rows,worker:{day:()=> '2026-10-03',dailyLimit:5,budgetAvailable:()=> (db.prepare('SELECT jobs FROM match_budget').get()?.jobs||0)<controller.worker.dailyLimit,runtimeStatus:()=>({available:true})}};
 const r=new CompanyResearch(controller,{dataDir:tmpdir(),model,now:()=>at,identityResolver:job=>({state:'platform_verified',full_name:job.company})});controller.companyResearch=r;
 return {r,db,controller,rows,advance:ms=>{at+=ms;},close:async()=>{await r.close();db.close();}};
}
test('公司键保留法定后缀；简称按城市隔离，猎头代招不猜雇主',()=>{
 assert.equal(companySubject({company,location:'深圳'}).key,companySubject({company,location:'上海'}).key);
 assert.notEqual(companySubject({company:'合成',location:'深圳'}).key,companySubject({company:'合成',location:'上海'}).key);
 for(const type of ['headhunter','agency','conflicting'])assert.equal(companySubject({company,hiring_party:{type}}),null);
 assert.equal(companySubject({company:'保密'}),null);
});
test('只排值得沟通且未忽略/关闭岗位，同公司跨岗位只背调一次',async()=>{let n=0;const s=setup(async()=>{n++;return report();});try{
 s.rows.push({...s.rows[0],id:'2',result:{priority:'可以尝试'}},{...s.rows[0],id:'3',job:{company:'无关公司'},result:{priority:'不匹配'}},{...s.rows[0],id:'4',job:{company:'关闭公司'},job_state:'closed'});
 await s.r.tick();await s.r.tick();assert.equal(n,1);assert.equal(s.r.status().counts.completed,1);assert.equal(s.db.prepare('SELECT jobs FROM match_budget').get().jobs,1);
 assert.equal(s.r.detail('test','2').report.subject.company,company);
}finally{await s.close();}});
test('关闭背调或额度耗尽不调用模型，不改变自动匹配配置',async()=>{let n=0;const s=setup(async()=>{n++;return report();});try{
 s.r.config({enabled:false});await s.r.tick();assert.equal(n,0);s.r.config({enabled:true});s.controller.worker.dailyLimit=0;await s.r.tick();assert.equal(n,0);assert.equal(s.r.status().counts.pending,1);assert.equal(s.controller.settings.autoAnalyze,undefined);
}finally{await s.close();}});
test('共享并发槽，单路配置不超额，不重复领取同一公司',async()=>{let release;const s=setup(()=>new Promise(r=>{release=r;}));try{
 s.controller.scheduler.active=1;await s.r.tick();assert.equal(s.r.busy,false);s.controller.scheduler.active=0;const p=s.r.tick();assert.equal(s.r.modelActive,1);await s.r.tick();assert.equal(s.db.prepare('SELECT jobs FROM match_budget').get().jobs,1);release(report());await p;assert.equal(s.r.modelActive,0);
}finally{await s.close();}});

const turn=()=>new Promise(resolve=>setImmediate(resolve));
test('工商全称进入模型，无法确认不调用模型且退回额度；浏览器忙不耗尽尝试',async()=>{
 let subject,calls=0;const s=setup(async value=>{subject=value;calls++;return {...report(),subject:value};});try{
  s.r.resolveIdentity=()=>({state:'platform_verified',full_name:'真正用人单位有限公司',credit_code:'91440300597793399Q'});
  await s.r.tick();assert.equal(subject.company,'真正用人单位有限公司');assert.equal(subject.display_name,company);assert.equal(calls,1);
  s.advance(31*86400000);s.r.resolveIdentity=()=>({state:'conflict'});await s.r.tick();assert.equal(calls,1);assert.equal(s.r.detail('test','1').state,'needs_review');assert.equal(s.r.detail('test','1').report.evidenceCount,0);assert.equal(s.db.prepare('SELECT jobs FROM match_budget').get().jobs,1);
  s.advance(31*86400000);s.r.resolveIdentity=()=>{throw Error('identity_browser_busy');};await s.r.tick();assert.equal(s.r.detail('test','1').state,'retry');assert.equal(s.r.detail('test','1').attempts,0);assert.equal(s.db.prepare('SELECT jobs FROM match_budget').get().jobs,1);
 }finally{await s.close();}
});
async function until(check){for(let n=0;n<40;n++){if(check())return;await turn();}assert.ok(check(),'scheduler did not reach expected state');}
test('生产统一调度：背调遵守共享优先级、预留位、独立并发与预算',async()=>{
 const s=setup(),order=[];let watching=true,releaseResearch;
 const q=new ModelTaskQueue({capacity:()=>s.controller.settings.modelConcurrency,reserveCommunication:()=>watching});s.controller.modelQueue=q;s.controller.settings.modelConcurrency=3;
 s.rows.push({...s.rows[0],id:'2',job:{company:'第二合成公司有限公司'}},{...s.rows[0],id:'3',job:{company:'第三合成公司有限公司'}});
 s.r.model=()=>new Promise(r=>{order.push('research');releaseResearch=r;});
 s.r.config({enabled:true,concurrency:1});s.r.start();
 const manual=q.submit({id:'manual',kind:'manual_greeting',run:()=>{order.push('manual');}});
 await manual;await until(()=>s.r.modelActive===1);assert.equal(order[0],'manual');assert.equal(s.r.sharedUsed,1);
 const hr=q.submit({id:'hr',kind:'hr_reply',run:()=>{order.push('hr');}});await hr;assert.ok(order.includes('hr'));assert.equal(s.db.prepare('SELECT jobs FROM match_budget').get().jobs,1);
 s.r.config({enabled:false});releaseResearch(report());await until(()=>s.r.modelActive===0);assert.equal(order.filter(x=>x==='research').length,1);
 watching=false;await s.r.close();await q.close();s.db.close();
});
function parallelSetup(total=8){
 const calls=[],resolvers=[];const s=setup((subject,options)=>new Promise((resolve,reject)=>{calls.push({subject,options});resolvers.push({resolve,reject});}));
 for(let i=1;i<total;i++)s.rows.push({...s.rows[0],id:String(i+1),job:{company:'合成并发'+i+'有限公司',location:'深圳'}});
 s.controller.settings.modelConcurrency=4;s.controller.worker.dailyLimit=30;
 return {...s,calls,resolvers,finish:async()=>{s.r.stop();for(const p of resolvers)p.resolve(report());await s.close();}};
}
test('3路持续背调：快任务完成立即补位，不等慢任务；独立目录和同公司去重',async()=>{
 const s=parallelSetup();try{
  s.rows.push({...s.rows[0],id:'duplicate'});s.r.config({enabled:true,concurrency:3});s.r.start();await until(()=>s.calls.length===3);
  assert.equal(s.r.modelActive,3);assert.equal(s.r.status().effectiveConcurrency,3);assert.equal(s.r.status().activeTasks.length,3);
  s.resolvers[1].resolve(report());await until(()=>s.calls.length===4);assert.equal(s.r.modelActive,3);assert.equal(s.r.status().counts.completed,1);
  assert.equal(new Set(s.calls.map(c=>c.subject.company)).size,4);assert.equal(new Set(s.calls.map(c=>c.options.cwd)).size,4);
  s.calls[0].options.onTrace({tool:'search'});assert.equal(s.r.status().activeTasks.filter(t=>t.lastTool==='search').length,1);
  await s.r.tick();assert.equal(s.calls.length,4);assert.equal(s.db.prepare('SELECT jobs FROM match_budget').get().jobs,4);
 }finally{await s.finish();}
});
test('调高立即补位，调低不取消在途；暂停后不补位，继续后恢复',async()=>{
 const s=parallelSetup();try{
  s.r.config({enabled:true,concurrency:2});s.r.start();await until(()=>s.calls.length===2);
  s.r.config({enabled:true,concurrency:4});await until(()=>s.calls.length===4);
  s.r.config({enabled:true,concurrency:1});s.resolvers[0].resolve(report());await until(()=>s.r.modelActive===3);assert.equal(s.calls.length,4);
  s.r.config({enabled:false});assert.equal(s.r.concurrency,1);for(let i=1;i<4;i++)s.resolvers[i].resolve(report());await until(()=>s.r.modelActive===0);await turn();assert.equal(s.calls.length,4);
  s.r.config({enabled:true});await until(()=>s.calls.length===5);assert.equal(s.r.modelActive,1);
 }finally{await s.finish();}
});
test('背调上限叠加共享名额，不超过匹配和聊天之外的可用容量',async()=>{
 const s=parallelSetup();try{
  s.controller.scheduler.active=2;s.controller.communications.modelActive=1;s.r.start();await until(()=>s.calls.length===1);
  assert.equal(s.r.sharedUsed,4);assert.equal(s.r.concurrency,0);assert.equal(s.r.effectiveConcurrency,4);
  s.controller.scheduler.active=0;s.r.wake();await until(()=>s.calls.length===3);assert.equal(s.r.sharedUsed,4);
  s.controller.settings.modelConcurrency=2;s.r.wake();await turn();assert.equal(s.calls.length,3);
  s.resolvers[0].resolve(report());s.resolvers[1].resolve(report());await until(()=>s.r.modelActive===1);await turn();assert.equal(s.calls.length,3);
 }finally{await s.finish();}
});
test('共享剩余额度小于并发时只领取剩余额度，失败不泄漏令牌；关闭等待全部在途',async()=>{
 const s=parallelSetup();try{
  s.controller.worker.dailyLimit=2;s.r.start();await until(()=>s.calls.length===2);assert.equal(s.r.modelActive,2);
  s.resolvers[0].reject(Error('codex_timeout'));await until(()=>s.r.modelActive===1);assert.equal(s.calls.length,2);assert.equal(s.r.status().counts.retry,1);
  let closed=false;const closing=s.r.close().then(()=>{closed=true;});await turn();assert.equal(closed,false);s.resolvers[1].resolve(report());await closing;assert.equal(s.r.modelActive,0);assert.equal(s.calls.length,2);
  assert.equal(s.db.prepare('SELECT jobs FROM match_budget').get().jobs,2);assert.equal(s.r.status().counts.pending,6);
 }finally{await s.finish();}
});
test('并发设置向后兼容，默认跟随全局，不接受无效值或改变autoAnalyze',async()=>{
 const s=setup();try{
  assert.equal(s.r.concurrency,0);s.controller.settings.modelConcurrency=8;assert.equal(s.r.effectiveConcurrency,8);
  s.r.config({enabled:true,concurrency:3});s.r.config({enabled:false});assert.equal(s.r.concurrency,3);
  for(const concurrency of [-1,17,1.5,'4',true])assert.throws(()=>s.r.config({enabled:true,concurrency}),/invalid_research_settings/);
  assert.equal(s.r.enabled,false);assert.equal(s.controller.settings.autoAnalyze,undefined);
 }finally{await s.close();}
});
test('30天缓存更新，失败保留旧报告；瞬时失败最多3次并退避',async()=>{let fail=false;const s=setup(async()=>{if(fail)throw Error('codex_timeout');return report();});try{
 await s.r.tick();s.advance(31*86400000);fail=true;await s.r.tick();assert.equal(s.r.detail('test','1').state,'retry');assert.ok(s.r.detail('test','1').report);await s.r.tick();assert.equal(s.r.detail('test','1').attempts,1);
 s.advance(3600001);await s.r.tick();s.advance(3600001);await s.r.tick();assert.equal(s.r.detail('test','1').state,'failed');s.advance(3600001);await s.r.tick();assert.equal(s.r.detail('test','1').attempts,3);
}finally{await s.close();}});
test('重启恢复running但不删除报告；手动刷新受冷却限制',async()=>{const s=setup();try{
 await s.r.tick();assert.throws(()=>s.r.retry({dataset:'test',id:'1'}),/research_busy/);s.advance(60001);s.r.retry({dataset:'test',id:'1'});assert.equal(s.r.detail('test','1').state,'pending');
 s.db.exec("UPDATE company_research SET state='running'");const second=new CompanyResearch(s.controller,{dataDir:tmpdir()});assert.equal(second.detail('test','1').state,'pending');assert.ok(second.detail('test','1').report);await second.close();
}finally{await s.close();}});
test('岗位降档后不执行旧背调队列；公司改名不串旧报告',async()=>{const s=setup();try{
 s.r.discover();s.rows[0].result.priority='低优先级';await s.r.tick();assert.equal(s.r.status().counts.pending,1);s.rows[0].job.company='另一家公司';assert.equal(s.r.detail('test','1').report,null);assert.throws(()=>s.r.retry({dataset:'test',id:'1'}),/research_not_eligible/);
}finally{await s.close();}});
test('公开来源拒绝内网、凭据、危险协议、重绑定DNS，不发请求',async()=>{
 for(const url of ['http://127.0.0.1/a','http://10.0.0.1','file:///tmp/x','https://u:p@example.com','http://169.254.169.254','http://example.com:19222','http://localhost'])assert.equal(publicURL(url),null);
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.2','100.64.0.1','::1'])assert.equal(publicIPv4(ip),false);assert.equal(publicIPv4('8.8.8.8'),true);
 await assert.rejects(fetchPublicText('https://example.com',{resolve:async()=>[{address:'127.0.0.1'}],request:()=>{throw Error('must_not_connect');}}),/source_address_blocked/);
 assert.equal(plainText('<script>alert(1)</script><p>A &amp; &#20013; &#x6587;</p>'),'A & 中 文');
});
function fakeSpawn(events,check){return (_exe,args)=>{check?.(args);const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.kill=()=>setImmediate(()=>c.emit('close',1,null));setImmediate(()=>{for(const e of events)c.stdout.write(JSON.stringify(e)+'\n');c.emit('close',0,null);});return c;};}
test('匹配和招呼底层模型仍禁止工具；不能通过附加选项越权',async()=>{
 const events=[{type:'item.completed',item:{type:'web_search'}},{type:'item.completed',item:{type:'agent_message',text:'{}'}},{type:'turn.completed'}],cwd=mkdtempSync(join(tmpdir(),'research-runner-'));
 await assert.rejects(runCodexJson('synthetic',{cwd,schemaPath:'schema.json',spawnProcess:fakeSpawn(events)}),/unexpected_tool_use/);
 await assert.rejects(runCodexJson('synthetic',{cwd,schemaPath:'schema.json',allowWebSearch:true,spawnProcess:fakeSpawn([{type:'item.started',item:{type:'mcp_tool_call',server:'browser',tool:'write'}}])}),/unexpected_tool_use/);
});

test('升级仅重排有明确主体的旧空报告一次，原报告保留；部分报告7天刷新',async()=>{
 const s=setup(async subject=>({...report(),subject,status:'partial',evidenceCount:2,quality_version:2}));try{
  s.r.discover();const key=companySubject(s.rows[0].job).key;
  const legacy={...report(),status:'needs_review',evidenceCount:0,subject:{company,platform_identity:{state:'platform_verified'}}};
  s.db.prepare("UPDATE company_research SET state='needs_review',report=? WHERE key=?").run(JSON.stringify(legacy),key);
  s.advance(10001);s.r.discover();assert.equal(s.r.get(key).state,'pending');assert.deepEqual(s.r.get(key).report,legacy);
  await s.r.tick();assert.equal(s.r.get(key).state,'partial');s.advance(86400000);await s.r.tick();assert.equal(s.r.get(key).attempts,1);
  s.advance(7*86400000);s.r.discover();assert.equal(s.r.get(key).state,'pending');
 }finally{await s.close();}
});

test('原生背调只发送公司全称和任务，不指定搜索词、轮数或传递私有资料',async()=>{
 let input;const subject={company,city:'秘密城市',resume:'私有经历',display_name:'不传递显示简称'};
 const result=await researchCompanyNative(subject,{runner:async prompt=>{input=prompt;return {output:'# 背调报告\n\n业务情况待核实。\n\nhttps://example.com/about',webEvents:[{tool:'web_search',event:'item.completed',status:'completed'}]};}});
 assert.match(input,new RegExp(company));assert.doesNotMatch(input,/秘密城市|私有经历|不传递显示简称|search_queries|maxRounds/);
 assert.equal(result.report_format,'codex_markdown');assert.equal(result.sources.length,1);assert.match(researchMarkdown({report:result}),/业务情况待核实/);
 assert.equal(result.evidenceCount,null);assert.equal(result.status,'completed');
});
test('未观察到联网不可成功；浏览器或原生均可，资料不足不按来源数打分',async()=>{
 await assert.rejects(researchCompanyNative({company},{runner:async()=>({output:'凭记忆写的报告',webEvents:[]})}),/research_web_unavailable/);
 await assert.rejects(researchCompanyNative({company},{runner:async()=>({output:'搜索失败',webEvents:[{event:'item.completed',status:'failed'}]})}),/research_web_unavailable/);
 const r=await researchCompanyNative({company},{runner:async()=>({output:'检索完成但未取得可核实资料，不能断言没有风险。',webEvents:[{event:'item.completed',status:'completed'}]})});
 assert.equal(r.sources.length,0);assert.equal(r.status,'completed');assert.equal(r.warnings.length,2);
});
test('背调不再强制原生search，只注册独立公开浏览器；匹配仍不开放工具',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'native-runner-'));
 const events=[{type:'item.started',item:{id:'w',type:'web_search',query:company}},{type:'item.completed',item:{id:'w',type:'web_search',status:'completed'}},{type:'item.completed',item:{type:'agent_message',text:'# 背调报告'}},{type:'turn.completed'}];
 const r=await runCodexResearch('public company task',{cwd,spawnProcess:fakeSpawn(events,args=>{assert.ok(!args.includes('--search'));assert.ok(args.some(a=>a.startsWith('mcp_servers.xunxu_public_browser=')&&a.includes('research-browser-mcp.mjs')));assert.ok(args.includes('features.plugins=false'));assert.ok(args.includes('features.shell_tool=false'));assert.ok(!args.includes('--output-schema'));})});
 assert.equal(r.output,'# 背调报告');assert.equal(r.webEvents.length,2);
 await assert.rejects(runCodexResearch('public company task',{cwd,spawnProcess:fakeSpawn([{type:'item.started',item:{type:'mcp_tool_call',server:'browser',tool:'read'}}])}),/unexpected_tool_use/);
});

test('只有已批准浏览器返回真实页面文本才记录成功，未知工具仍拒绝',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'browser-runner-'));
 const run=item=>runCodexResearch('public company',{cwd,spawnProcess:fakeSpawn([{type:'item.completed',item},{type:'item.completed',item:{type:'agent_message',text:'公开报告'}},{type:'turn.completed'}])});
 const item={id:'b',type:'mcp_tool_call',server:'xunxu_public_browser',tool:'browser_open',status:'completed',result:{isError:false,content:[{type:'text',text:JSON.stringify({ok:true,page:{url:'https://example.com',text:'公开文字'}})}]}};
 const r=await run(item);assert.equal(r.webEvents[0].status,'completed');
 assert.equal((await run({...item,result:{isError:true,content:[]}})).webEvents[0].status,'failed');
 assert.equal((await run({...item,result:{content:[]}})).webEvents[0].status,'failed');
 await assert.rejects(run({...item,tool:'browser_evaluate'}),/unexpected_tool_use/);
 await assert.rejects(run({...item,server:'user_browser'}),/unexpected_tool_use/);
 const report=await researchCompanyNative({company},{runner:async()=>r});assert.equal(report.research_method,'codex_public_browser');
});
test('首次仅一路验证，联网失败持久暂停整个背调队列，明确重试后恢复并发',async()=>{
 let calls=0;const s=setup(async()=>{calls++;throw Error('research_native_search_unavailable');});try{
  s.r.probeNative=true;s.r.nativeReady=false;s.controller.settings.modelConcurrency=4;
  for(let i=0;i<3;i++)s.rows.push({...s.rows[0],id:'extra'+i,job:{company:'其他'+i+'有限公司'}});
  await s.r.tick();assert.equal(calls,1);assert.equal(s.r.nativeBlock.error,'research_native_search_unavailable');assert.equal(s.r.status().counts.pending,3);
  await s.r.tick();assert.equal(calls,1);assert.equal(s.r.enabled,true);
  const second=new CompanyResearch(s.controller,{dataDir:tmpdir()});assert.equal(second.nativeBlock.error,'research_native_search_unavailable');await second.close();
  s.advance(60001);s.r.retry({dataset:'test',id:'1'});assert.equal(s.r.nativeBlock,null);
  s.r.model=async()=>{calls++;return report();};await s.r.tick();assert.equal(calls,2);assert.equal(s.r.nativeReady,true);
  await s.r.tick();assert.equal(calls,5);
 }finally{await s.close();}
});

test('浏览器升级仅归档旧原生搜索阻断，用户开关及其他故障不变',async()=>{const s=setup();try{
 s.r.config({enabled:false,concurrency:3});
 const old={error:'research_native_search_unavailable',at:1};s.db.prepare("INSERT OR REPLACE INTO company_research_runtime VALUES('native_block',?)").run(JSON.stringify(old));
 const upgraded=new CompanyResearch(s.controller,{dataDir:tmpdir()});assert.equal(upgraded.nativeBlock,null);assert.equal(upgraded.enabled,false);assert.equal(upgraded.concurrency,3);assert.equal(upgraded.nativeReady,false);
 assert.deepEqual(JSON.parse(s.db.prepare("SELECT body FROM company_research_runtime WHERE key='native_block_before_browser'").get().body),old);await upgraded.close();
 s.db.prepare("INSERT OR REPLACE INTO company_research_runtime VALUES('native_block',?)").run(JSON.stringify({error:'research_tool_isolation_failed',at:2}));
 const preserved=new CompanyResearch(s.controller,{dataDir:tmpdir()});assert.equal(preserved.nativeBlock.error,'research_tool_isolation_failed');await preserved.close();
 }finally{await s.close();}});
