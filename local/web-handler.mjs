import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';

export function createWebHandler({controller,port=17321}){
  const session=randomBytes(32).toString('hex'),origin=`http://127.0.0.1:${port}`;
  const assets=new Map([['/',['index.html','text/html']],['/index.html',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/styles.css',['styles.css','text/css']]]);
  return async(req,res)=>{
    const url=new URL(req.url,origin);
    if(!assets.has(url.pathname)&&!url.pathname.startsWith('/api/'))return false;
    const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    res.setHeader('Referrer-Policy','no-referrer');
    if(req.headers.host!==`127.0.0.1:${port}`||(req.headers.origin&&req.headers.origin!==origin)){req.resume();reply(403,{error:'forbidden_origin'});return true;}
    if(assets.has(url.pathname)){
      if(!['GET','HEAD'].includes(req.method)){req.resume();reply(405,{error:'method_not_allowed'});return true;}
      const [name,type]=assets.get(url.pathname);
      if(name==='index.html')res.setHeader('Set-Cookie',`career_ui=${session}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`});res.end(req.method==='HEAD'?undefined:readFileSync(new URL(`./web/${name}`,import.meta.url)));return true;
    }
    const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('career_ui='))?.slice(10)||'';
    if(!/^[a-f0-9]{64}$/.test(cookie)||!timingSafeEqual(Buffer.from(cookie),Buffer.from(session))||req.headers['x-local-ui']!=='1'){
      req.resume();reply(403,{error:'reload_required'});return true;
    }
    // Retired manual job JSON upload; reject before reading/parsing a request body.
    if(url.pathname==='/api/import'){req.resume();reply(404,{error:'not_found'});return true;}
    try{
      if(req.method==='GET'){
        const p=url.pathname;
        if(p==='/api/state')reply(200,controller.state());
        else if(p==='/api/matching-policy')reply(200,controller.matchingPolicy());
        else if(p==='/api/jobs')reply(200,controller.list(url.searchParams));
        else if(p==='/api/job')reply(200,controller.detail(url.searchParams.get('dataset'),url.searchParams.get('id')));
        else if(p==='/api/profile')reply(200,controller.worker.profile);
        else if(p==='/api/profile/resume'){const doc=controller.resumeDocuments.current();reply(200,{document:doc?{...doc,matching_connected:controller.resumeOnly}:null});}
        else if(p==='/api/profile/insights')reply(200,controller.resumeInsights.status());
        else if(p==='/api/profile/resume/original'){
          const file=controller.resumeDocuments.original();
          if(!file)reply(404,{error:'resume_not_found'});
          else{res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':`attachment; filename="resume.docx"; filename*=UTF-8''${encodeURIComponent(file.filename)}`});res.end(file.original);}
        }
        else if(p==='/api/report'){res.setHeader('Content-Disposition','attachment; filename="job-match-report.json"');reply(200,controller.worker.render());}
        else reply(404,{error:'not_found'});
      }else if(req.method==='POST'){
        if(req.headers.origin!==origin||!String(req.headers['content-type']).startsWith('application/json')){req.resume();reply(403,{error:'invalid_request'});return true;}
        let bytes=0;const parts=[],max=url.pathname==='/api/profile/resume'?14*1024*1024:1024*1024;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>max){reply(413,{error:'body_too_large'});req.destroy();return true;}parts.push(chunk);}
        const value=JSON.parse(Buffer.concat(parts).toString('utf8')||'{}');
        if(url.pathname==='/api/settings')reply(200,controller.saveSettings(value));
        else if(url.pathname==='/api/matching-policy')reply(200,controller.saveMatchingPolicy(value));
        else if(url.pathname==='/api/job/open')reply(200,await controller.jobOpener.open(value));
        else if(url.pathname==='/api/collection/settings')reply(200,controller.collector.save(value));
        else if(url.pathname==='/api/collection/start')reply(200,controller.collector.start());
        else if(url.pathname==='/api/collection/details')reply(200,controller.collector.startDetails());
        else if(url.pathname==='/api/collection/resume')reply(200,controller.collector.resume(value));
        else if(url.pathname==='/api/collection/retry-search')reply(200,controller.collector.retrySearch(value));
        else if(url.pathname==='/api/collection/backfill')reply(200,controller.collector.backfill());
        else if(url.pathname==='/api/collection/stop')reply(200,controller.collector.stop());
        else if(url.pathname==='/api/collection/retry')reply(200,controller.collector.retry());
        else if(url.pathname==='/api/profile')reply(200,controller.saveProfile(value));
        else if(url.pathname==='/api/profile/resume')reply(200,await controller.importResume(value));
        else if(url.pathname==='/api/profile/insights')reply(202,controller.resumeInsights.start(value));
        else if(url.pathname==='/api/action')reply(200,controller.action(value));
        else if(url.pathname==='/api/retry'){if(controller.busy)throw new Error('analysis_busy');const requeued=controller.worker.retryFailed();reply(200,{ok:true,requeued});}
        else reply(404,{error:'not_found'});
      }else{req.resume();reply(405,{error:'method_not_allowed'});}
    }catch(e){
      if(e.message==='contact_reply_conflict'){reply(400,{error:e.message});return true;}
      const error=['detail_daily_limit','collection_resume_unavailable','collection_search_retry_unavailable','invalid_matching_policy','analysis_busy','invalid_profile','invalid_settings','job_not_found','invalid_action','contact_stage_conflict','collection_busy','invalid_collection_settings','collection_keywords_required','invalid_job_link','job_open_busy','job_open_uncertain','browser_unavailable','resume_import_busy','resume_invalid_filename','resume_file_size','resume_docx_required','resume_invalid_docx','resume_archive_limit','resume_encrypted','resume_macro_unsupported','resume_no_text','resume_text_limit','resume_parse_timeout','resume_parse_failed','resume_parser_unavailable','resume_required','resume_only','resume_changed','insight_busy'].includes(e.message)?e.message:'request_failed';
      reply(['analysis_busy','job_open_busy'].includes(error)?409:error==='job_not_found'?404:400,{error});
    }
    return true;
  };
}
