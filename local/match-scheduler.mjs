// Reusable concurrency permits, not a time-refilled rate-limit bucket.
export class MatchScheduler {
 constructor(worker,{canRun,capacity,queue=null,stages=()=>({matching:true,greeting:true}),onResult=()=>{},pollMs=1000}){
  Object.assign(this,{worker,canRun,capacity,queue,stages,onResult,pollMs});this.running=new Set();this.started=false;this.closed=false;
 }
 get active(){return this.running.size;}
 start(){if(this.started||this.closed)return;this.started=true;
  if(this.queue)this.unregister=['manual_greeting','greeting','matching'].map(kind=>this.queue.register('worker:'+kind,{kind,
   ready:()=>!this.closed&&this.canRun()&&(kind==='manual_greeting'||this.stages()[kind])&&this.worker.stageReady(kind),
   run:()=>this.runQueuedStage(kind)}));
  this.timer=setInterval(()=>this.wake(),this.pollMs);this.wake();}
 wake(){if(!this.started||this.closed)return;if(this.queue){this.queue.wake();return;}if(this.scheduled)return;this.scheduled=setImmediate(()=>{this.scheduled=null;this.pump();});}
 runQueuedStage(kind){const slot={};this.running.add(slot);
  slot.promise=this.worker.runStage(kind).catch(()=>({status:'failed',code:'scheduler_task_failed'})).then(result=>{try{this.onResult(result);}catch{}return result;}).finally(()=>{this.running.delete(slot);this.notifyAvailable();});return slot.promise;
 }
 pump(){
  if(this.closed||!this.canRun())return;
  while(this.active<this.capacity()&&this.canRun()){
   // Reserve before invoking: no cohort barrier and never oversubscribe.
   const slot={};this.running.add(slot);
   slot.promise=Promise.resolve().then(()=>this.closed||!this.canRun()?{status:'paused'}:this.worker.nextStep(this.stages())).catch(()=>({status:'failed',code:'scheduler_task_failed'})).then(result=>{
    try{this.onResult(result);}catch{/* Logging must never leak a permit. */}
    return result;
   }).finally(()=>{this.running.delete(slot);this.notifyAvailable();});
   slot.promise.then(result=>{if(!['idle','paused'].includes(result.status)&&result.code!=='scheduler_task_failed')this.wake();});
  }
 }
 notifyAvailable(){
  if(this.closed||this.availableNotification)return;
  // Coalesce only notifications within this event-loop turn, never model work.
  // Sixteen idle permits must not synchronously rescan a sibling queue 16 times.
  this.availableNotification=setImmediate(()=>{this.availableNotification=null;try{this.onAvailable?.();}catch{/* Optional sibling queues cannot strand a permit. */}});
 }
 stop(){this.closed=true;for(const remove of this.unregister||[])remove();this.unregister=[];clearInterval(this.timer);clearImmediate(this.scheduled);clearImmediate(this.availableNotification);this.availableNotification=null;this.scheduled=null;}
 async close(){this.stop();await Promise.allSettled([...this.running].map(s=>s.promise));}
}
