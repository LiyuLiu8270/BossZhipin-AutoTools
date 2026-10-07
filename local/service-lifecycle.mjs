import {appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';

// Independent from tray stdout pipes. Do not log prompts, credentials or raw errors.
export function installLifecycle(dataDir,{runtime=process,version='unknown'}={}){
 const file=join(dataDir,'service-lifecycle.jsonl');
 const record=(event,fields={})=>{try{mkdirSync(dataDir,{recursive:true});appendFileSync(file,JSON.stringify({at:new Date().toISOString(),pid:runtime.pid,ppid:runtime.ppid,event,version,...fields})+'\n','utf8');}catch{/* Logging failure cannot bring down the service. */}};
 record('process_start',{node:runtime.version,executable:runtime.execPath});
 const fatal=(error,origin)=>record('fatal_error',{origin,type:error?.name||'Error',code:/^[A-Z_0-9]+$/.test(error?.code||'')?error.code:null,frames:String(error?.stack||'').split('\n').filter(line=>/^\s+at /.test(line)).slice(0,8).map(line=>line.trim())});
 const exit=code=>record('process_exit',{code});
 runtime.on('uncaughtExceptionMonitor',fatal);runtime.on('exit',exit);
 return record;
}
