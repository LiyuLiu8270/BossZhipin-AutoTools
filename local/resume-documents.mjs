import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {pythonPath} from './runtime-paths.mjs';

export const RESUME_MAX_BYTES=10*1024*1024;
export function parseResume(buffer){
  return new Promise((resolve,reject)=>{
    const python=pythonPath();
    const child=spawn(python,['-X','utf8',fileURLToPath(new URL('./parse-resume.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let output='',done=false;
    const finish=(err,value)=>{if(done)return;done=true;clearTimeout(timer);if(err){child.kill();reject(new Error(err));}else resolve(value);};
    const timer=setTimeout(()=>finish('resume_parse_timeout'),20000);
    child.on('error',()=>finish('resume_parser_unavailable'));child.stderr.resume();
    child.stdin.on('error',()=>finish('resume_parse_failed'));child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{output+=chunk;if(output.length>8*1024*1024)finish('resume_text_limit');});
    child.on('close',()=>{if(done)return;try{const r=JSON.parse(output);if(!r.ok)return finish(/^resume_[a-z_]+$/.test(r.error)?r.error:'resume_parse_failed');if(typeof r.document?.text!=='string'||!r.document.text.trim()||!Array.isArray(r.document.blocks))return finish('resume_parse_failed');finish(null,r.document);}catch{finish('resume_parse_failed');}});
    child.stdin.end(buffer);
  });
}

// Separate from worker.profile: storing a source document never changes matching inputs.
export class ResumeDocuments {
  constructor(db,{parser=parseResume}={}){
    this.db=db;this.parser=parser;this.busy=false;
    db.exec(`CREATE TABLE IF NOT EXISTS resume_documents(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL UNIQUE,filename TEXT NOT NULL,bytes INTEGER NOT NULL,imported_at TEXT NOT NULL,original BLOB NOT NULL,parsed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS resume_current(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL);`);
  }
  current(){
    const row=this.db.prepare('SELECT d.id,d.sha256,d.filename,d.bytes,d.imported_at,d.parsed FROM resume_documents d JOIN resume_current c ON c.id=d.id WHERE c.singleton=1').get();
    if(!row)return null;
    const {parsed,...meta}=row;return {...JSON.parse(parsed),...meta,matching_connected:false};
  }
  original(){return this.db.prepare('SELECT d.filename,d.original FROM resume_documents d JOIN resume_current c ON c.id=d.id WHERE c.singleton=1').get()||null;}
  async import(value){
    if(this.busy)throw new Error('resume_import_busy');
    if(!value||typeof value.filename!=='string'||value.filename.length>240||/[\\/\x00-\x1f]/.test(value.filename))throw new Error('resume_invalid_filename');
    if(!/\.docx$/i.test(value.filename))throw new Error('resume_docx_required');
    if(typeof value.base64!=='string'||value.base64.length>Math.ceil(RESUME_MAX_BYTES/3)*4||!value.base64.length||value.base64.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64))throw new Error('resume_file_size');
    const buffer=Buffer.from(value.base64,'base64');
    if(!buffer.length||buffer.length>RESUME_MAX_BYTES)throw new Error('resume_file_size');
    this.busy=true;
    try{
      const hash=createHash('sha256').update(buffer).digest('hex');
      const existing=this.db.prepare('SELECT id FROM resume_documents WHERE sha256=?').get(hash);
      // Parsing failure never replaces the previously saved document.
      const parsed=existing?null:await this.parser(buffer),id=existing?.id||randomUUID();
      this.db.exec('BEGIN IMMEDIATE');
      try{
        if(!existing)this.db.prepare('INSERT INTO resume_documents VALUES(?,?,?,?,?,?,?)').run(id,hash,value.filename,buffer.length,new Date().toISOString(),buffer,JSON.stringify(parsed));
        this.db.prepare('INSERT INTO resume_current VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET id=excluded.id').run(id);
        this.db.exec('COMMIT');
      }catch(e){this.db.exec('ROLLBACK');throw e;}
      return {ok:true,status:existing?'already_saved':'saved',document:this.current()};
    }finally{this.busy=false;}
  }
}
