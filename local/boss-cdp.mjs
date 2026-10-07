import {EventEmitter} from 'node:events';

// Production promotion of the verified target-scoped experiment. No global
// autoAttach, profile/cookie access, focus emulation, or platform API replay.
export class Cdp extends EventEmitter {
  constructor(socket,{timeoutMs=10000}={}) {
    super();Object.assign(this,{socket,timeoutMs,nextId:0,pending:new Map(),closed:false});
    socket.addEventListener('message',e=>this.receive(e.data));
    socket.addEventListener('close',()=>this.fail('cdp_disconnected'));
    socket.addEventListener('error',()=>this.fail('cdp_connection_error'));
  }
  static async connect(endpoint='http://127.0.0.1:19222',{timeoutMs=10000}={}) {
    const u=new URL(endpoint);
    if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('loopback_endpoint_required');
    let response;try{response=await fetch(new URL('/json/version',u),{signal:AbortSignal.timeout(timeoutMs),redirect:'error'});}catch{throw Error('cdp_discovery_unavailable');}
    if(!response.ok)throw Error('cdp_discovery_failed');
    const meta=await response.json(),ws=new URL(meta.webSocketDebuggerUrl);
    if(ws.protocol!=='ws:'||ws.hostname!=='127.0.0.1'||ws.port!==u.port||!ws.pathname.startsWith('/devtools/browser/')||ws.username||ws.password)throw Error('cdp_discovery_endpoint_mismatch');
    const socket=new WebSocket(ws),cdp=new Cdp(socket,{timeoutMs});cdp.version=meta.Browser;
    try{await new Promise((resolve,reject)=>{
      const done=error=>{clearTimeout(timer);socket.removeEventListener('open',opened);socket.removeEventListener('error',failed);socket.removeEventListener('close',failed);error?reject(error):resolve();};
      const opened=()=>done(),failed=()=>done(Error('cdp_connect_failed'));
      const timer=setTimeout(()=>done(Error('cdp_connect_timeout')),timeoutMs);
      socket.addEventListener('open',opened,{once:true});socket.addEventListener('error',failed,{once:true});socket.addEventListener('close',failed,{once:true});
    });}catch(e){cdp.close();throw e;}return cdp;
  }
  send(method,params={},sessionId,{timeoutMs=this.timeoutMs}={}){
    if(this.closed||this.socket.readyState!==1)return Promise.reject(Error('cdp_closed'));
    const id=++this.nextId;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('cdp_timeout:'+method));},timeoutMs);
      this.pending.set(id,{resolve,reject,timer,method,sessionId});
      try{this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}catch{clearTimeout(timer);this.pending.delete(id);reject(Error('cdp_send_failed:'+method));}
    });
  }
  receive(raw){
    let p;try{p=JSON.parse(String(raw));}catch{return;}
    if(p.id!==undefined){
      const r=this.pending.get(p.id);if(!r)return;
      const rootError=p.sessionId===undefined&&p.error&&Number.isInteger(p.error.code);
      if(!rootError&&(p.sessionId||null)!==(r.sessionId||null))return;
      this.pending.delete(p.id);clearTimeout(r.timer);
      if(p.error)r.reject(Error('cdp_protocol_error:'+r.method+':'+p.error.code));else r.resolve(p.result);
    }else if(p.method)this.emit('event',p);
  }
  fail(reason){if(this.closed)return;this.closed=true;for(const r of this.pending.values()){clearTimeout(r.timer);r.reject(Error(reason));}this.pending.clear();}
  close(){this.fail('cdp_closed');try{this.socket.close();}catch{}}
}
