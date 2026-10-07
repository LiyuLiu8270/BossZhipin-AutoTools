// Explicit read-only live acceptance; only owned tabs, never messages or production DB writes.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {Cdp} from '../local/boss-cdp.mjs';
import {collectPage} from '../shared/collector.js';
import {CompanyIdentity} from '../local/company-identity.mjs';
if(!process.argv.includes('--live'))throw Error('explicit_live_flag_required');
const db=new DatabaseSync('local/data/jobs.sqlite',{readOnly:true}),jobs=db.prepare('SELECT body FROM intake_jobs').all().map(r=>JSON.parse(r.body));db.close();
const testdb=new DatabaseSync(':memory:');
let pageReads=0;const resolver=new CompanyIdentity(testdb,{readPage:async()=>{pageReads++;throw Error('detail_should_be_reused');}});
const c=await Cdp.connect(),results=[];
try{
 for(const name of ['立创商城','莱达四维']){
  const job=jobs.find(j=>j.company===name);assert.ok(job);let target;
  try{
   target=(await c.send('Target.createTarget',{url:job.url,background:true})).targetId;
   const sid=(await c.send('Target.attachToTarget',{targetId:target,flatten:true})).sessionId;
   let capture;
   for(let i=0;i<12;i++){
    await new Promise(r=>setTimeout(r,900));
    capture=(await c.send('Runtime.evaluate',{expression:`(${collectPage.toString()})()`,returnByValue:true},sid)).result?.value;
    if(['blocked','login_required'].includes(capture?.status))throw Error('platform_gate');
    if(capture?.jobs?.[0]?.company_identity?.state==='platform_verified')break;
   }
   const identity=capture?.jobs?.[0]?.company_identity;
   if(identity?.state!=='platform_verified')console.log((await c.send('Runtime.evaluate',{expression:`[...document.querySelectorAll('h2,h3,h4')].filter(e=>e.innerText.includes('工商')).map(e=>({heading:e.outerHTML,parent:e.parentElement.outerHTML.slice(0,6000)}))`,returnByValue:true},sid)).result?.value);
   assert.equal(identity?.state,'platform_verified',JSON.stringify(identity));
   const resolved=await resolver.resolve({...job,company_identity:identity});assert.equal(resolved.full_name,identity.full_name);
   results.push({display_name:name,...resolved});
  }finally{if(target)await c.send('Target.closeTarget',{targetId:target});}
 }
 assert.equal(pageReads,0);mkdirSync('artifacts/company-identity',{recursive:true});writeFileSync('artifacts/company-identity/live.json',JSON.stringify({at:new Date().toISOString(),results,extraCompanyPageReads:pageReads,productionWrites:0,realHRMessages:0},null,2));console.log(JSON.stringify({results,extraCompanyPageReads:pageReads,productionWrites:0}));
}finally{c.close();testdb.close();}
