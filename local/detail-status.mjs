import {jobIdentity,readableJD} from '../shared/core.js';

export const jobAvailability=job=>job.recruitment_signals?.availability?.value==='explicit_unavailable'?'closed':job.link_access?.state==='unavailable'?'unavailable':'unknown';
export const overviewStage=job=>jobAvailability(job)!=='unknown'?'terminal':readableJD(job)?'collected':'awaiting';
export function collectionOverview(rows){
 const counts={total:rows.length,collected:0,terminal:0,awaiting:0,closed:0,unavailable:0};
 for(const r of rows){counts[overviewStage(r.job)]++;const a=jobAvailability(r.job);if(a!=='unknown')counts[a]++;}
 return counts;
}
// Mutually exclusive facts about missing bodies, not model/field-backfill state.
export function detailState(job,queue,now=Date.now()){
 if(readableJD(job))return 'captured';
 const availability=jobAvailability(job);if(availability!=='unknown')return availability;
 if(jobIdentity(job.url)?.id!==job.id||job.detail_review?.state==='needs_review'||queue?.state==='review')return 'review';
 if(queue?.state==='pending')return queue.retry_at>now?'waiting_retry':'pending';
 return 'unqueued';
}
export function detailQueueMap(db){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='collection_details'").get())return new Map();
 return new Map(db.prepare('SELECT dataset,id,state,retry_at,attempts FROM collection_details').all().map(r=>[JSON.stringify([r.dataset,r.id]),r]));
}
export function detailSummary(rows){
 const counts={total:rows.length,captured:0,missing:0,pending:0,waiting_retry:0,review:0,closed:0,unavailable:0,unqueued:0,nextRetryAt:null};
 for(const r of rows){counts[r.detail_state]++;if(r.detail_state!=='captured')counts.missing++;
  if(r.detail_state==='waiting_retry')counts.nextRetryAt=counts.nextRetryAt===null?r.detail_retry_at:Math.min(counts.nextRetryAt,r.detail_retry_at);
 }
 return counts;
}
export function detailRows(store,dataset,now=Date.now()){
 const queues=detailQueueMap(store.db);
 const rows=store.jobsSnapshot?store.jobsSnapshot().filter(r=>dataset===undefined||r.dataset===dataset):dataset===undefined?store.db.prepare('SELECT dataset,id,body FROM intake_jobs').all():store.db.prepare('SELECT dataset,id,body FROM intake_jobs WHERE dataset=?').all(dataset);
 return rows.map(r=>{const job=r.job||JSON.parse(r.body),queue=queues.get(JSON.stringify([r.dataset,r.id]));return {...r,job,detail_state:detailState(job,queue,now),detail_retry_at:queue?.retry_at||0};});
}
