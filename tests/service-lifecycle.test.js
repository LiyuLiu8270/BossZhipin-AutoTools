import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installLifecycle} from '../local/service-lifecycle.mjs';
import {launchDesktop} from '../local/desktop-launch.mjs';
import {spawnSync} from 'node:child_process';
test('生命周期记录独立落盘，记录退出码而不泄漏异常消息或接管异常',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lifecycle-')),p=Object.assign(new EventEmitter(),{pid:1,ppid:2,version:'v24',execPath:'test-node'});
 const log=installLifecycle(dir,{runtime:p,version:'test'});log('service_ready');log('stop_requested',{reason:'SIGTERM'});
 const error=Error('PRIVATE PROMPT');p.emit('uncaughtExceptionMonitor',error,'unhandledRejection');p.emit('exit',1);
 const text=readFileSync(join(dir,'service-lifecycle.jsonl'),'utf8');assert.doesNotMatch(text,/PRIVATE PROMPT/);assert.equal(p.listenerCount('uncaughtException'),0);
 const rows=text.trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(r=>r.event),['process_start','service_ready','stop_requested','fatal_error','process_exit']);assert.equal(rows.at(-1).code,1);
});
test('开发入口通过Windows外壳启动，未直接创建托盘子进程或修改安全策略',()=>{
 let args,unref=false;const exe=join(tmpdir(),'中文 app.exe');
 launchDesktop(exe,{windows:join(tmpdir(),'Windows'),spawnProcess:(...a)=>{args=a;return {unref(){unref=true;}};}});
 assert.match(args[0],/explorer\.exe$/);assert.deepEqual(args[1],[exe]);assert.equal(args[2].windowsHide,true);assert.equal(args[2].stdio,'ignore');assert.ok(unref);
 assert.throws(()=>launchDesktop('relative.exe'),/absolute/);
});
test('真实子进程异常仍非零退出，独立日志在无托盘/输出管道时落盘',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lifecycle-process-'));
 const code=`import {installLifecycle} from ${JSON.stringify(new URL('../local/service-lifecycle.mjs',import.meta.url).href)};installLifecycle(${JSON.stringify(dir)});setImmediate(()=>{throw Error('PRIVATE_PROMPT_BODY');});`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{windowsHide:true,stdio:'ignore',timeout:5000});
 assert.equal(child.status,1);const text=readFileSync(join(dir,'service-lifecycle.jsonl'),'utf8');assert.doesNotMatch(text,/PRIVATE_PROMPT_BODY/);const rows=text.trim().split('\n').map(JSON.parse);assert.ok(rows.some(r=>r.event==='fatal_error'));assert.equal(rows.at(-1).code,1);
});
