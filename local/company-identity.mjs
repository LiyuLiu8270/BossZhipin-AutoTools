import {Cdp} from './boss-cdp.mjs';

export function companyPageURL(value){
 if(typeof value!=='string'||!value.trim())return null;
 try{const u=new URL(value);return u.origin==='https://www.zhipin.com'&&!u.username&&!u.password&&/^\/gongsi\/[\w~.-]+\.html$/.test(u.pathname)?u.origin+u.pathname:null;}catch{return null;}
}
export function companyPageFor(job){return companyPageURL(job?.company_identity?.company_url)||companyPageURL(job?.company_url)||companyPageURL(job?.scraper_source?.list?.company_link);}
export function parseCompanyIdentity(text,{url,expectedURL,displayName,now=Date.now()}={}){
 const base={display_name:displayName,source_url:expectedURL,source_kind:'company_page',observed_at:new Date(now).toISOString(),state:'unavailable'};
 if(companyPageURL(url)!==expectedURL)return {...base,state:'page_changed'};
 if(/请完成安全验证|请完成验证|访问过于频繁|异常访问|安全验证/.test(text))return {...base,state:'verification_required'};
 const at=text.indexOf('工商信息');
 if(at<0)return {...base,state:/登录后查看|扫码登录|账号密码登录/.test(text)?'login_required':'not_displayed'};
 const section=text.slice(at).split(/\n(?:公司地址|在招职位|推荐公司|高管介绍)/)[0];
 const names=[...section.matchAll(/企业名称[：:]\s*([^\n]+)/g)].map(m=>m[1].trim());
 const codes=[...section.matchAll(/统一社会信用代码[：:]\s*([^\n]+)/g)].map(m=>m[1].trim());
 const fullName=names[0],creditCode=codes[0]||'';
 if(names.length!==1||!fullName||fullName.length>160||!/(有限责任公司|股份有限公司|有限公司|合伙企业[（(].+[）)]|个人独资企业)$/.test(fullName)||codes.length>1||creditCode&&!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(creditCode))return {...base,state:'conflict'};
 const address=/注册地址[：:]\s*([^\n]+)/.exec(section)?.[1]?.trim()||'';
 return {...base,state:'platform_verified',full_name:fullName,credit_code:creditCode,registered_address:address,quote:`企业名称：${fullName}${creditCode?'\n统一社会信用代码：'+creditCode:''}`,scope:'招聘平台公司主页展示的工商主体，不等于劳动合同签约主体'};
}

// One owned page at a time; no cookie access, platform API replay, focus spoofing or challenge retries.
export class CompanyIdentity {
 constructor(db,{readPage,now=Date.now,isBusy=()=>false}={}){
  Object.assign(this,{db,now,isBusy});this.readPage=readPage||this.readBrowserPage.bind(this);this.tail=Promise.resolve();this.blockedUntil=0;
  db.exec('CREATE TABLE IF NOT EXISTS company_identity(source_url TEXT PRIMARY KEY, updated INTEGER NOT NULL, body TEXT NOT NULL)');
 }
 get(job){const url=companyPageFor(job);if(!url)return null;const r=this.db.prepare('SELECT body FROM company_identity WHERE source_url=?').get(url);return r?JSON.parse(r.body):null;}
 resolve(job){
  if(['headhunter','agency','conflicting'].includes(job?.hiring_party?.type))return Promise.resolve({state:'agency_unknown'});
  const captured=job?.company_identity;
  if(captured?.source_kind==='job_detail'&&captured.source_url===job.url&&this.now()>=Date.parse(captured.observed_at)&&this.now()-Date.parse(captured.observed_at)<30*86400000){
   if(captured.state==='conflict')return Promise.resolve(captured);
   if(captured.state==='platform_verified'&&/(有限责任公司|股份有限公司|有限公司|合伙企业[（(].+[）)]|个人独资企业)$/.test(captured.full_name||'')&&captured.quote?.includes(captured.full_name)){
    const cached=this.get(job);
    return Promise.resolve(cached?.state==='platform_verified'&&cached.full_name!==captured.full_name?{...captured,state:'conflict',previous_full_name:cached.full_name}:captured);
   }
  }
  const url=companyPageFor(job);if(!url)return Promise.resolve({state:'no_company_link',display_name:job?.company||'',observed_at:new Date(this.now()).toISOString()});
  const work=this.tail.then(async()=>{
   const cached=this.get(job),ttl=cached?.state==='platform_verified'?30*86400000:86400000;
   if(cached&&this.now()-Date.parse(cached.observed_at)<ttl)return cached;
   if(this.isBusy())throw Error('identity_browser_busy');
   if(this.now()<this.blockedUntil)throw Error('identity_browser_paused');
   let page;try{page=await this.readPage(url);}catch{this.blockedUntil=this.now()+300000;throw Error('identity_browser_unavailable');}
   const identity=parseCompanyIdentity(page.text,{url:page.url,expectedURL:url,displayName:job.company,now:this.now()});
   if(['page_changed','verification_required','login_required'].includes(identity.state)){this.blockedUntil=this.now()+300000;throw Error('identity_'+identity.state);}
   this.db.prepare('INSERT INTO company_identity VALUES(?,?,?) ON CONFLICT(source_url) DO UPDATE SET updated=excluded.updated,body=excluded.body').run(url,this.now(),JSON.stringify(identity));return identity;
  });this.tail=work.catch(()=>{});return work;
 }
 async readBrowserPage(url){
  const cdp=await Cdp.connect();let target;
  try{
   target=(await cdp.send('Target.createTarget',{url,background:true})).targetId;
   const session=(await cdp.send('Target.attachToTarget',{targetId:target,flatten:true})).sessionId;
   let last='',stable=0;
   for(let i=0;i<15;i++){
    await new Promise(r=>setTimeout(r,800));
    const p=(await cdp.send('Runtime.evaluate',{expression:'({url:location.origin+location.pathname,text:document.body?.innerText||""})',returnByValue:true},session)).result?.value;
    if(!p)continue;
    if(/请完成安全验证|请完成验证|访问过于频繁|扫码登录|账号密码登录/.test(p.text))return p;
    if(p.text.includes('工商信息')&&/企业名称[：:]/.test(p.text))return p;
    stable=p.text===last?stable+1:0;last=p.text;
    if(p.url===url&&p.text.length>800&&stable>=3)return p;
    if(p.url!=='about:blank'&&p.url!==url&&i>=3)return p;
   }
   throw Error('identity_page_timeout');
  }finally{if(target)await cdp.send('Target.closeTarget',{targetId:target}).catch(()=>{});cdp.close();}
 }
}
