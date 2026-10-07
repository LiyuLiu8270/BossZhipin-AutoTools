import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {BossChatPort} from './boss-chat-port.mjs';
import {runChatModel,validateChatReply,needsHuman} from './chat-model.mjs';
import {analysisInput} from './intake.mjs';
import {trackReadTables} from './read-cache.mjs';

const keyOf=(dataset,id)=>JSON.stringify([dataset,id]);
const fingerprint=m=>createHash('sha256').update(JSON.stringify([m.direction,m.kind,m.text])).digest('hex');
const active=s=>['queued','watching'].includes(s);
export const CHAT_ERRORS={identity_unverified:'尚未核实会话身份',identity_changed:'会话或登录账号发生变化',message_identity_unverified:'消息标识不完整',message_conflict:'消息内容发生变化，需人工核对',history_gap:'历史出现缺口，请在 BOSS 核对',verification_required:'BOSS 要求人工验证',login_required:'BOSS 登录已失效',page_left:'消息页已跳离',page_ready_timeout:'页面未及时就绪',browser_unavailable:'专用浏览器不可用',transport_unavailable:'浏览器连接暂不可用',send_unknown:'发送结果不明，禁止自动重发',profile_changed:'简历或规则变更，请重新确认托管',manual_activity:'检测到人工发言，已停止自动回复',human_required:'收到需要本人决定或非文本的消息',hr_reply:'HR 已回复，请接管',daily_limit:'今日模型额度已用完',model_failed:'模型生成或事实核查未通过',duplicate_peer:'同一招聘者已有其他沟通任务',already_contacted:'已记录沟通，不再重复打招呼',stopped:'已人工暂停',round_limit:'自动回复轮次达到本轮保护上限',existing_draft_or_identity:'已有草稿或会话发生变化',messages_changed:'生成期间消息有变化，已暂停待核对',reply_invalid:'回复未通过检查',job_closed:'岗位已关闭或链接不可用'};
Object.assign(CHAT_ERRORS,{greeting_handoff:'AI 生成首条招呼时建议本人处理（不代表收到新消息）',reply_handoff:'AI 生成回复时建议本人接管'});

export class Communications {
 constructor(controller,{dataDir,portFactory=job=>new BossChatPort(job),model=runChatModel,now=()=>Date.now()}={}){
  Object.assign(this,{controller,db:controller.db,dataDir,portFactory,model,now,busy:false,modelActive:0,closed:false});
  this.db.exec(`CREATE TABLE IF NOT EXISTS comm_threads (key TEXT PRIMARY KEY,dataset TEXT NOT NULL,job_id TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,next_at INTEGER NOT NULL,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS comm_messages(thread_key TEXT NOT NULL,mid TEXT NOT NULL,direction TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,hash TEXT NOT NULL,observed TEXT NOT NULL,PRIMARY KEY(thread_key,mid));
   CREATE TABLE IF NOT EXISTS comm_events(id TEXT PRIMARY KEY,thread_key TEXT NOT NULL,code TEXT NOT NULL,at TEXT NOT NULL,seen INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS comm_event_context(event_id TEXT PRIMARY KEY,notice_key TEXT,body TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS comm_message_corrections(thread_key TEXT NOT NULL,mid TEXT NOT NULL,at TEXT NOT NULL,reason TEXT NOT NULL,original TEXT NOT NULL,PRIMARY KEY(thread_key,mid));
   CREATE INDEX IF NOT EXISTS comm_due ON comm_threads(status,next_at);`);
  trackReadTables(this.db,['comm_threads','comm_messages','comm_events','comm_event_context']);
  // Crash recovery is conservative: a persisted dispatch never becomes retry.
  for(const row of this.all())if(row.pending){row.status='unknown';row.error='send_unknown';this.save(row);this.event(row,'send_unknown');}
 }
 all(){return this.db.prepare('SELECT body FROM comm_threads').all().map(r=>JSON.parse(r.body));}
 hasActiveTasks(){return !!this.db.prepare("SELECT 1 FROM comm_threads WHERE mode!='manual' AND status IN ('queued','watching') LIMIT 1").get();}
 get(key){const r=this.db.prepare('SELECT body FROM comm_threads WHERE key=?').get(key);return r?JSON.parse(r.body):null;}
 save(t){t.updated=new Date(this.now()).toISOString();this.db.prepare('INSERT INTO comm_threads VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET mode=excluded.mode,status=excluded.status,next_at=excluded.next_at,body=excluded.body').run(t.key,t.dataset,t.job_id,t.mode,t.status,t.nextAt||0,JSON.stringify(t));}
 event(t,code,context=null){
  if(this.db.prepare('SELECT 1 FROM comm_events WHERE thread_key=? AND code=? AND seen=0').get(t.key,code))return;
  if(context?.noticeKey&&this.db.prepare('SELECT 1 FROM comm_event_context c JOIN comm_events e ON e.id=c.event_id WHERE e.thread_key=? AND c.notice_key=?').get(t.key,context.noticeKey))return;
  const eventId=randomUUID();this.db.exec('SAVEPOINT comm_event');try{
   this.db.prepare('INSERT INTO comm_events VALUES(?,?,?,?,0)').run(eventId,t.key,code,new Date(this.now()).toISOString());
   if(context)this.db.prepare('INSERT INTO comm_event_context VALUES(?,?,?)').run(eventId,context.noticeKey||null,JSON.stringify(context));
   this.db.exec('RELEASE comm_event');
  }catch(e){this.db.exec('ROLLBACK TO comm_event');this.db.exec('RELEASE comm_event');throw e;}
 }
 messages(key){return this.db.prepare('SELECT mid AS id,direction,kind,text,observed FROM comm_messages WHERE thread_key=? ORDER BY rowid').all(key);}
 detail(dataset,id){
  const t=this.get(keyOf(dataset,id));if(!t)return {mode:'manual',status:'idle',messages:[],events:[]};
  return {...this.summary(t),messages:this.messages(t.key),pending:t.pending?{kind:t.pending.kind,text:t.pending.text||'',state:'unknown'}:null,events:this.db.prepare('SELECT e.id,e.code,e.at,e.seen,c.body AS context FROM comm_events e LEFT JOIN comm_event_context c ON c.event_id=e.id WHERE e.thread_key=? ORDER BY e.at DESC LIMIT 30').all(t.key).map(e=>({...e,context:e.context?JSON.parse(e.context):null,message:CHAT_ERRORS[e.code]||e.code}))};
 }
 summary(t){return {mode:t.mode,status:t.status,error:t.error||null,error_text:CHAT_ERRORS[t.error]||t.error&&'沟通暂停，请检查平台状态'||'',handoff_reason:t.status==='paused'?t.handoff?.reason||null:null,phase:t.phase||null,updated:t.updated,unread:this.db.prepare('SELECT count(*) AS n FROM comm_events WHERE thread_key=? AND seen=0').get(t.key).n};}
 summaries(){return Object.fromEntries(this.all().map(t=>[t.key,this.summary(t)]));}
 notifications(){return this.db.prepare(`SELECT e.id,e.code,e.at,t.dataset,t.job_id FROM comm_events e JOIN comm_threads t ON t.key=e.thread_key WHERE e.seen=0 ORDER BY e.at DESC LIMIT 30`).all().map(e=>({...e,message:CHAT_ERRORS[e.code]||'沟通需要检查',title:this.controller.store.get(e.dataset,e.job_id)?.title||'岗位'}));}
 action({dataset,id,mode}){
  const job=this.controller.store.get(dataset,id);if(!job)throw Error('job_not_found');
  if(!['managed','greet_only','manual'].includes(mode))throw Error('invalid_communication');
  const key=keyOf(dataset,id),old=this.get(key);
  if(mode!=='manual'){
   if(this.controller.worker.profile.mode!=='resume_fulltext')throw Error('resume_required');
   if(job.link_access?.state==='unavailable'||job.recruitment_signals?.availability?.value==='explicit_unavailable')throw Error('job_closed');
   if(old?.pending||old?.status==='unknown')throw Error('send_unknown');
   if(this.all().some(t=>t.key!==key&&t.mode!=='manual'&&(t.job_id===id||job.recruiter_id&&this.controller.store.get(t.dataset,t.job_id)?.recruiter_id===job.recruiter_id)))throw Error('duplicate_peer');
  }
  if(old&&old.mode===mode&&active(old.status))return this.detail(dataset,id);
  const t={...(old||{key,dataset,job_id:id,baseline:false,identity:null,initial:'pending',rounds:0}),mode,status:mode==='manual'?'paused':'queued',revision:(old?.revision||0)+1,profile:this.controller.worker.profileHash,nextAt:0,error:mode==='manual'?'stopped':null};
  if(old?.error==='round_limit'&&mode!=='manual')t.rounds=0;
  if(mode==='manual')t.awaiting=[];
  if(old?.pending)t.status='unknown';this.save(t);this.controller.modelQueue?.wake();return this.detail(dataset,id);
 }
 acknowledge({dataset,id}){this.db.prepare('UPDATE comm_events SET seen=1 WHERE thread_key=?').run(keyOf(dataset,id));return {ok:true};}
 async reconcile({dataset,id}){
  if(this.busy)throw Error('communication_busy');const t=this.get(keyOf(dataset,id));
  if(!t?.pending||t.pending.kind!=='text'||!t.identity)throw Error('send_unknown');
  this.busy=true;const port=this.portFactory(this.controller.store.get(dataset,id));
  this.running=(async()=>{try{
   const snapshot=await port.open(t.identity),p=t.pending;
   const matches=snapshot.messages.filter(m=>m.direction==='out'&&m.text===p.text&&m.delivered&&!p.beforeIds.includes(m.id));
   if(matches.length!==1)return {confirmed:false};
   if(this.get(t.key).revision!==t.revision)throw Error('stopped');
   this.capture(t,snapshot,{ownIds:[matches[0].id]});t.pending=null;t.initial='done';t.status='paused';t.mode='manual';t.error='stopped';t.revision++;this.save(t);this.contact(t);
   return {confirmed:true};
  }finally{await port.close().catch(()=>{});this.busy=false;}})();return this.running;
 }
 assertCurrent(t){const current=this.get(t.key);if(this.closed||!current||current.revision!==t.revision||current.mode==='manual')throw Error('stopped');if(t.profile!==this.controller.worker.profileHash)throw Error('profile_changed');}
 capture(t,s,{ownIds=[]}={}){
  if(!s.identity||!Array.isArray(s.messages))throw Error('identity_unverified');
  if(t.identity&&JSON.stringify(t.identity)!==JSON.stringify(s.identity))throw Error('identity_changed');
  const other=this.all().find(x=>x.key!==t.key&&x.identity?.account===s.identity.account&&x.identity?.peer===s.identity.peer&&x.mode!=='manual');if(other)throw Error('duplicate_peer');
  const prior=this.messages(t.key),map=new Map(prior.map(m=>[m.id,m])),seen=new Map(),incoming=[],outgoing=[],corrections=[];
  for(const m of s.messages){
   if(!/^\d+$/.test(m.id)||!['in','out','system'].includes(m.direction)||!['text','nontext'].includes(m.kind)||typeof m.text!=='string')throw Error('message_identity_unverified');
   const old=map.get(m.id),fp=fingerprint(m);
   const cardCorrection=old?.direction==='in'&&old.kind==='nontext'&&old.text==='[非文本消息，请在 BOSS 查看]'&&m.direction==='system'&&m.kind==='nontext'&&m.source==='platform_competition_card'&&m.text==='[BOSS 平台提示] 你与该职位竞争者PK情况';
   if(seen.has(m.id)&&seen.get(m.id)!==fp||old&&fingerprint(old)!==fp&&!cardCorrection)throw Error('message_conflict');seen.set(m.id,fp);
   if(cardCorrection)corrections.push({old,message:m});
   if(t.baseline&&!map.has(m.id)&&!ownIds.includes(m.id)){if(m.direction==='in')incoming.push(m);else if(m.direction==='out')outgoing.push(m);}
  }
  if(t.baseline&&prior.length&&s.messages.length&&!s.messages.some(m=>map.has(m.id)))throw Error('history_gap');
  this.db.exec('BEGIN IMMEDIATE');try{
   for(const {old,message:m} of corrections){
    this.db.prepare('INSERT OR IGNORE INTO comm_message_corrections VALUES(?,?,?,?,?)').run(t.key,m.id,new Date(this.now()).toISOString(),'live_verified_platform_competition_card',JSON.stringify(old));
    this.db.prepare('UPDATE comm_messages SET direction=?,kind=?,text=?,hash=? WHERE thread_key=? AND mid=?').run(m.direction,m.kind,m.text,fingerprint(m),t.key,m.id);
   }
   const insert=this.db.prepare('INSERT OR IGNORE INTO comm_messages VALUES(?,?,?,?,?,?,?)');
   for(const m of s.messages)insert.run(t.key,m.id,m.direction,m.kind,m.text,fingerprint(m),new Date(this.now()).toISOString());
   t.identity=s.identity;t.baseline=true;t.lastRead=new Date(this.now()).toISOString();this.save(t);this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  return {incoming,outgoing};
 }
 pause(t,code,context=null){const current=this.get(t.key);if(current?.revision!==t.revision)return;t.status=t.pending?'unknown':'paused';t.error=t.pending?'send_unknown':code;t.handoff=context?.origin==='model'?context:null;if(code==='manual_activity')t.awaiting=[];this.save(t);this.event(t,t.error,context);}
 contact(t,replied=false){
  const at=new Date(this.now()).toISOString();this.db.prepare('INSERT INTO manual_contact VALUES(?,?,?,?) ON CONFLICT(dataset,id) DO UPDATE SET status=excluded.status,updated=excluded.updated').run(t.dataset,t.job_id,'contacted',at);
  // Never demote an existing human reply/closed record when only confirming send.
  this.db.prepare(`INSERT INTO ui_replies VALUES(?,?,?,?) ON CONFLICT(dataset,id) DO UPDATE SET status=CASE WHEN excluded.status='replied' OR ui_replies.status='unknown' THEN excluded.status ELSE ui_replies.status END,updated=excluded.updated`).run(t.dataset,t.job_id,replied?'replied':'waiting',at);
 }
 inboundNotice(t,messages){
  if(messages.some(m=>m.kind==='text')){this.contact(t,true);this.event(t,'hr_reply');}
  if(messages.some(m=>m.kind!=='text'))this.event(t,'human_required');
 }
 async generate(t,job,greeting){
  if(this.controller.modelQueue){
   t.phase='waiting_model';this.save(t);
   return this.controller.modelQueue.submit({id:'communication:'+t.key+':'+t.revision,kind:greeting?'chat_greeting':'hr_reply',
    valid:()=>!this.closed,run:()=>{this.assertCurrent(t);return this.generateWithPermit(t,job,greeting);}});
  }
  if((this.controller.scheduler?.active||0)+this.modelActive+(this.controller.companyResearch?.modelActive||0)>=this.controller.settings.modelConcurrency)throw Error('model_capacity');
  return this.generateWithPermit(t,job,greeting);
 }
 async generateWithPermit(t,job,greeting){
  const worker=this.controller.worker;
  if(!worker.budgetAvailable())throw Error('daily_limit');
  this.modelActive=1;
  try{
   const reserved=this.db.prepare('INSERT INTO match_budget VALUES(?,1) ON CONFLICT(day) DO UPDATE SET jobs=jobs+1 WHERE jobs<?').run(worker.day(this.now()),worker.dailyLimit).changes;
   if(!reserved)throw Error('daily_limit');
   const profile=structuredClone(worker.profile),result=await this.model(profile,analysisInput(job),this.messages(t.key).slice(-50),{greeting,style:worker.policy.greetingStyle,cwd:join(this.dataDir,'communication-model')});
   this.assertCurrent(t);return validateChatReply(result,profile);
  }finally{this.modelActive=0;this.controller.scheduler?.wake();this.controller.companyResearch?.wake();}
 }
 async process(t){
  const job=this.controller.store.get(t.dataset,t.job_id);if(!job)throw Error('job_not_found');
  if(job.link_access?.state==='unavailable'||job.recruitment_signals?.availability?.value==='explicit_unavailable')throw Error('job_closed');
  this.assertCurrent(t);
  const port=this.portFactory(job);
  try{
   t.phase='opening_conversation';this.save(t);
   const s=await port.open(t.identity,{assertCurrent:()=>this.assertCurrent(t),beforeGreet:()=>{
    this.assertCurrent(t);
    if(t.initial!=='pending'||this.controller.detail(t.dataset,t.job_id).contact_status==='contacted')throw Error('already_contacted');
    if(!this.controller.worker.budgetAvailable())throw Error('daily_limit');
    t.pending={kind:'platform',at:new Date(this.now()).toISOString()};this.save(t);
   }});
   this.assertCurrent(t);
   const {incoming,outgoing}=this.capture(t,s);
   if(t.pending?.kind==='platform'){
    if(!s.newContact)throw Error('send_unknown');t.pending=null;t.initial='need_greeting';this.save(t);this.contact(t);
    // An immediate genuine text reply may already be present on first read.
    const immediate=s.messages.filter(m=>m.direction==='in'&&m.kind==='text');
    if(immediate.length){t.initial='done';t.awaiting=immediate.map(m=>m.id);this.save(t);this.contact(t,true);this.event(t,'hr_reply');}
   }
   else if(t.initial==='pending'){t.initial='done';this.save(t);if(s.messages.some(m=>m.direction==='out'))this.contact(t);}
   if(outgoing.length){this.pause(t,'manual_activity');return;}
   if(incoming.length){this.inboundNotice(t,incoming);t.awaiting=incoming.map(m=>m.id);this.save(t);}
   const pendingInbound=this.messages(t.key).filter(m=>(t.awaiting||[]).includes(m.id));
   if(pendingInbound.length&&(t.mode==='greet_only'||needsHuman(pendingInbound))){this.pause(t,t.mode==='greet_only'&&pendingInbound.some(m=>m.kind==='text')?'hr_reply':'human_required');return;}
   const greeting=t.initial==='need_greeting';
   if(greeting||t.mode==='managed'&&pendingInbound.length){
    if(t.rounds>=20){this.pause(t,'round_limit');return;}
    t.phase=greeting?'generating_greeting':'generating_reply';this.save(t);
    let reply;try{reply=await this.generate(t,job,greeting);}catch(e){if(e.message==='model_capacity'){t.status='watching';t.nextAt=this.now()+5000;this.save(t);return;}throw e;}
    if(reply.action==='handoff'){
     const messageIds=pendingInbound.map(m=>m.id),noticeKey=createHash('sha256').update(JSON.stringify([greeting?'greeting':'reply',messageIds,t.profile,this.controller.worker.policy.greetingStyle])).digest('hex');
     this.pause(t,greeting?'greeting_handoff':'reply_handoff',{origin:'model',reason:reply.reason||'模型未提供具体原因',messageIds,noticeKey});return;
    }
    // Re-read after the model call. A manual reply or new inbound invalidates draft.
    const fresh=await port.read();this.assertCurrent(t);const delta=this.capture(t,fresh);
    if(delta.incoming.length||delta.outgoing.length){t.awaiting=delta.incoming.map(m=>m.id);this.inboundNotice(t,delta.incoming);this.pause(t,delta.outgoing.length?'manual_activity':'messages_changed');return;}
    t.phase='preparing_send';this.save(t);
    const sent=await port.send(reply.text,{assertCurrent:()=>this.assertCurrent(t),beforeSubmit:before=>{
     this.assertCurrent(t);t.phase='submitting';t.pending={kind:'text',text:reply.text,beforeIds:before.messages.map(m=>m.id),at:new Date(this.now()).toISOString()};this.save(t);
    }});
    // Persist the receipt even if manual takeover happened during network wait,
    // but never overwrite the new user mode/revision.
    const current=this.get(t.key);const changed=current.revision!==t.revision;
    if(changed)t=current;
    const after=this.capture(t,sent.snapshot,{ownIds:[sent.messageId]});t.pending=null;t.initial='done';t.awaiting=after.incoming.map(m=>m.id);t.rounds++;this.save(t);this.contact(t);
    if(after.incoming.length)this.inboundNotice(t,after.incoming);
    if(changed)return;
    if(after.outgoing.length){this.pause(t,'manual_activity');return;}
   }
   t.status='watching';t.phase='waiting';t.error=null;t.failures=0;t.nextAt=this.now()+30000;this.save(t);
  }finally{await port.close().catch(()=>{});}
 }
 async tick(){
  if(this.busy||this.closed)return;const row=this.db.prepare("SELECT body FROM comm_threads WHERE status IN ('queued','watching') AND next_at<=? ORDER BY next_at,rowid LIMIT 1").get(this.now());if(!row)return;
  const t=JSON.parse(row.body);this.busy=true;
  this.running=(async()=>{try{await this.process(t);}catch(e){
   const latest=this.get(t.key);if(latest?.revision!==t.revision)return;
   if(this.closed&&!latest.pending){latest.status='watching';latest.nextAt=this.now()+30000;latest.error=null;this.save(latest);return;}
   const code=CHAT_ERRORS[e.message]?e.message:e.message.startsWith('cdp_')?'transport_unavailable':'model_failed';
   if(code==='transport_unavailable'&&!latest.pending&&(latest.failures||0)<2){latest.failures=(latest.failures||0)+1;latest.nextAt=this.now()+30000;this.save(latest);}else this.pause(latest,code);
  }finally{this.busy=false;}})();return this.running;
 }
 start(){this.timer=setInterval(()=>void this.tick().catch(()=>{}),1000);}
 stop(){this.closed=true;clearInterval(this.timer);}
 async close(){this.stop();await this.running;}
}
