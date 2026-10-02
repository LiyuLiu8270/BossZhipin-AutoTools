// Reusable concurrency permits, not a time-refilled rate-limit bucket.
export class MatchScheduler {
 constructor(worker,{canRun,capacity,onResult=()=>{},pollMs=1000}){
  Object.assign(this,{worker,canRun,capacity,onResult,pollMs});this.running=new Set();this.started=false;this.closed=false;
 }
 get active(){return this.running.size;}
 start(){if(this.started||this.closed)return;this.started=true;this.timer=setInterval(()=>this.wake(),this.pollMs);this.wake();}
 wake(){if(!this.started||this.closed||this.scheduled)return;this.scheduled=setImmediate(()=>{this.scheduled=null;this.pump();});}
 pump(){
  if(this.closed||!this.canRun())return;
  while(this.active<this.capacity()&&this.canRun()){
   // Reserve before invoking: no cohort barrier and never oversubscribe.
   const slot={};this.running.add(slot);
   slot.promise=Promise.resolve().then(()=>this.closed||!this.canRun()?{status:'paused'}:this.worker.nextStep()).catch(()=>({status:'failed',code:'scheduler_task_failed'})).then(result=>{
    try{this.onResult(result);}catch{/* Logging must never leak a permit. */}
    return result;
   }).finally(()=>{this.running.delete(slot);});
   slot.promise.then(result=>{if(!['idle','paused'].includes(result.status)&&result.code!=='scheduler_task_failed')this.wake();});
  }
 }
 stop(){this.closed=true;clearInterval(this.timer);clearImmediate(this.scheduled);this.scheduled=null;}
 async close(){this.stop();await Promise.allSettled([...this.running].map(s=>s.promise));}
}
