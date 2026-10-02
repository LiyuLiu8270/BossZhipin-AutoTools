import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createDetailPacer} from './detail-pacing.mjs';
import {collectPage} from '../shared/collector.js';
import {needsActivityBackfill,applyActivityCapture,hasActivity} from '../shared/activity.js';
import {companyEligible,applyCompanyCapture} from '../shared/company.js';
import {compareTitles} from '../shared/text-rules.js';
import {jobIdentity} from '../shared/core.js';

export function missingFields(job){return job.company_check?.state==='unavailable'?[]:[companyEligible(job)&&'company',needsActivityBackfill(job)&&'activity'].filter(Boolean);}
export function mergeBackfill(job,capture,now=new Date().toISOString()){
  if(jobIdentity(capture?.source_url)?.id!==job.id)throw new Error('detail_page_changed');
  if(!['captured','empty','job_unavailable'].includes(capture.status))throw new Error('capture_not_readable');
  if(capture.status==='captured'&&(capture.jobs?.length!==1||jobIdentity(capture.jobs[0].url)?.id!==job.id||compareTitles(job.title,capture.jobs[0].title).kind==='conflict'))throw new Error('detail_identity_conflict');
  let dataset={jobs:{[job.id]:job},runs:[]};
  if(companyEligible(job))dataset=applyCompanyCapture(dataset,capture,job.id,now).dataset;
  if(needsActivityBackfill(job))dataset=applyActivityCapture(dataset,capture,job.id,now).dataset;
  return dataset.jobs[job.id];
}

export async function executeBackfill(collector,run,signal){
  const {store,dataDir}=collector,directory=join(dataDir,'collection',run.id);
  Object.assign(run,{activityCompletionVersion:1,activityMissing:0,activityNotDisplayed:0,activityUnrecognized:0,companyMissing:0,failureReasons:{}});
  let consecutiveFailures=0;
  const pace=createDetailPacer(collector.backfillDelayMs??5000);
  mkdirSync(directory,{recursive:true});
  const checkpoint=()=>{if(signal.aborted)throw new Error('cancelled');collector.saveRun(run);};
  try{
    const rows=store.db.prepare('SELECT body FROM intake_jobs WHERE dataset=?').all(run.dataset).map(r=>JSON.parse(r.body))
      .filter(j=>missingFields(j).length).sort((a,b)=>Number(companyEligible(b))-Number(companyEligible(a))||a.id.localeCompare(b.id));
    run.detailTotal=rows.length;run.remaining=rows.length;checkpoint();
    if(!rows.length){run.state='completed';return;}
    await collector.browser();
    for(const queued of rows){
      checkpoint();
      const old=store.get(run.dataset,queued.id);if(!missingFields(old).length){run.remaining--;continue;}
      run.jobTitle=old.title;checkpoint();
      const identity=jobIdentity(old.url),job={job_link:identity.url};
      for(const key of ['security_id','lid'])if(typeof old.scraper_access?.[key]==='string'&&old.scraper_access[key].length<=4096)job[key]=old.scraper_access[key];
      await pace(signal);checkpoint();
      const result=await collector.readDetail('backfill',{job,expression:`JSON.stringify((${collectPage.toString()})())`},{directory,signal,timeoutMs:45000});
      checkpoint();
      if(['verification_required','login_required','detail_page_changed','browser_unavailable'].includes(result.error))throw new Error(result.error);
      if(result.ok&&result.payload){
        try{
          // Fetch again immediately before merging: preserve edits made while the page was loading.
          const current=store.get(run.dataset,queued.id),next=mergeBackfill(current,result.payload);
          const at=store.db.prepare('SELECT exported_at FROM intake_jobs WHERE dataset=? AND id=?').get(run.dataset,queued.id).exported_at;
          store.importPayload({schema_version:2,label:run.dataset,exported_at:new Date(Math.max(Date.now(),Date.parse(at)+1)).toISOString(),jobs:[next]},'backfill:local');
          const saved=store.get(run.dataset,queued.id);
          consecutiveFailures=0;
          run.companyResolved+=Number(companyEligible(current)&&!companyEligible(saved));
          run.activityFound+=Number(!hasActivity(current)&&hasActivity(saved));
          run.unavailable+=Number(saved.activity_check?.state==='unavailable'||saved.company_check?.state==='unavailable');
          const missing=missingFields(saved);
          run.activityMissing+=Number(missing.includes('activity'));
          run.companyMissing+=Number(missing.includes('company'));
          run.activityNotDisplayed+=Number(needsActivityBackfill(current)&&saved.activity_check?.state==='not_displayed');
          run.activityUnrecognized+=Number(missing.includes('activity')&&saved.activity_check?.reason==='activity_label_unrecognized');
          run.unresolved+=Number(missing.length>0);run.details++;
        }catch(e){if(e.message==='detail_page_changed')throw e;run.failedDetails++;consecutiveFailures++;run.lastError=e.message==='detail_identity_conflict'?e.message:'backfill_merge_failed';}
      }else{run.failedDetails++;consecutiveFailures++;run.lastError=result.error||'capture_not_readable';}
      if(consecutiveFailures)run.failureReasons[run.lastError]=(run.failureReasons[run.lastError]||0)+1;
      run.processed++;run.remaining--;checkpoint();
      if(consecutiveFailures>=3)throw new Error('backfill_repeated_failure');
      // The next page waits only for any remaining start-to-start interval.
    }
    run.state=run.failedDetails||run.unresolved?'partial':'completed';
  }catch(e){
    run.error=signal.aborted?'cancelled':/^[a-z_]+$/.test(e.message)?e.message:'backfill_failed';
    const gated=['verification_required','login_required','detail_page_changed','browser_unavailable','backfill_repeated_failure'].includes(run.error);
    run.state=run.error==='detail_daily_limit'?'daily_limit':run.error==='cancelled'?'cancelled':gated?'needs_attention':'failed';
    if(gated){collector.config.blocked=run.error;collector.persist();}
  }finally{run.finishedAt=collector.now();run.phase='finished';collector.saveRun(run);collector.active=null;}
}
