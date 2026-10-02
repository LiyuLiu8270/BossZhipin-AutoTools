import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync, existsSync} from 'node:fs';
import {request} from 'node:http';
import {createIntakeServer} from '../local/service.mjs';
import {collectPage} from '../shared/collector.js';

test('公共模块与后端无插件路径和宿主 API 依赖，发行入口已移除', async () => {
  assert.equal(existsSync(new URL('../extension/manifest.json', import.meta.url)), false);
  const visit = url => {
    for (const entry of readdirSync(url, {withFileTypes:true})) {
      if (entry.name === 'data' || entry.name === '__pycache__') continue;
      const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url);
      if (entry.isDirectory()) { visit(file); continue; }
      if (!/\.(js|mjs|py)$/.test(entry.name)) continue;
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /(?:\.\.\/)+extension\//, file.pathname);
      assert.doesNotMatch(source, /\bchrome\.(?:runtime|storage|tabs|scripting|debugger|permissions)\b/, file.pathname);
    }
  };
  visit(new URL('../shared/', import.meta.url));
  visit(new URL('../local/', import.meta.url));
  for (const name of readdirSync(new URL('../shared/', import.meta.url))) {
    if (name.endsWith('.js')) await import(`../shared/${name}`);
  }
  assert.match(collectPage.toString(), /function collectPage/);
  const html=readFileSync(new URL('../local/web/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/历史数据导入|id="import-(?:state|file|button|result)"/);
  assert.match(html,/导入 Word 简历/);
  assert.doesNotMatch(readFileSync(new URL('../local/web/app.js',import.meta.url),'utf8'),/\$\('#import-|api\('import'/);
  assert.doesNotMatch(html,/id="(?:pairing|pairing-code|copy-pairing|sync-state)"/);
  assert.doesNotMatch(readFileSync(new URL('../local/web/app.js',import.meta.url),'utf8'),/api\('pairing'/);
});

test('管理接口仅接受本机服务令牌；旧插件令牌/Origin、ingest 与配对不能写入', async () => {
  const token='a'.repeat(64);let stopped=false;
  const worker={status:()=>({states:[]})};
  const server=createIntakeServer({worker,token});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port, app=createIntakeServer({worker,token,port,onStop:()=>{stopped=true;}});
  server.removeAllListeners('request');server.on('request',app.listeners('request')[0]);
  const base=`http://127.0.0.1:${port}`,headers={'X-Service-Token':token};
  try {
    assert.equal((await fetch(base+'/health')).status,403);
    assert.equal((await fetch(base+'/health',{headers})).status,200);
    assert.equal((await fetch(base+'/health',{headers:{'X-Collector-Token':token}})).status,403);
    for(const origin of ['https://evil.example','null','chrome-extension://'+'a'.repeat(32)]) {
      assert.equal((await fetch(base+'/health',{headers:{...headers,Origin:origin}})).status,403);
      assert.equal((await fetch(base+'/stop',{method:'POST',headers:{...headers,Origin:origin}})).status,403);
    }
    const badHost=await new Promise((ok,fail)=>{const req=request(base+'/health',{headers:{...headers,Host:'evil.example'}},res=>{res.resume();ok(res.statusCode);});req.on('error',fail);req.end();});
    assert.equal(badHost,403);
    assert.equal((await fetch(base+'/ingest',{method:'POST',headers,body:'{}'})).status,404);
    assert.equal(stopped,false);
    assert.equal((await fetch(base+'/stop',{method:'POST',headers})).status,200);
    assert.equal(stopped,true);
  } finally {await new Promise(r=>server.close(r));}
});
