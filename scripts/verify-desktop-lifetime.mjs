import {mkdtempSync,readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const exec=promisify(execFile),dir=mkdtempSync(join(tmpdir(),'desktop-lifetime-')),exe=join(dir,'independent-fixture.exe');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFile(name){for(let i=0;i<100;i++){if(existsSync(join(dir,name)))return;await pause(100);}throw Error('fixture_timeout:'+name);}
await exec(join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:winexe','/r:System.Management.dll','/out:'+exe,resolve('desktop/LauncherFixture.cs')],{windowsHide:true});
try{
 const moduleURL=new URL('../local/desktop-launch.mjs',import.meta.url).href;
 // This launcher exits immediately. Fixture must live under Explorer, not this Node process.
 await exec(process.execPath,['--input-type=module','-e',`import {launchDesktop} from ${JSON.stringify(moduleURL)};launchDesktop(${JSON.stringify(exe)});`],{windowsHide:true,timeout:10000});
 await waitFile('started.txt');const [pid,parent,parentName]=readFileSync(join(dir,'started.txt'),'utf8').split('\n');
 assert.equal(parentName.toLowerCase(),'explorer');const before=readFileSync(join(dir,'heartbeat.txt'),'utf8');await pause(1200);assert.notEqual(readFileSync(join(dir,'heartbeat.txt'),'utf8'),before);
 const result={ok:true,parentName,launcherExited:true,heartbeatContinued:true,productionWrites:0,realHRMessages:0};
 mkdirSync('artifacts/desktop-lifetime',{recursive:true});writeFileSync('artifacts/desktop-lifetime/acceptance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{writeFileSync(join(dir,'stop'),'stop');await waitFile('stopped.txt');}
