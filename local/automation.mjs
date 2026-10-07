import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {IntakeStore} from './intake.mjs';
import {MatchWorker} from './worker.mjs';
import {createIntakeServer} from './service.mjs';
import {WebController} from './web-controller.mjs';
import {createWebHandler} from './web-handler.mjs';
import {Collector} from './collector.mjs';
import {JobOpener} from './job-opener.mjs';
import {ResumeInsights} from './resume-insights.mjs';
import {Communications} from './communication.mjs';
import {CompanyResearch} from './company-research.mjs';
import {installLifecycle} from './service-lifecycle.mjs';
import {VERSION} from '../shared/core.js';

const [command='serve',...args]=process.argv.slice(2), opts={};
for(let i=0;i<args.length;i+=2){if(!['--file','--data','--limit','--daily-limit','--dataset','--id','--status','--resume-backfill'].includes(args[i])||!args[i+1])throw new Error('invalid_arguments');opts[args[i].slice(2)]=args[i+1];}
if(!['serve','stop','import','once','status','contact','retry'].includes(command))throw new Error('invalid_command');
if(opts['resume-backfill']!==undefined&&(command!=='serve'||!['true','false'].includes(opts['resume-backfill'])))throw new Error('invalid_resume_backfill');
const dataDir=resolve(opts.data||fileURLToPath(new URL('./data/',import.meta.url)));
mkdirSync(dataDir,{recursive:true});
const lifecycle=command==='serve'?installLifecycle(dataDir,{version:VERSION}):()=>{};
const profile={mode:'resume_missing',source:'尚未导入Word简历',facts:{}};
const dailyLimit=Number(opts['daily-limit']||200), limit=Number(opts.limit||3);
if(!Number.isSafeInteger(dailyLimit)||dailyLimit<1||!Number.isInteger(limit)||limit<1||limit>10)throw new Error('invalid_limit');
const store=new IntakeStore(join(dataDir,'jobs.sqlite'));
const worker=new MatchWorker(store,profile,{dataDir,dailyLimit});
const controller=new WebController(store,worker,{resumeOnly:true});
if(opts['daily-limit'])controller.saveSettings({...controller.settings,dailyLimit});
const log=v=>console.log(JSON.stringify({at:new Date().toISOString(),...v}));
let server,collector,collectionTimer;
try{
  if(command==='stop'){
    const token=readFileSync(join(dataDir,'service-token.txt'),'utf8').trim();
    const response=await fetch('http://127.0.0.1:17321/stop',{method:'POST',headers:{'X-Service-Token':token},signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok)throw new Error('service_stop_not_confirmed');
    log(await response.json());
  }
  if(command==='import'){if(!opts.file)throw new Error('file_required');log(store.importFile(opts.file));worker.render();}
  if(command==='once')log(await worker.nextStep());
  if(command==='contact'){worker.contact(opts.dataset,opts.id,opts.status);log({status:'contact_updated'});}
  if(command==='retry'){worker.retryFailed();log({status:'failed_jobs_requeued'});}
  if(command==='status')log(worker.status());
  if(command==='serve'){
    const tokenPath=join(dataDir,'service-token.txt');
    if(!existsSync(tokenPath))writeFileSync(tokenPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
    const token=readFileSync(tokenPath,'utf8').trim();
    if(!/^[a-f0-9]{64}$/.test(token))throw new Error('invalid_service_token');
    let stopped=false,wakeStop;const stop=(reason='api')=>{if(stopped)return;lifecycle('stop_requested',{reason});stopped=true;controller.scheduler.stop();controller.communications?.stop();controller.companyResearch?.stop();controller.modelQueue.stop();collector?.stop();wakeStop?.();};
    server=createIntakeServer({worker,token,onStop:stop,webHandler:createWebHandler({controller}),communicationAlerts:()=>{const alerts=controller.communications?.notifications()||[];return {unread:alerts.length,latestId:alerts[0]?.id||''};}});
    await new Promise((ok,fail)=>{server.once('error',fail);server.listen(17321,'127.0.0.1',ok);});
    controller.resumeInsights=new ResumeInsights(controller);
    collector=new Collector(store,controller,{dataDir});controller.collector=collector;
    controller.jobOpener=new JobOpener(store,{dataDir});
    controller.communications=new Communications(controller,{dataDir});controller.communications.start();
    controller.companyResearch=new CompanyResearch(controller,{dataDir});controller.companyResearch.start();
    // Explicit upgrade resume: acquire the collection lock before an overdue timer can run.
    if(opts['resume-backfill']==='true'){collector.backfill();log({status:'backfill_resumed'});}
    log({status:'serving',address:'127.0.0.1:17321',report:join(dataDir,'reports','latest.md'),daily_limit:worker.dailyLimit});
    lifecycle('service_ready');
    collectionTimer=setInterval(()=>{if(!stopped)collector.tick().catch(()=>log({status:'collection_scheduler_error'}));},1000);
    worker.render();
    const interrupt=()=>stop('SIGINT'),terminate=()=>stop('SIGTERM');
    process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
    controller.scheduler.onResult=result=>{if(!['idle','paused'].includes(result.status))log(result);};
    controller.scheduler.onAvailable=()=>controller.companyResearch?.tick().catch(()=>{});
    controller.scheduler.start();
    if(!stopped)await new Promise(resolve=>{wakeStop=resolve;});
    await controller.scheduler.close();
    worker.flushReport();
    process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
  }
}finally{clearInterval(collectionTimer);controller.companyResearch?.stop();controller.modelQueue.stop();await controller.scheduler.close();await controller.communications?.close();await controller.companyResearch?.close();if(collector)await collector.close();await controller.resumeInsights?.close();await controller.modelQueue.close();if(server)await new Promise(r=>server.close(r));worker.flushReport();store.close();lifecycle('shutdown_complete');}
