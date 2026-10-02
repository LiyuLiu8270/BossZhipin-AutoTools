import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ResumeDocuments,parseResume} from '../local/resume-documents.mjs';
import {IntakeStore} from '../local/intake.mjs';
import {WebController} from '../local/web-controller.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {pythonPath} from '../local/runtime-paths.mjs';

const input={filename:'简历.docx',base64:Buffer.from('fixture').toString('base64')};
const parsed={text:'参与项目，负责需求梳理和交付。',blocks:[{id:'B0001',type:'paragraph',source:'body',text:'参与项目，负责需求梳理和交付。'}],warnings:[],stats:{characters:17,paragraphs:1,tables:0,images:0}};
test('Word原文件、全文、来源持久保存且重复导入不新增版本；失败保留旧资料',async()=>{
 const db=new DatabaseSync(':memory:');let calls=0;const documents=new ResumeDocuments(db,{parser:async()=>{calls++;return parsed;}});
 try{
  assert.equal(documents.current(),null);assert.equal(documents.original(),null);
  const first=await documents.import(input);assert.equal(first.status,'saved');assert.equal(first.document.text,parsed.text);assert.equal(first.document.matching_connected,false);
  assert.deepEqual(Buffer.from(documents.original().original),Buffer.from('fixture'));
  assert.equal((await documents.import(input)).status,'already_saved');assert.equal(calls,1);
  assert.equal(new ResumeDocuments(db).current().id,first.document.id);
  documents.parser=async()=>{throw new Error('resume_invalid_docx');};
  await assert.rejects(documents.import({...input,base64:Buffer.from('broken').toString('base64')}),/invalid_docx/);
  assert.equal(documents.current().id,first.document.id);
  documents.parser=async()=>({...parsed,text:'新版完整原文'});
  await documents.import({...input,base64:Buffer.from('second').toString('base64')});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resume_documents').get().n,2);
 }finally{db.close();}
});
test('不执行路径/非docx/超限/重复并发导入，不改变worker资料、hash和设置',async()=>{
 const store=new IntakeStore(':memory:'),worker=new MatchWorker(store,{facts:{C01:'旧摘要'}},{runner:async()=>{throw new Error('unexpected_match_call');}});
 const controller=new WebController(store,worker);let release;
 controller.resumeDocuments.parser=()=>new Promise(ok=>{release=()=>ok(parsed);});
 try{
  for(const value of [{...input,filename:'../resume.docx'},{...input,filename:'old.doc'},{...input,base64:''},{...input,base64:'*'}])await assert.rejects(controller.resumeDocuments.import(value),/resume_/);
  const before=JSON.stringify([worker.profile,worker.profileHash,controller.settings]);
  const pending=controller.resumeDocuments.import(input);await assert.rejects(controller.resumeDocuments.import(input),/busy/);release();await pending;
  assert.equal(JSON.stringify([worker.profile,worker.profileHash,controller.settings]),before);
 }finally{store.close();}
});
test('真实Python边界解析合成DOCX全文，错误文件不保存',async()=>{
 const py=pythonPath();
 const code=`import io,zipfile,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:\n z.writestr('[Content_Types].xml','<Types/>')\n z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>完整经历，保留细节和成果。</w:t></w:r></w:p></w:body></w:document>')\nsys.stdout.buffer.write(b.getvalue())`;
 const fixture=spawnSync(py,['-X','utf8','-c',code]);assert.equal(fixture.status,0);
 const out=await parseResume(fixture.stdout);assert.equal(out.text,'完整经历，保留细节和成果。');
 await assert.rejects(parseResume(Buffer.from('bad')),/invalid_docx/);
});
