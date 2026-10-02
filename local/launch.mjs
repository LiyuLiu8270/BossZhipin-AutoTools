import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const address='http://127.0.0.1:17321/';
async function ready(){try{const r=await fetch(address,{signal:AbortSignal.timeout(1500)});return r.ok&&(await r.text()).includes('循序 · 求职助手');}catch{return false;}}
if(!await ready()){
  try{const response=await fetch(address,{signal:AbortSignal.timeout(1000)});if(response){console.error('端口 17321 已被旧服务或其他程序占用，请先从托盘正常退出，或使用开发维护命令 npm.cmd stop。');process.exit(1);}}catch{}
  const directory=fileURLToPath(new URL('./data/',import.meta.url));mkdirSync(directory,{recursive:true});
  const out=openSync(new URL('./data/web-service.log',import.meta.url),'a'),err=openSync(new URL('./data/web-service-error.log',import.meta.url),'a');
  const child=spawn(process.execPath,[fileURLToPath(new URL('./automation.mjs',import.meta.url)),'serve',...(process.argv.includes('--resume-backfill')?['--resume-backfill','true']:[])],{detached:true,windowsHide:true,stdio:['ignore',out,err]});
  child.on('error',()=>{console.error('服务启动失败，请检查 Node.js 安装。');process.exitCode=1;});child.unref();closeSync(out);closeSync(err);
  for(let i=0;i<20&&!await ready();i++)await new Promise(r=>setTimeout(r,250));
}
if(!await ready()){console.error('服务未启动成功，请查看 local/data/web-service-error.log。');process.exit(1);}
if(!process.argv.includes('--no-open'))console.log('维护服务已就绪；请在浏览器打开 '+address+'。日常使用请启动循序求职助手.exe。');
console.log('循序已启动：'+address+'；关闭网页不会停止服务。');
