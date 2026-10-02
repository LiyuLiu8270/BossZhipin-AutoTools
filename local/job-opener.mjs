import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {jobIdentity} from '../shared/core.js';
import {ensureCollectorBrowser,runBridge} from './collector.mjs';

export function jobOpenInput(job){
  const identity=jobIdentity(job?.url);
  if(!identity||identity.id!==job?.id)throw new Error('invalid_job_link');
  const input={job_link:identity.url};
  for(const key of ['security_id','lid']){
    const value=job.scraper_access?.[key];
    if(typeof value==='string'&&value.length<=4096)input[key]=value;
  }
  return input;
}

export class JobOpener {
  constructor(store,{dataDir,ensureBrowser=ensureCollectorBrowser,runner=runBridge}={}){
    Object.assign(this,{store,dataDir,ensureBrowser,runner});this.busy=false;
  }
  async open(value){
    if(!value||typeof value.dataset!=='string'||typeof value.id!=='string'||Object.keys(value).some(k=>!['dataset','id'].includes(k)))throw new Error('invalid_job_link');
    const job=this.store.get(value.dataset,value.id);if(!job)throw new Error('job_not_found');
    const input=jobOpenInput(job);
    if(this.busy)throw new Error('job_open_busy');this.busy=true;
    try{
      await this.ensureBrowser();
      const directory=join(this.dataDir,'open-job');mkdirSync(directory,{recursive:true});
      const result=await this.runner('open',{job:input},{directory,timeoutMs:30000});
      if(!result.ok||!result.opened)throw new Error('job_open_uncertain');
      const states=['detail_visible','login_required','verification_required','page_changed','unverified'];
      return {ok:true,opened:true,page_state:states.includes(result.page_state)?result.page_state:'unverified',
        foregrounded:result.foregrounded===true,
        foreground_status:['foreground','system_denied','window_not_identified','unsupported'].includes(result.foreground_status)?result.foreground_status:'unverified',
        jd_characters:Number.isInteger(result.jd_characters)?result.jd_characters:0};
    }catch(e){throw new Error(e.message==='browser_unavailable'?'browser_unavailable':'job_open_uncertain');}
    finally{this.busy=false;}
  }
}
