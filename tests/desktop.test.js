import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';

const exec = promisify(execFile), root=fileURLToPath(new URL('../',import.meta.url));
const compiler=join(process.env.WINDIR||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
test('Windows 托盘底层：中文路径、鉴权、无重定向、隐藏启动、重复进程保护、正常停止', {skip:process.platform!=='win32'||!existsSync(compiler)}, async t=>{
  const temp=mkdtempSync(join(tmpdir(),'xunxu desktop-')), project=join(temp,'中文 路径'), exe=join(temp,'harness.exe');
  mkdirSync(join(project,'local/data'),{recursive:true});
  const token='a'.repeat(64);writeFileSync(join(project,'local/data/service-token.txt'),token);
  const run=(...args)=>exec(exe,args,{windowsHide:true,timeout:20000});
  try {
    await exec(compiler,['/nologo','/target:exe','/codepage:65001','/main:Xunxu.DesktopTests',`/out:${exe}`,'/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',join(root,'desktop/TrayApp.cs'),join(root,'desktop/DesktopTests.cs')],{windowsHide:true});
    let mode='healthy', stops=0, redirectHits=0;
    const server=createServer((req,res)=>{
      if(req.url==='/redirect-target'){redirectHits++;res.end('{}');return;}
      assert.equal(req.headers['x-service-token'],token);
      if(mode==='redirect'){res.writeHead(302,{Location:'/redirect-target'});res.end();return;}
      if(mode==='foreign'){res.end(JSON.stringify({ok:true}));return;}
      if(mode==='denied'){res.writeHead(403);res.end('{}');return;}
      if(req.url==='/stop'){stops++;res.end(JSON.stringify({ok:true,status:'stopping_after_current_batch'}));return;}
      if(mode==='alerts'){res.end(JSON.stringify({ok:true,states:[],daily_limit:200,communicationAlerts:{unread:2,latestId:'synthetic-event'}}));return;}
      res.end(JSON.stringify({ok:true,states:[],daily_limit:200}));
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const port=String(server.address().port);
    try {
      await t.test('attach existing authenticated service without starting or stopping it',async()=>{
        assert.equal((await run('probe',project,port)).stdout,'healthy'); assert.equal(stops,0);
      });
      await t.test('reject unauthorized, redirects and other applications',async()=>{
        for(mode of ['denied','redirect','foreign']) assert.equal((await run('probe',project,port)).stdout,'unverified');
        assert.equal(redirectHits,0);assert.equal(stops,0);mode='healthy';
      });
      await t.test('single authenticated graceful stop request',async()=>{
        assert.equal((await run('stop',project,port)).stdout,'stopping'); assert.equal(stops,1);
      });
      await t.test('tray reads only alert count and event id from authenticated health',async()=>{mode='alerts';assert.equal((await run('alerts',project,port)).stdout,'2:synthetic-event');mode='healthy';});
    } finally { await new Promise(r=>server.close(r)); }
    await t.test('invalid token remains unreadable to service and no requests made',async()=>{
      writeFileSync(join(project,'local/data/service-token.txt'),'invalid');
      assert.equal((await run('probe',project,port)).stdout,'unverified');
      writeFileSync(join(project,'local/data/service-token.txt'),token);
    });
    await t.test('launch and stop isolated fixture; no CMD, no production DB/model/browser',async()=>{
      writeFileSync(join(project,'local/automation.mjs'),`import {createServer} from 'node:http';const s=createServer((q,r)=>{if(q.headers['x-service-token']!=='${token}'){r.writeHead(403);r.end();return;}r.end(JSON.stringify(q.url==='/stop'?{ok:true,status:'stopping_after_current_batch'}:{ok:true,states:[],daily_limit:200}));if(q.url==='/stop')s.close();});s.listen(${port},'127.0.0.1');console.log('fixture_started');`);
      assert.equal((await run('start',project,port)).stdout,'started_hidden_duplicate_blocked_stopped:True:False');
      assert.match(readFileSync(join(project,'local/data/web-service.log'),'utf8'),/fixture_started/);
      assert.equal((await run('root',project)).stdout,project);
    });
    await t.test('Windows argument quoting handles spaces, quotes and trailing slashes',async()=>{
      assert.equal((await run('quote','C:\\中文 路径\\')).stdout,'"C:\\中文 路径\\\\"');
      assert.equal((await run('quote','a"b')).stdout,'"a\\"b"');
    });
  } finally {rmSync(temp,{recursive:true,force:true});}
});

test('desktop entry is a Windows GUI app with single-instance and graceful-stop protections',()=>{
  const source=readFileSync(join(root,'desktop/TrayApp.cs'),'utf8');
  const build=readFileSync(join(root,'scripts/build-desktop.ps1'),'utf8');
  assert.match(build,/target:winexe/);assert.match(source,/new NotifyIcon/);
  assert.match(source,/new Mutex/);assert.match(source,/EventWaitHandle/);
  assert.match(source,/closedChecks >= 3/);assert.doesNotMatch(source,/\.Kill\(|cmd\.exe|powershell\.exe/);
  assert.match(source,/打开控制台/);assert.match(source,/停止服务并退出/);
});
