import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelTaskQueue} from '../local/model-task-queue.mjs';
const turn=()=>new Promise(r=>setImmediate(r));
async function until(check){for(let i=0;i<80;i++){if(check())return;await turn();}assert.ok(check());}

test('固定优先级，不因等待时长提权；同优先级按入队顺序',async()=>{
 let now=0;const q=new ModelTaskQueue({capacity:()=>1,now:()=>now}),order=[];
 const add=(id,kind)=>q.submit({id,kind,run:()=>{order.push(id);}});
 const all=[add('research','research')];q.sources.get('research').since=0;now=86400000;
 all.push(add('matching','matching'),add('greeting','greeting'),add('first','chat_greeting'),add('manual1','manual_greeting'),add('manual2','resume_insight'),add('reply','hr_reply'));
 await Promise.all(all);await q.close();assert.deepEqual(order,['reply','manual1','manual2','first','greeting','matching','research']);
});
test('不抢占在途；释放一个立即按优先级补位；动态调低不强杀',async()=>{
 let limit=2;const q=new ModelTaskQueue({capacity:()=>limit}),started=[],release={};
 const add=(id,kind)=>q.submit({id,kind,run:()=>new Promise(r=>{started.push(id);release[id]=r;})});
 const a=add('slow','research'),b=add('fast','research');await until(()=>started.length===2);
 const low=add('low','research'),high=add('high','hr_reply');await turn();assert.equal(started.length,2);
 release.fast();await until(()=>started.includes('high'));assert.equal(q.active,2);assert.ok(!started.includes('low'));
 limit=1;q.wake();release.high();await high;await turn();assert.equal(q.active,1);assert.ok(!started.includes('low'));
 release.slow();await until(()=>started.includes('low'));release.low();await Promise.all([a,b,low]);await q.close();
});
test('有沟通任务才预留一路，后台不能占用，单并发不死锁',async()=>{
 let watching=true,limit=3;const q=new ModelTaskQueue({capacity:()=>limit,reserveCommunication:()=>watching}),release={},started=[];
 const add=(id,kind)=>q.submit({id,kind,run:()=>new Promise(r=>{started.push(id);release[id]=r;})});
 const a=add('a','research'),b=add('b','research'),c=add('c','research');await until(()=>started.length===2);assert.equal(q.status().reservedCommunication,1);
 const reply=add('reply','hr_reply');await until(()=>started.includes('reply'));assert.equal(q.active,3);release.reply();await reply;await turn();assert.ok(!started.includes('c'));
 watching=false;q.wake();await until(()=>started.includes('c'));for(const id of ['a','b','c'])release[id]();await Promise.all([a,b,c]);await turn();
 limit=1;watching=true;const one=add('one','matching');await until(()=>started.includes('one'));release.one();await one;await q.close();
});
test('暂停取消待发而不打断在途；异常释放名额，过期操作不执行',async()=>{
 const q=new ModelTaskQueue({capacity:()=>1});let release,called=0;
 const running=q.submit({id:'running',kind:'matching',run:()=>new Promise(r=>{release=r;})});await until(()=>!!release);
 const queued=q.submit({id:'queued',kind:'hr_reply',run:()=>{called++;}});const cancelled=assert.rejects(queued,/model_queue_stopped/);
 q.stop();await cancelled;assert.equal(q.active,1);release();await running;await q.close();assert.equal(called,0);
 const next=new ModelTaskQueue({capacity:()=>1});
 const bad=next.submit({id:'bad',kind:'resume_insight',run:()=>{throw Error('synthetic_failure');}});
 const obsolete=next.submit({id:'obsolete',kind:'manual_greeting',valid:()=>false,run:()=>{called++;}});
 const good=next.submit({id:'good',kind:'research',run:()=>{called++;}});
 await Promise.all([assert.rejects(bad,/synthetic_failure/),assert.rejects(obsolete,/model_task_obsolete/),good]);await next.close();assert.equal(called,1);
});
