import {appendFileSync,mkdirSync,statSync,existsSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,join} from 'node:path';

// Never persist arbitrary provider text: even error messages can echo prompts or secrets.
const signatures={
 rate_limit:/rate[_ -]?limit|too many requests|限流/i,
 quota_exhausted:/insufficient_quota|quota.{0,30}(?:exceed|exhaust)|usage[_ -]?limit|额度不足/i,
 auth_failed:/invalid[_ -]?api[_ -]?key|authentication|unauthorized|invalid_token|token_expired/i,
 no_available_auth:/auth_unavailable|no available (?:auth|credentials?|accounts?)|no auth available|all accounts.{0,30}(?:cooldown|unavailable)/i,
 permission_denied:/permission denied|forbidden|EACCES|os error 10013/i,
 network_unreachable:/network.{0,20}unreachable|os error 10051|ENETUNREACH|ECONNREFUSED|connection refused|failed to connect/i,
 stream_disconnected:/stream (?:disconnected|closed)|connection (?:reset|closed)|ECONNRESET|unexpected eof/i,
 timeout:/timed? ?out|ETIMEDOUT|deadline exceeded/i,
 server_error:/internal server error|server_error|service unavailable|bad gateway|overloaded|upstream.{0,20}(?:error|unavailable)/i,
 invalid_request:/invalid_request|bad request|unsupported (?:parameter|value)|unknown (?:parameter|field)/i,
 model_unavailable:/model_not_found|model.{0,30}(?:not found|not supported|unavailable|does not exist)/i,
 context_limit:/context_length_exceeded|maximum context|too many tokens/i,
 schema_error:/invalid.{0,20}schema|schema.{0,20}(?:invalid|unsupported)|json_schema/i,
 retry_exhausted:/exceeded retry limit|retry limit.{0,20}(?:exceed|reach)|maximum retries/i,
 billing:/billing|payment required|credit balance/i,
 account_disabled:/account.{0,20}(?:deactivated|suspended|disabled)/i,
 process_missing:/ENOENT|not recognized as|not found in PATH|codex_binary_unavailable/i
};
export function diagnosticSignals(value){
 const parts=[];
 const visit=(v,depth=0)=>{if(depth>4||parts.length>=16)return;if(typeof v==='string')parts.push(v.slice(0,16384));else if(v&&typeof v==='object')for(const k of ['message','error','code','type','cause','details'])if(Object.hasOwn(v,k))visit(v[k],depth+1);};visit(value);
 const text=parts.join('\n'),categories=Object.entries(signatures).filter(([,re])=>re.test(text)).map(([key])=>key);
 const http_status=[...new Set([...text.matchAll(/(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status(?:\s+code)?["'\s:=]*)([45]\d{2})\b/gi)].map(m=>Number(m[1])))].slice(0,8);
 return {categories,http_status,unclassified:categories.length===0&&http_status.length===0};
}
export function appendModelDiagnostic(cwd,record){
 try{
  const directory=join(dirname(cwd),'model-diagnostics');mkdirSync(directory,{recursive:true});
  const path=join(directory,new Date().toISOString().slice(0,10)+'.jsonl');
  // Bounded daily diagnostic files; rotate only this logger's exact generated files.
  if(existsSync(path)&&statSync(path).size>=5*1024*1024){
   if(existsSync(path+'.3'))unlinkSync(path+'.3');
   for(let i=2;i>=1;i--)if(existsSync(path+'.'+i))renameSync(path+'.'+i,path+'.'+(i+1));
   renameSync(path,path+'.1');
  }
  appendFileSync(path,JSON.stringify({version:1,at:new Date().toISOString(),...record})+'\n','utf8');return true;
 }catch{process.stderr.write('model_diagnostic_write_failed\n');return false;}
}
