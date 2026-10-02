import {setTimeout as delay} from 'node:timers/promises';

// Minimum start-to-start interval. Reading time counts toward the interval;
// never add a complete sleep after an already slow page or after the last job.
export function createDetailPacer(intervalMs=5000,{now=()=>performance.now(),sleep=(ms,signal)=>delay(ms,undefined,{signal})}={}){
  let lastStart=null;
  return async signal=>{
    signal?.throwIfAborted();
    if(lastStart!==null){const remaining=Math.max(0,intervalMs-(now()-lastStart));if(remaining>0)await sleep(remaining,signal);}
    signal?.throwIfAborted();lastStart=now();
  };
}
