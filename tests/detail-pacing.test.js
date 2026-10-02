import test from 'node:test';
import assert from 'node:assert/strict';
import {createDetailPacer} from '../local/detail-pacing.mjs';
test('慢页面不叠加等待，快页面仅补足开始间隔，首条立即执行',async()=>{
 let now=0;const sleeps=[];
 const pace=createDetailPacer(5000,{now:()=>now,sleep:async ms=>{sleeps.push(ms);now+=ms;}});
 await pace();assert.deepEqual(sleeps,[]);
 now+=12000;await pace();assert.deepEqual(sleeps,[]);
 now+=3000;await pace();assert.deepEqual(sleeps,[2000]);assert.equal(now,17000);
 now+=7000;await pace();assert.deepEqual(sleeps,[2000]);
});
test('等待期间取消不启动下一条；已取消不进入等待',async()=>{
 const c=new AbortController();let waits=0;
 const pace=createDetailPacer(5000,{now:()=>0,sleep:async(ms,signal)=>{waits++;c.abort();signal.throwIfAborted();}});
 await pace(c.signal);await assert.rejects(pace(c.signal),{name:'AbortError'});assert.equal(waits,1);
 await assert.rejects(pace(c.signal),{name:'AbortError'});assert.equal(waits,1);
});
