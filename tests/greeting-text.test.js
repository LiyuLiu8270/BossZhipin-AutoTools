import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runGreeting} from '../local/greeting-runner.mjs';

function processStub(text,{fail=false}={}){
 return (binary,args)=>{
  assert.ok(!args.includes('--output-schema'));
  assert.ok(args.includes('features.shell_tool=false'));
  const child=new EventEmitter();
  Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>queueMicrotask(()=>child.emit('close',1))});
  child.stdin.on('finish',()=>{
   child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\n');
   child.stdout.write(JSON.stringify({type:fail?'turn.failed':'turn.completed'})+'\n');
   queueMicrotask(()=>child.emit('close',fail?1:0));
  });return child;
 };
}
test('招呼纯文本逐字保留：短文、长文、换行、冲突说明、JSON外观均不拦截',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'greeting-text-'));
 for(const text of ['您好','长'.repeat(2100),'  HI\n正文。  ','固定开头存在冲突，以下是说明。','{"greeting":"这是原文"}']){
  const r=await runGreeting({facts:{}},{},{},{cwd,spawnProcess:processStub(text)});
  assert.deepEqual(r.output,{greeting:text,greeting_fact_ids:[],claims:[]});
 }
});
test('未获得完成响应和模型执行错误仍作为技术失败',async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'greeting-transport-'));
 await assert.rejects(runGreeting({facts:{}},{},{},{cwd,spawnProcess:processStub('')}),/codex_no_valid_completion/);
 await assert.rejects(runGreeting({facts:{}},{},{},{cwd,spawnProcess:processStub('部分文本',{fail:true})}),/codex_turn_failed/);
});
