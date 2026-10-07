import {setTimeout as delay} from 'node:timers/promises';
import {Cdp} from './boss-cdp.mjs';
import {jobIdentity} from '../shared/core.js';
import {jobOpenInput} from './job-opener.mjs';

const CHAT='https://www.zhipin.com/web/geek/chat';
// Read only the selected conversation, not the inbox. Vue is used only to read
// stable identity and known platform-card type fields; all writes use normal enabled DOM controls.
export function chatSnapshot(jobId,expected){
  if(/captcha|security|verify/.test(location.pathname))return {error:'verification_required'};
  if(/login|\/web\/user/.test(location.pathname))return {error:'login_required'};
  if(location.origin+location.pathname!=='https://www.zhipin.com/web/geek/chat')return {error:'page_left'};
  const r=document.querySelector('.chat-conversation'),v=r?.__vue__,f=v?.selectedFriend$;
  const id=x=>typeof x==='string'&&x?x:typeof x==='number'&&Number.isSafeInteger(x)&&x>0?String(x):null;
  const identity={account:id(v?.$store?.getters?.userId),peer:id(f?.uid),recruiter:f?.encryptBossId,job:f?.encryptJobId};
  if(!identity.account||!identity.peer||!identity.recruiter||identity.job!==jobId||identity.peer===identity.account)return {error:'identity_unverified'};
  if(expected&&['account','peer','recruiter','job'].some(k=>identity[k]!==expected[k]))return {error:'identity_changed'};
  const head=r.querySelector('.top-info-content')?.innerText.split('\n').map(s=>s.trim())||[];
  if(!f.name||!head.includes(f.name)||r.querySelector('.position-name')?.textContent.trim()!==f.jobName)return {error:'identity_unverified'};
  const messages=[];
  for(const e of r.querySelectorAll('.chat-message .message-item')){
    let direction=e.classList.contains('item-myself')?'out':e.classList.contains('item-friend')?'in':'system';
    const text=e.querySelector('.text-content')?.textContent;
    const mid=e.getAttribute('data-mid');
    if(!mid||!/^\d+$/.test(mid)){if(direction!=='system')return {error:'message_identity_unverified'};continue;}
    // Verified on the live platform: competition marketing cards use item-friend
    // and even the recruiter's fromId. Neither field proves an HR-authored reply.
    // Require this specific card's typed metadata AND rendered structure/title;
    // never suppress arbitrary images, attachments or other article cards.
    const card=e.querySelector('.articles-center'),meta=card?.__vue__?.$props?.message;
    if(direction==='in'&&text===undefined&&meta&&String(meta.mid)===mid&&meta.bizType===317&&meta.bodyType===16&&meta.messageType==='articles'&&
       card.querySelector('.message-card-top-title')?.textContent.trim()==='你与该职位竞争者PK情况'){
      messages.push({id:mid,direction:'system',kind:'nontext',text:'[BOSS 平台提示] 你与该职位竞争者PK情况',source:'platform_competition_card',delivered:false});continue;
    }
    messages.push({id:mid,direction,kind:typeof text==='string'?'text':'nontext',text:typeof text==='string'?text:'[非文本消息，请在 BOSS 查看]',delivered:/送达|已读/.test(e.innerText)});
  }
  if(!messages.length)return {error:'history_loading'};
  return {identity,messages,visibility:document.visibilityState,recruiter:f.name,company:f.brandName,title:f.jobName};
}

export class BossChatPort {
  constructor(job,{endpoint='http://127.0.0.1:19222'}={}){this.job=job;this.endpoint=endpoint;this.jobId=jobIdentity(job.url)?.id?.replace(/^boss:/,'');if(!this.jobId||jobIdentity(job.url).id!==job.id)throw Error('invalid_job_link');}
  async eval(fn,...args){
    const r=await this.cdp.send('Runtime.evaluate',{expression:`(()=>{const chatSnapshot=${chatSnapshot.toString()};return (${fn.toString()})(...${JSON.stringify(args)});})()`,returnByValue:true,awaitPromise:false},this.session);
    if(r.exceptionDetails)throw Error('page_evaluation_failed');return r.result?.value;
  }
  async wait(fn,{timeout=18000}={}){
    const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(250);}throw Error('page_ready_timeout');
  }
  async create(url){
    this.cdp=await Cdp.connect(this.endpoint);
    ({targetId:this.target}=await this.cdp.send('Target.createTarget',{url,background:true,newWindow:true}));
    const {windowId}=await this.cdp.send('Browser.getWindowForTarget',{targetId:this.target});
    ({sessionId:this.session}=await this.cdp.send('Target.attachToTarget',{targetId:this.target,flatten:true}));
    await this.cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
  }
  async read(expected=this.identity){
    const s=await this.eval(chatSnapshot,this.jobId,expected);if(s?.error)throw Error(s.error);if(!s?.identity)throw Error('identity_unverified');return s;
  }
  async open(identity,{beforeGreet=()=>{throw Error('greet_not_authorized');},assertCurrent=()=>{}}={}){
    if(identity){
      await this.create(CHAT);
      return {...await this.select(identity),newContact:false};
    }
    return this.openFromJob({beforeGreet,assertCurrent});
  }
  async select(identity){
      await this.wait(()=>this.eval(()=>Boolean(document.querySelector('.boss-search-input'))));
      const query=this.job.company||this.job.title;
      await this.eval(q=>{const e=document.querySelector('.boss-search-input');e.value=q;e.dispatchEvent(new Event('input',{bubbles:true}));},query);
      // A candidate is selected by exact visible title/company; stable IDs are
      // checked before ANY message data is accepted or text is submitted.
      await this.wait(()=>this.eval((title,company)=>{
        const rows=[...document.querySelectorAll('.boss-search-result li')].filter(e=>{const lines=e.innerText.split('\n').map(s=>s.trim());return lines.some(s=>s.replace(/^职位[:：]\s*/,'')===title)&&(!company||lines.includes(company));});
        if(rows.length!==1)return false;rows[0].click();return true;
      },this.job.title,this.job.company));
      let previous;
      const s=await this.wait(async()=>{try{const snapshot=await this.read(identity),digest=JSON.stringify(snapshot.messages);const stable=digest===previous;previous=digest;return stable?snapshot:false;}catch(e){if(['identity_unverified','history_loading'].includes(e.message))return false;throw e;}});
      this.identity=s.identity;return s;
  }
  async openFromJob({beforeGreet,assertCurrent}){
    const input=jobOpenInput(this.job),u=new URL(input.job_link);if(input.security_id)u.searchParams.set('securityId',input.security_id);if(input.lid)u.searchParams.set('lid',input.lid);
    await this.create(u.href);
    const inspect=()=>this.eval(id=>{
      if(/captcha|security|verify/.test(location.pathname))return {error:'verification_required'};
      if(/login|\/web\/user/.test(location.pathname))return {error:'login_required'};
      if(location.pathname!==`/job_detail/${id}.html`)return false;
      const buttons=[...document.querySelectorAll('.job-op .btn-startchat')].filter(e=>/^(立即沟通|继续沟通)$/.test(e.textContent.trim()));
      if(buttons.length!==1)return false;return {kind:buttons[0].textContent.trim()==='立即沟通'?'greet':'continue'};
    },this.jobId);
    const state=await this.wait(inspect);if(state.error)throw Error(state.error);
    assertCurrent();if(state.kind==='greet')beforeGreet();assertCurrent();
    const clicked=await this.eval((id,kind)=>{
      if(location.pathname!==`/job_detail/${id}.html`)return false;
      const text=kind==='greet'?'立即沟通':'继续沟通',a=[...document.querySelectorAll('.job-op .btn-startchat')].filter(e=>e.textContent.trim()===text);
      if(a.length!==1||a[0].disabled||a[0].classList.contains('disabled'))return false;a[0].click();return true;
    },this.jobId,state.kind);
    if(!clicked)throw Error('greet_not_confirmed');
    // The button can leave the detail page open. Reconcile through the standard
    // message page and exact job/peer identity, not a guessed private chat URL.
    await delay(3000);assertCurrent();
    await this.cdp.send('Page.navigate',{url:CHAT},this.session);
    const s=await this.select(null);
    if(this.job.recruiter_id&&s.identity.recruiter!==this.job.recruiter_id)throw Error('identity_changed');
    if(state.kind==='greet'&&!s.messages.some(m=>m.direction==='out'&&m.delivered))throw Error('greet_not_confirmed');
    this.identity=s.identity;return {...s,newContact:state.kind==='greet'};
  }
  async send(text,{assertCurrent,beforeSubmit}){
    const before=await this.read();assertCurrent();
    if(before.messages.some(m=>m.direction==='out'&&m.text===text))throw Error('same_text_already_present');
    const typed=await this.eval((job,identity,text)=>{
      const s=chatSnapshot(job,identity);if(s.error)return false;
      const e=document.querySelector('.chat-conversation #chat-input');if(!e||e.innerText.trim())return false;
      e.textContent=text;e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));return true;
    },this.jobId,this.identity,text);
    if(!typed)throw Error('existing_draft_or_identity');
    await this.wait(()=>this.eval(()=>{const b=document.querySelector('.chat-conversation button.btn-send');return b&&!b.disabled&&!b.classList.contains('disabled');}),{timeout:6000});
    const fresh=await this.read();
    if(JSON.stringify(fresh.messages.map(m=>[m.id,m.text]))!==JSON.stringify(before.messages.map(m=>[m.id,m.text])))throw Error('messages_changed');
    assertCurrent();beforeSubmit(before);assertCurrent();
    const submitted=await this.eval((job,identity,text)=>{
      const s=chatSnapshot(job,identity);if(s.error)return false;
      const r=document.querySelector('.chat-conversation'),e=r.querySelector('#chat-input'),b=r.querySelector('button.btn-send');
      if(!e||e.innerText!==text||!b||b.disabled||b.classList.contains('disabled'))return false;b.click();return true;
    },this.jobId,this.identity,text);
    if(!submitted)throw Error('send_not_confirmed');
    const prior=new Set(before.messages.map(m=>m.id));
    return this.wait(async()=>{const after=await this.read();const receipt=after.messages.find(m=>m.direction==='out'&&m.text===text&&!prior.has(m.id)&&m.delivered);return receipt?{snapshot:after,messageId:receipt.id}:false;},{timeout:15000});
  }
  async close(){try{if(this.target&&this.cdp&&!this.cdp.closed){
    const all=(await this.cdp.send('Target.getTargets')).targetInfos;
    for(const t of all.filter(t=>t.openerId===this.target&&t.type==='page'))await this.cdp.send('Target.closeTarget',{targetId:t.targetId});
    await this.cdp.send('Target.closeTarget',{targetId:this.target});
  }}finally{this.cdp?.close();this.target=null;}}
}
