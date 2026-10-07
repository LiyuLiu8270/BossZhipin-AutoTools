import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSchemaSnapshot,materializeSchema} from '../local/model-schema.mjs';
test('运行中schema与代码固定，磁盘更新不污染旧任务，新进程可用新快照',()=>{
 const dir=mkdtempSync(join(tmpdir(),'schema-snapshot-')),source=join(dir,'schema.json');
 writeFileSync(source,JSON.stringify({type:'object',required:['old']}));const old=loadSchemaSnapshot(source);
 writeFileSync(source,JSON.stringify({type:'object',required:['new']}));const current=loadSchemaSnapshot(source);
 const oldPath=materializeSchema(old,dir),newPath=materializeSchema(current,dir);
 assert.notEqual(oldPath,newPath);assert.deepEqual(JSON.parse(readFileSync(oldPath)).required,['old']);assert.deepEqual(JSON.parse(readFileSync(newPath)).required,['new']);assert.equal(materializeSchema(old,dir),oldPath);
 writeFileSync(oldPath,'tampered');assert.throws(()=>materializeSchema(old,dir),/schema_snapshot_conflict/);
});
