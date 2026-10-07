// Public evidence fetcher: no cookies, proxy credentials, local addresses or browser session.
import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {isIP} from 'node:net';

export function publicIPv4(ip){
 if(isIP(ip)!==4)return false;
 const [a,b]=ip.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||a===100&&b>=64&&b<=127||a===198&&[18,19,51].includes(b)||a===203&&b===0);
}
export function publicURL(value){
 try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port)||u.hostname.includes(':')||!u.hostname.includes('.')||u.hostname.endsWith('.local')||u.hostname.endsWith('.localhost')||isIP(u.hostname)&&!publicIPv4(u.hostname))return null;u.hash='';return u.href;}catch{return null;}
}
export function plainText(html){
 return html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<!--[^]*?-->/g,' ').replace(/<[^>]*>/g,' ').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const c=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return c>0&&c<=0x10ffff?String.fromCodePoint(c):' ';}).replace(/&(amp|lt|gt|quot|apos|nbsp);/g,(_,s)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '})[s]).replace(/\s+/gu,' ').trim();
}
export async function fetchPublicText(value,{resolve=lookup,request,timeoutMs=12000,maxBytes=1500000,redirects=3,includeHtml=false}={}){
 const safe=publicURL(value);if(!safe)throw Error('source_url_blocked');const url=new URL(safe);
 // Pin the vetted DNS answer in the connection, preventing DNS rebinding.
 let dnsTimer;const addresses=await Promise.race([resolve(url.hostname,{family:4,all:true}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(Error('source_dns_timeout')),timeoutMs);})]).finally(()=>clearTimeout(dnsTimer));
 if(!addresses.length||addresses.some(x=>!publicIPv4(x.address)))throw Error('source_address_blocked');
 const result=await new Promise((ok,fail)=>{
  const req=(request||(url.protocol==='https:'?httpsRequest:httpRequest))(url,{agent:false,headers:{'User-Agent':'Xunxu-Company-Research/1.0 (+public-source-verification)','Accept':'text/html,text/plain,application/xhtml+xml','Accept-Encoding':'identity'},lookup:(_host,options,callback)=>callback(null,...(options.all?[[{address:addresses[0].address,family:4}]]:[addresses[0].address,4]))},res=>{
   if([301,302,303,307,308].includes(res.statusCode)){res.resume();ok({redirect:res.headers.location});return;}
   const type=res.headers['content-type']||'';
   if(res.statusCode!==200){res.resume();fail(Error('source_http_'+res.statusCode));return;}
   if(!/(text\/html|text\/plain|application\/xhtml\+xml)/i.test(type)){res.resume();fail(Error('source_content_type'));return;}
   const chunks=[];let bytes=0;
   res.on('data',c=>{bytes+=c.length;if(bytes>maxBytes)req.destroy(Error('source_too_large'));else chunks.push(c);});res.on('error',()=>fail(Error('source_unavailable')));
   res.on('end',()=>{try{const label=/charset=["']?([\w-]+)/i.exec(type)?.[1]||'utf-8';const html=new TextDecoder(label).decode(Buffer.concat(chunks));ok({text:plainText(html),...(includeHtml?{html}:{})});}catch{fail(Error('source_encoding'));}});
  });const timer=setTimeout(()=>req.destroy(Error('source_timeout')),timeoutMs);req.on('close',()=>clearTimeout(timer));req.on('error',e=>fail(Error(['source_timeout','source_too_large'].includes(e.message)?e.message:'source_unavailable')));req.end();
 });
 if(result.redirect){if(redirects<=0)throw Error('source_redirect_limit');return fetchPublicText(new URL(result.redirect,url).href,{resolve,request,timeoutMs,maxBytes,redirects:redirects-1,includeHtml});}
 if(!result.text||/captcha|人机验证|安全验证|Access Denied|Just a moment/i.test(result.text.slice(0,500)))throw Error('source_gate');
 return {url:safe,...result};
}
