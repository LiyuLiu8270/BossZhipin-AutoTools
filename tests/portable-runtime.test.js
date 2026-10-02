import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pythonPath,projectRoot} from '../local/runtime-paths.mjs';
import {IntakeStore} from '../local/intake.mjs';
import {MatchWorker} from '../local/worker.mjs';
import {WebController} from '../local/web-controller.mjs';
import {Collector} from '../local/collector.mjs';
import {createIntakeServer} from '../local/service.mjs';
import {createWebHandler} from '../local/web-handler.mjs';

test('portable Python discovery uses only the project environment or explicit absolute override',()=>{
  const root=mkdtempSync(join(tmpdir(),'boss-portable-'));
  try{
    assert.throws(()=>pythonPath({root,env:{},platform:'win32'}),/python_runtime_unavailable/);
    const dir=join(root,'.venv','Scripts');mkdirSync(dir,{recursive:true});
    const executable=join(dir,'python.exe');writeFileSync(executable,'fixture');
    assert.equal(pythonPath({root,env:{},platform:'win32'}),executable);
    assert.throws(()=>pythonPath({root,env:{BOSS_TOOLS_PYTHON:'relative.exe'}}),/python_runtime_unavailable/);
    assert.throws(()=>pythonPath({root,env:{BOSS_TOOLS_PYTHON:join(root,'missing.exe')}}),/python_runtime_unavailable/);
    assert.equal(pythonPath({root,env:{BOSS_TOOLS_PYTHON:executable}}),executable);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('bundled upstream imports from the project without a sibling checkout or platform access',()=>{
  const code=`import importlib.util, pathlib, sys\np=pathlib.Path(sys.argv[1])/'vendor/boss-zhipin-scraper/scripts/boss_cdp_raw.py'\nspec=importlib.util.spec_from_file_location('portable_upstream',p)\nm=importlib.util.module_from_spec(spec)\nsys.modules[spec.name]=m\nspec.loader.exec_module(m)\nassert m.__version__=='2.3.0'\nassert callable(m.CDPSession)\nassert p.parent.parent.joinpath('data/city_codes.json').is_file()\nprint('portable_upstream_ready')`;
  const result=spawnSync(pythonPath(),['-X','utf8','-c',code,projectRoot],{windowsHide:true,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/portable_upstream_ready/);
});

test('fresh installation exposes empty authenticated UI and leaves collection and analysis off',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'boss-fresh-')),store=new IntakeStore(join(dataDir,'jobs.sqlite'));
  const never=async()=>{throw new Error('unexpected_external_call');};
  const worker=new MatchWorker(store,{mode:'resume_missing',facts:{}},{dataDir,runner:never,greetingRunner:never});
  const controller=new WebController(store,worker,{resumeOnly:true});
  const collector=new Collector(store,controller,{dataDir,runner:never,browser:never});controller.collector=collector;
  const token='b'.repeat(64),server=createIntakeServer({worker,token});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
  const port=server.address().port,base=`http://127.0.0.1:${port}`;
  server.removeAllListeners('request');
  server.on('request',createIntakeServer({worker,token,port,webHandler:createWebHandler({controller,port})}).listeners('request')[0]);
  try{
    const page=await fetch(base);assert.equal(page.status,200);assert.match(await page.text(),/岗位推荐/);
    const headers={Cookie:page.headers.get('set-cookie').split(';')[0],'X-Local-UI':'1'};
    const state=await fetch(base+'/api/state',{headers});assert.equal(state.status,200);
    assert.equal((await state.json()).settings.autoAnalyze,false);
    assert.equal((await(await fetch(base+'/api/jobs',{headers})).json()).total,0);
    assert.equal(controller.resumeDocuments.current(),null);
    assert.equal(collector.config.enabled,false);assert.equal(collector.config.dataset,'我的求职');
  }finally{
    await new Promise(ok=>server.close(ok));await controller.scheduler.close();await collector.close();store.close();rmSync(dataDir,{recursive:true,force:true});
  }
});
