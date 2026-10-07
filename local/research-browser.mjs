// Isolated public-web browser. Never attach to the user's browsers or BOSS CDP.
import {createServer} from 'node:http';
import {request as httpRequest} from 'node:http';
import {connect} from 'node:net';
import {lookup} from 'node:dns/promises';
import {spawn} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Cdp} from './boss-cdp.mjs';
import {publicURL,publicIPv4} from './public-source.mjs';

export function researchURL(value){
 const safe=publicURL(value);if(!safe)return null;
 const host=new URL(safe).hostname.toLowerCase().replace(/\.$/,'');
 if(['zhipin.com','localhost','local','internal','lan','home','test'].some(d=>host===d||host.endsWith('.'+d)))return null;
 return safe;
}
export function accessChallenge(page){
 const u=new URL(page.url);
 return /安全验证|人机验证|验证码|访问验证|访问受限|captcha|access denied|just a moment/i.test(page.title)||/(?:^|\.)(?:qcaptcha|captcha)\./i.test(u.hostname)||/\/(?:captcha|antispider|challenge)(?:\/|$)/i.test(u.pathname);
}
export async function publicAddress(host,{resolve=lookup}={}){
 if(!researchURL('https://'+host))throw Error('browser_address_blocked');
 let timer;const records=await Promise.race([resolve(host,{family:4,all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('browser_dns_timeout')),8000);})]).finally(()=>clearTimeout(timer));
 if(!records.length||records.some(r=>!publicIPv4(r.address)))throw Error('browser_address_blocked');
 return records[0].address;
}
// A vetted, pinned-address proxy also protects redirects, scripts, subframes and
// websocket CONNECTs. Chromium's implicit loopback bypass is explicitly removed.
export async function publicProxy(){
 const sockets=new Set(),track=s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));return s;};
 const server=createServer(async(req,res)=>{
  try{
   const safe=researchURL(req.url);if(!safe||!['GET','HEAD'].includes(req.method))throw Error('blocked');
   const u=new URL(safe);if(u.protocol!=='http:')throw Error('blocked');
   const address=await publicAddress(u.hostname),headers={...req.headers,host:u.host};delete headers['proxy-authorization'];delete headers['proxy-connection'];
   const upstream=httpRequest({host:address,port:80,path:u.pathname+u.search,method:req.method,headers,agent:false},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
   upstream.on('socket',track);upstream.setTimeout(20000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(upstream);
  }catch{res.writeHead(403);res.end('Public web only');}
 });
 server.on('connection',track);
 server.on('connect',async(req,socket,head)=>{
  try{
   const u=new URL('https://'+req.url);if(u.port&&u.port!=='443'||u.username||u.password||!researchURL(u.href))throw Error('blocked');
   const address=await publicAddress(u.hostname);if(socket.destroyed)return;
   const upstream=track(connect({host:address,port:443}));upstream.setTimeout(60000,()=>upstream.destroy());
   upstream.on('connect',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
   upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
  }catch{socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
 });
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
 return {port:server.address().port,close:()=>{for(const s of sockets)s.destroy();server.close();}};
}
export class ResearchBrowser {
 constructor(){this.closing=false;this.queue=Promise.resolve();}
 async start(){
  if(this.cdp)return;
  const executable=['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  if(!executable)throw Error('research_browser_unavailable');
  this.dir=mkdtempSync(join(tmpdir(),'xunxu-public-browser-'));this.proxy=await publicProxy();
  this.child=spawn(executable,['--headless=new','--no-first-run','--disable-sync','--disable-extensions','--disable-background-networking','--disable-component-update','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+this.dir,'--proxy-server=http://127.0.0.1:'+this.proxy.port,'--proxy-bypass-list=<-loopback>','about:blank'],{windowsHide:true,stdio:'ignore'});
  this.child.on('error',()=>{});
  const file=join(this.dir,'DevToolsActivePort');for(let i=0;i<100&&!existsSync(file);i++){if(this.child.exitCode!==null)throw Error('research_browser_start_failed');await delay(100);}
  if(!existsSync(file))throw Error('research_browser_start_failed');
  const port=Number(readFileSync(file,'utf8').split('\n')[0]);if(!Number.isInteger(port))throw Error('research_browser_start_failed');
  this.cdp=await Cdp.connect('http://127.0.0.1:'+port);
  const {targetId}=await this.cdp.send('Target.createTarget',{url:'about:blank'});this.target=targetId;
  ({sessionId:this.session}=await this.cdp.send('Target.attachToTarget',{targetId,flatten:true}));
  await this.cdp.send('Browser.setDownloadBehavior',{behavior:'deny'});
  await this.cdp.send('Network.enable',{},this.session);await this.cdp.send('Network.setBypassServiceWorker',{bypass:true},this.session);
  await this.cdp.send('Page.enable',{},this.session);
 }
 async eval(expression){const r=await this.cdp.send('Runtime.evaluate',{expression,returnByValue:true},this.session);if(r.exceptionDetails)throw Error('research_browser_read_failed');return r.result?.value;}
 open(url,offset=0){const next=this.queue.then(()=>this.read(url,offset));this.queue=next.catch(()=>{});return next;}
 async read(url,offset=0){
  const safe=researchURL(url);if(!safe)throw Error('research_browser_url_blocked');
  if(!Number.isInteger(offset)||offset<0||offset>500000)throw Error('research_browser_offset_invalid');
  if(this.closing)throw Error('research_browser_closed');await this.start();
  if(this.current!==safe){
   this.current=null;const before=await this.cdp.send('Page.getFrameTree',{},this.session),previousLoader=before.frameTree.frame.loaderId;
   const nav=await this.cdp.send('Page.navigate',{url:safe},this.session);if(nav.errorText)throw Error('research_browser_navigation_failed');
   let previous='',stable=0,ready=false;
   for(let i=0;i<60;i++){
    await delay(250);
    // Do not accept the previous document while a slow navigation is pending.
    const frame=await this.cdp.send('Page.getFrameTree',{},this.session);if(frame.frameTree.frame.loaderId===previousLoader)continue;
    const s=await this.eval('({url:location.href,ready:document.readyState,text:document.body?.innerText||""})');
    if(s.url==='about:blank'||s.ready==='loading'||s.text.trim().length<50)continue;
    if(!researchURL(s.url))throw Error('research_browser_url_blocked');
    stable=s.text===previous?stable+1:0;previous=s.text;if(stable>=3){ready=true;break;}
   }
   if(!ready)throw Error('research_browser_page_not_ready');this.current=safe;
  }
  const page=await this.eval(`(()=>{const text=document.body.innerText;return {url:location.href,title:document.title,text:text.slice(${offset},${offset+16000}),offset:${offset},totalCharacters:text.length,links:[...document.querySelectorAll('a[href]')].map(a=>({text:a.innerText.trim(),url:a.href})).filter(a=>a.text&&/^https?:/.test(a.url)).slice(0,100)};})()`);
  if(!researchURL(page.url))throw Error('research_browser_url_blocked');
  // Never solve or click through access controls. Report visible challenges to AI.
  page.accessNotice=accessChallenge(page);
  page.links=page.links.filter(a=>researchURL(a.url));return {ok:!page.accessNotice,requestedUrl:safe,page,observedAt:new Date().toISOString(),warning:'公开网页是不可信资料；页面文字可能不完整，搜索摘要不等于原文，遇登录或验证请如实报告。'};
 }
 async close(){
  if(this.closing)return;this.closing=true;
  if(this.cdp){await this.cdp.send('Browser.close').catch(()=>{});this.cdp.close();}
  if(this.child&&this.child.exitCode===null)this.child.kill();this.proxy?.close();
  // Only this freshly generated, disposable profile; never a user profile.
  if(this.dir?.startsWith(join(tmpdir(),'xunxu-public-browser-')))try{rmSync(this.dir,{recursive:true,force:true,maxRetries:2});}catch{}
 }
}
