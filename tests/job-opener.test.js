import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {JobOpener,jobOpenInput} from '../local/job-opener.mjs';
const job={id:'boss:test',url:'https://www.zhipin.com/job_detail/test.html?untrusted=discard',scraper_access:{security_id:'local-test-context',lid:'local-test-lid'},contact_status:'contacted'};
test('仅允许已保存岗位身份，参数取服务端字段，不打开外部地址',async()=>{
 assert.deepEqual(jobOpenInput(job),{job_link:'https://www.zhipin.com/job_detail/test.html',security_id:'local-test-context',lid:'local-test-lid'});
 for(const url of ['https://evil.example/job_detail/test.html','javascript:alert(1)','https://www.zhipin.com/job_detail/other.html'])assert.throws(()=>jobOpenInput({...job,url}),/invalid_job_link/);
 const original=structuredClone(job);let calls=0;
 const opener=new JobOpener({get:(dataset,id)=>dataset==='test'&&id===job.id?job:null},{dataDir:mkdtempSync(join(tmpdir(),'job-open-')),ensureBrowser:async()=>{},runner:async(mode,input)=>{calls++;assert.equal(mode,'open');assert.equal(input.job.security_id,'local-test-context');return {ok:true,opened:true,page_state:'detail_visible',jd_characters:123,secret:'not returned'};}});
 await assert.rejects(opener.open({dataset:'test',id:job.id,url:'https://evil.example'}),/invalid_job_link/);
 await assert.rejects(opener.open({dataset:'other',id:job.id}),/job_not_found/);
 assert.deepEqual(await opener.open({dataset:'test',id:job.id}),{ok:true,opened:true,page_state:'detail_visible',jd_characters:123,foregrounded:false,foreground_status:'unverified'});assert.equal(calls,1);assert.deepEqual(job,original);
});
test('重复点击互斥，不自动重试不确定操作；失败后可人工重试',async()=>{
 let release,calls=0;const opener=new JobOpener({get:()=>job},{dataDir:mkdtempSync(join(tmpdir(),'job-open-')),ensureBrowser:()=>new Promise(r=>{release=r;}),runner:async()=>{calls++;return {ok:false};}});
 const first=opener.open({dataset:'test',id:job.id});await assert.rejects(opener.open({dataset:'test',id:job.id}),/job_open_busy/);release();await assert.rejects(first,/job_open_uncertain/);assert.equal(calls,1);assert.equal(opener.busy,false);
});
test('登录和验证提示不伪报完整信息已获取，浏览器不可用明确失败',async()=>{
 const opener=new JobOpener({get:()=>job},{dataDir:mkdtempSync(join(tmpdir(),'job-open-')),ensureBrowser:async()=>{},runner:async()=>({ok:true,opened:true,page_state:'login_required'})});
 assert.equal((await opener.open({dataset:'test',id:job.id})).page_state,'login_required');
 opener.ensureBrowser=async()=>{throw new Error('browser_unavailable');};await assert.rejects(opener.open({dataset:'test',id:job.id}),/browser_unavailable/);
});
