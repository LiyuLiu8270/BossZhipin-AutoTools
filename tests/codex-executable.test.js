import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,utimesSync,unlinkSync,readFileSync,readdirSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {resolveCodexExecutable,codexRuntimeStatus} from '../local/codex-executable.mjs';
import {runCodex,runCodexJson} from '../local/codex-runner.mjs';
import {runGreeting} from '../local/greeting-runner.mjs';
import {IntakeStore} from '../local/intake.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {MatchScheduler} from '../local/match-scheduler.mjs';

function installation(){
  const local=mkdtempSync(join(tmpdir(),'codex native ')),env={LOCALAPPDATA:local,Path:''};
  const version=(name,time,complete=true)=>{const directory=join(local,'OpenAI','Codex','bin',name);mkdirSync(directory,{recursive:true});const path=join(directory,'codex.exe');if(complete){writeFileSync(path,'synthetic');utimesSync(path,time,time);}return path;};
  return {local,env,version,resolve:(extra={})=>resolveCodexExecutable({env,platform:'win32',...extra})};
}
test('桌面无PATH/旧路径失效时发现CLI；更新后重新发现，忽略不完整版本',()=>{
  const e=installation(),old=e.version('old',10);assert.deepEqual(e.resolve(),{path:old,source:'desktop_install'});
  e.env.Path=join(e.local,'removed');e.version('incomplete',100,false);assert.equal(e.resolve().path,old);
  const newer=e.version('new',20);assert.equal(e.resolve().path,newer);unlinkSync(newer);assert.equal(e.resolve().path,old);
  unlinkSync(old);assert.deepEqual(codexRuntimeStatus({env:e.env,platform:'win32'}),{available:false,error:'codex_binary_unavailable'});
});
test('绝对PATH/显式覆盖优先；拒绝相对PATH和脚本，不悄悄覆盖无效配置',()=>{
  const e=installation(),installed=e.version('desktop',1),bin=join(e.local,'cli path');mkdirSync(bin);const cli=join(bin,'codex.exe');writeFileSync(cli,'synthetic');
  e.env.Path=`.;relative;"${bin}"`;assert.deepEqual(e.resolve(),{path:cli,source:'path'});assert.deepEqual(e.resolve({binary:installed}),{path:installed,source:'override'});
  e.env.CODEX_BINARY=installed;assert.equal(e.resolve().source,'override');assert.throws(()=>e.resolve({binary:join(e.local,'missing.exe')}),/codex_binary_unavailable/);
  const script=join(bin,'codex.cmd');writeFileSync(script,'synthetic');assert.throws(()=>e.resolve({binary:script}),/codex_binary_unavailable/);
  delete e.env.CODEX_BINARY;e.env.Path='.;relative';assert.equal(e.resolve().path,installed);
});
test('非Windows原生PATH按执行权限查找，无shell回退',{skip:process.platform==='win32'},()=>{
  const dir=mkdtempSync(join(tmpdir(),'codex-unix-')),cli=join(dir,'codex');writeFileSync(cli,'synthetic');chmodSync(cli,0o600);
  assert.throws(()=>resolveCodexExecutable({env:{PATH:dir},platform:'linux'}),/codex_binary_unavailable/);chmodSync(cli,0o700);assert.equal(resolveCodexExecutable({env:{PATH:dir},platform:'linux'}).path,cli);
});
function fake(calls){return (binary,args,options)=>{
  calls.push({binary,args,options});const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>queueMicrotask(()=>child.emit('close',null,'SIGTERM'))});
  child.stdin.on('finish',()=>{child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}})+'\n');child.stdout.write('{"type":"turn.completed"}\n');queueMicrotask(()=>child.emit('close',0));});return child;
};}
test('匹配/招呼/公共JSON调用统一定位，原沙箱参数不变，日志不含私有路径',async()=>{
  const e=installation(),cli=e.version('current',10),cwd=join(e.local,'data','codex-work'),calls=[],options={cwd,spawnProcess:fake(calls),resolveBinary:e.resolve};
  await runCodex({facts:{}},[],options);await runGreeting({facts:{}},{},{},options);await runCodexJson('synthetic',{...options,schemaPath:'synthetic.json'});assert.equal(calls.length,3);
  for(const c of calls){assert.equal(c.binary,cli);assert.ok(c.args.includes('read-only'));assert.ok(c.args.includes('features.shell_tool=false'));assert.ok(c.args.includes('--ephemeral'));assert.equal(c.options.windowsHide,true);assert.equal(c.options.shell,undefined);assert.deepEqual(c.options.stdio,['pipe','pipe','pipe']);}
  const dir=join(e.local,'data','model-diagnostics'),raw=readFileSync(join(dir,readdirSync(dir)[0]),'utf8');assert.doesNotMatch(raw,/codex native|synthetic.json|OpenAI/);assert.match(raw,/desktop_install/);
  await assert.rejects(runCodexJson('synthetic',{...options,resolveBinary:()=>{throw new Error('secret missing path');},schemaPath:'synthetic.json'}),/codex_binary_unavailable/);assert.equal(calls.length,3);
});
test('缺少CLI时领取前暂停，不增加额度/尝试；恢复后可继续，调度不忙循环',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'runtime-preflight-')),store=new IntakeStore(join(dataDir,'jobs.sqlite'));let available=false;
  const worker=new MatchWorker(store,{facts:{F1:'参与企业服务产品设计'},target:'产品经理'},{dataDir,runtimeStatus:()=>({available})});
  try{
    store.importPayload({schema_version:2,label:'synthetic',exported_at:new Date().toISOString(),jobs:[{id:'boss:runtime',url:'https://www.zhipin.com/job_detail/runtime.html',title:'产品经理',jd:'负责企业服务产品设计及项目交付。'.repeat(30),jd_status:'captured_unverified'}]});
    for(const fn of [()=>worker.nextStep(),()=>worker.step(),()=>worker.greetingStep()])assert.equal((await fn()).reason,'codex_binary_unavailable');
    assert.equal(worker.status().daily_used,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM match_runs').get().n,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM greeting_runs').get().n,0);
    let starts=0;const scheduler=new MatchScheduler({nextStep:async()=>{starts++;return worker.nextStep();}},{canRun:()=>true,capacity:()=>1,pollMs:100000});scheduler.start();await new Promise(r=>setTimeout(r,30));assert.equal(starts,1);await scheduler.close();
    available=true;worker.runner=async(p,j)=>({output:{results:j.map(job=>({id:job.id,priority:'可以尝试',reason:'企业服务经验可迁移',evidence:[{fact_id:'F1',jd_quote:'企业服务产品设计',relation:'直接经验'}],gaps:[],questions:[],keywords:[],greeting:'',greeting_fact_ids:[]}))}});
    assert.equal((await worker.step()).status,'completed');assert.equal(worker.status().daily_used,1);
    available=false;assert.equal((await worker.greetingStep()).reason,'codex_binary_unavailable');assert.equal(worker.status().daily_used,1);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM greeting_runs').get().n,0);
  }finally{store.close();}
});
