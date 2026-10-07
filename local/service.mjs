import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';

export function createIntakeServer({worker,token,port=17321,onStop=()=>{},webHandler=null,communicationAlerts=()=>({unread:0,latestId:''})}){
  const authorized=req=>{
    if(req.headers.host!==`127.0.0.1:${port}`)return false;
    const origin=req.headers.origin;
    if(origin)return false; // CLI administration only; browser requests use the UI session.
    const value=String(req.headers['x-service-token']||'');
    return /^[a-f0-9]{64}$/.test(value)&&value.length===token.length&&timingSafeEqual(Buffer.from(value),Buffer.from(token));
  };
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');
    const reply=(code,data)=>{res.writeHead(code);res.end(JSON.stringify(data));};
    try{if(webHandler && await webHandler(req,res))return;}catch{req.resume();if(!res.headersSent)reply(500,{error:'service_error'});else res.end();return;}
    if(!authorized(req)){req.resume();return reply(403,{error:'unauthorized'});}
    // No extension intake or permissive CORS. Keep authenticated local health/stop only.
    if(req.method==='GET'&&req.url==='/health')return reply(200,{ok:true,...worker.status(),communicationAlerts:communicationAlerts()});
    if(req.method==='POST'&&req.url==='/stop'){req.resume();onStop();return reply(200,{ok:true,status:'stopping_after_inflight'});}
    req.resume();return reply(404,{error:'not_found'});
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return server;
}
