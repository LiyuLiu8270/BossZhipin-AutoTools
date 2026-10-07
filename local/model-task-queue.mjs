// Application-side admission, not a provider token-per-minute limiter.
export const MODEL_PRIORITIES={hr_reply:0,manual_greeting:10,resume_insight:10,chat_greeting:20,greeting:30,matching:40,research:50};
const communication=kind=>kind==='hr_reply'||kind==='chat_greeting';
export class ModelTaskQueue {
 constructor({capacity,reserveCommunication=()=>false,now=Date.now}={}){
  Object.assign(this,{capacity,reserveCommunication,now});this.sources=new Map();this.running=new Set();this.closed=false;this.sequence=0;
 }
 get active(){return this.running.size;}
 register(id,source){
  if(this.closed)throw Error('model_queue_stopped');
  if(!Object.hasOwn(MODEL_PRIORITIES,source.kind))throw Error('invalid_model_task_kind');
  if(this.sources.has(id))throw Error('duplicate_model_source');
  const entry={...source,id,order:this.sequence++,since:null};this.sources.set(id,entry);this.wake();
  return ()=>{this.sources.delete(id);this.wake();};
 }
 submit({id,kind,run,valid=()=>true}){
  return new Promise((resolve,reject)=>{
   let remove;
   try{remove=this.register(id,{kind,ready:()=>true,cancel:()=>reject(Error('model_queue_stopped')),run:()=>{
    remove();if(!valid())throw Error('model_task_obsolete');return run();
   },resolve,reject});}catch(e){reject(e);}
  });
 }
 wake(){if(this.closed||this.scheduled)return;this.scheduled=setImmediate(()=>{this.scheduled=null;this.pump();});}
 candidates(){
  const at=this.now(),ready=[];
  for(const source of this.sources.values()){
   let available;try{available=source.ready();}catch(e){this.lastError={kind:source.kind,code:'model_queue_source_failed',at:this.now()};available=false;}
   if(!available){source.since=null;continue;}
   source.since??=at;
   const base=MODEL_PRIORITIES[source.kind];
   ready.push({source,priority:base});
  }
  return ready.sort((a,b)=>a.priority-b.priority||a.source.since-b.source.since||a.source.order-b.source.order);
 }
 pump(){
  if(this.closed)return;
  let candidates=this.candidates();
  while(!this.closed&&this.active<this.capacity()){
   if(!candidates.length)break;
   const reserve=this.capacity()>1&&this.reserveCommunication()?1:0;
   const background=[...this.running].filter(s=>!communication(s.kind)).length;
   const next=candidates.find(({source})=>communication(source.kind)||background<this.capacity()-reserve);
   if(!next)break;
   const {source}=next;source.since=null;
   const slot={kind:source.kind,startedAt:this.now()};this.running.add(slot);
   let result;try{result=source.run();}catch(e){result=Promise.reject(e);}
   slot.promise=Promise.resolve(result).then(v=>{source.resolve?.(v);return v;},e=>{source.reject?.(e);return {status:'failed',code:e.message};}).finally(()=>{this.running.delete(slot);this.wake();});
   candidates=this.candidates();
  }
 }
 status(){const counts={};for(const s of this.running)counts[s.kind]=(counts[s.kind]||0)+1;
  return {limit:this.capacity(),active:this.active,reservedCommunication:this.capacity()>1&&this.reserveCommunication()?1:0,activeByKind:counts,lastError:this.lastError||null,
   waiting:[...this.sources.values()].filter(s=>s.since!==null).map(s=>({kind:s.kind,waitSeconds:Math.max(0,Math.floor((this.now()-s.since)/1000))}))};
 }
 stop(){if(this.closed)return;this.closed=true;clearImmediate(this.scheduled);this.scheduled=null;for(const s of this.sources.values())s.cancel?.();this.sources.clear();}
 async close(){this.stop();await Promise.allSettled([...this.running].map(s=>s.promise));}
}
