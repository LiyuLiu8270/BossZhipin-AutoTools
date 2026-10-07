import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
const port=17461;
const files=new Map([['/',['index.html','text/html']],['/style.css',['style.css','text/css']],['/app.js',['app.js','text/javascript']]]);
export const server=createServer((req,res)=>{
 const u=new URL(req.url,'http://127.0.0.1:'+port),f=files.get(u.pathname);
 if(req.headers.host!==`127.0.0.1:${port}`||!['GET','HEAD'].includes(req.method)||!f){res.writeHead(404);res.end('Prototype resource not found');return;}
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; form-action 'none'");
 res.writeHead(200,{'Content-Type':f[1]+'; charset=utf-8'});res.end(req.method==='HEAD'?undefined:readFileSync(new URL('../prototypes/usability-2026-10/'+f[0],import.meta.url)));
});
server.listen(port,'127.0.0.1',()=>console.log(`Prototype comparison ready: http://127.0.0.1:${port}/?v=a (synthetic data only)`));
