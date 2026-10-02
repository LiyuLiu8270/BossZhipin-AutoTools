import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {diagnosticSignals} from '../local/model-diagnostics.mjs';
import {runCodexJson} from '../local/codex-runner.mjs';

const fake=(events,stderr='')=>()=>{
 const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>queueMicrotask(()=>child.emit('close',null,'SIGTERM'))});
 child.stdin.on('finish',()=>{for(const part of [stderr.slice(0,9),stderr.slice(9)])child.stderr.write(part);for(const e of events)child.stdout.write(JSON.stringify(e)+'\n');queueMicrotask(()=>child.emit('close',0));});return child;
};
test('诊断仅记录白名单信号，HTTP及嵌套错误可识别，不泄露任意消息',()=>{
 const s=diagnosticSignals({error:{message:'unexpected status 429: rate_limit_exceeded Authorization: Bearer SUPERSECRET resume 张先生 JD私人内容',code:'insufficient_quota'}});
 assert.deepEqual(s.http_status,[429]);assert.ok(s.categories.includes('rate_limit'));assert.ok(s.categories.includes('quota_exhausted'));
 assert.doesNotMatch(JSON.stringify(s),/SUPERSECRET|张先生|私人内容|Authorization/);
 assert.ok(diagnosticSignals({error:{message:'HTTP 503 auth_unavailable: no auth available'}}).categories.includes('no_available_auth'));
 assert.equal(diagnosticSignals('private unrelated content').unclassified,true);
});
test('子进程失败日志关联请求，stderr分片与终止事件留证，不改原错误和输出协议',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'model-log-')),cwd=join(dir,'codex-work'),context={requestId:'12345678-1234-1234-1234-123456789abc',stage:'matching'};
 await assert.rejects(runCodexJson('SECRET RESUME',{cwd,schemaPath:'synthetic.json',diagnosticContext:context,spawnProcess:fake([{type:'turn.failed',error:{message:'unexpected status 503: auth_unavailable token=SECRET'}}],('unrelated private stderr\n'.repeat(50))+'HTTP 429 too many requests\n')}),/codex_turn_failed/);
 const raw=readFileSync(join(dir,'model-diagnostics',readdirSync(join(dir,'model-diagnostics'))[0]),'utf8'),logs=raw.trim().split('\n').map(JSON.parse),end=logs.at(-1);
 assert.equal(logs.length,2);assert.equal(end.request_id,context.requestId);assert.equal(end.stage,'matching');assert.equal(end.outcome,'codex_turn_failed');assert.ok(end.elapsed_ms>=0);
 assert.ok(end.events.some(e=>e.source==='turn.failed'&&e.http_status.includes(503)));assert.ok(end.events.some(e=>e.source==='stderr'&&e.http_status.includes(429)));assert.doesNotMatch(raw,/SECRET|unrelated private|synthetic.json/);
});
test('日志写入失败不改变成功输出或释放时机，未知原因不虚构分类',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'model-log-block-')),cwd=join(dir,'codex-work');mkdirSync(cwd);writeFileSync(join(dir,'model-diagnostics'),'blocked');
 const r=await runCodexJson('private',{cwd,schemaPath:'synthetic.json',spawnProcess:fake([{type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}},{type:'turn.completed'}])});assert.deepEqual(r.output,{ok:true});
});
