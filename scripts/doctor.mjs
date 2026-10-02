import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {projectRoot,pythonPath} from '../local/runtime-paths.mjs';
import {codexRuntimeStatus} from '../local/codex-executable.mjs';

const checks=[];
const add=(name,ok,required=true)=>checks.push({name,status:ok?'ready':required?'missing':'optional / configure before use',required});
add('Node.js 24+',Number(process.versions.node.split('.')[0])>=24);
add('Windows desktop and collector',process.platform==='win32');
try {
  const r=spawnSync(pythonPath(),['-c','import sys,requests,websocket; assert sys.version_info >= (3,10)'],{windowsHide:true,timeout:10000,stdio:'ignore'});
  add('Python 3.10+ and collection dependencies',r.status===0);
}catch{add('Python 3.10+ and collection dependencies',false);}
const manifest=JSON.parse(readFileSync(new URL('../vendor/boss-zhipin-scraper/SOURCE.json',import.meta.url),'utf8'));
add('Pinned upstream source integrity',Object.entries(manifest.sha256).every(([path,hash])=>{
  const file=join(projectRoot,'vendor/boss-zhipin-scraper',path);
  return existsSync(file)&&createHash('sha256').update(readFileSync(file)).digest('hex')===hash;
}));
add('Microsoft Edge',['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].some(existsSync),false);
add('Codex native CLI (authentication not tested)',codexRuntimeStatus().available,false);
console.table(checks);
console.log('Read-only checks; no browser launch, platform request, model call or credential inspection.');
if(checks.some(c=>c.required&&c.status==='missing'))process.exitCode=1;
