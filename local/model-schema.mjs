import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

// Load alongside the calling module, so a still-running old process cannot
// combine its old validator with a newly deployed schema on disk.
export function loadSchemaSnapshot(url){
 const text=readFileSync(url,'utf8');JSON.parse(text);
 return Object.freeze({text,hash:createHash('sha256').update(text).digest('hex')});
}
export function materializeSchema(snapshot,cwd){
 if(!snapshot||typeof snapshot.text!=='string'||snapshot.hash!==createHash('sha256').update(snapshot.text).digest('hex'))throw Error('schema_snapshot_invalid');
 const dir=join(cwd,'.schemas');mkdirSync(dir,{recursive:true});const path=join(dir,snapshot.hash+'.json');
 try{writeFileSync(path,snapshot.text,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;if(readFileSync(path,'utf8')!==snapshot.text)throw Error('schema_snapshot_conflict');}
 return path;
}
