import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {CompanyIdentity,companyPageURL,parseCompanyIdentity} from '../local/company-identity.mjs';
const url='https://www.zhipin.com/gongsi/test~.html',full='合成科技有限公司';
const body='工商信息\n企业名称：\n'+full+'\n统一社会信用代码：\n91440300597793399Q\n注册地址：\n合成地址\n公司地址\n推荐公司\n其他有限公司';
test('缺失公司链接直接返回，不用URL异常作为分支；有效链接净化及域名限制不变',()=>{
 const Original=globalThis.URL;let calls=0;
 try{globalThis.URL=class extends Original{constructor(...args){calls++;super(...args);}};
  for(const value of [undefined,null,'','  ',0,{},[]])assert.equal(companyPageURL(value),null);
  assert.equal(calls,0);assert.equal(companyPageURL(url+'?x=1#fragment'),url);assert.equal(calls,1);
 }finally{globalThis.URL=Original;}
});
test('工商字段按显式标签解析，不把推荐公司或法人当公司；来源跳转和多主体拒绝',()=>{
 const opts={url,expectedURL:url,displayName:'合成'};const i=parseCompanyIdentity(body,opts);assert.equal(i.full_name,full);assert.equal(i.credit_code,'91440300597793399Q');assert.equal(i.registered_address,'合成地址');
 assert.equal(parseCompanyIdentity(body,{...opts,url:url.replace('test','other')}).state,'page_changed');
 assert.equal(parseCompanyIdentity(body.replace('公司地址','企业名称：\n另一有限公司\n公司地址'),opts).state,'conflict');
 assert.equal(parseCompanyIdentity('推荐公司\n企业名称：别家有限公司',opts).state,'not_displayed');
 assert.equal(parseCompanyIdentity('请完成安全验证',opts).state,'verification_required');
 for(const u of ['https://evil.test/gongsi/test.html','https://user@www.zhipin.com/gongsi/test.html','http://www.zhipin.com/gongsi/test.html'])assert.equal(companyPageURL(u),null);
});
test('详情已有全称直接复用，绑定本岗位及时间；冲突不再用主页覆盖，代招跳过',async()=>{
 const db=new DatabaseSync(':memory:');let reads=0;
 const r=new CompanyIdentity(db,{readPage:async()=>{reads++;throw Error('unexpected');}});
 const job={company:'合成',url:'https://www.zhipin.com/job_detail/x.html',company_identity:{state:'platform_verified',source_kind:'job_detail',source_url:'https://www.zhipin.com/job_detail/x.html',full_name:full,quote:'公司名称：'+full,observed_at:new Date().toISOString()}};
 assert.equal((await r.resolve(job)).full_name,full);assert.equal(reads,0);
 assert.equal((await r.resolve({...job,company_identity:{...job.company_identity,state:'conflict'}})).state,'conflict');
 assert.equal((await r.resolve({...job,hiring_party:{type:'agency'}})).state,'agency_unknown');
 assert.equal((await r.resolve({...job,url:'https://www.zhipin.com/job_detail/other.html'})).state,'no_company_link');db.close();
});
test('同主页串行取证并缓存；缺字段也缓存；验证码全局退避不重复开页',async()=>{
 const db=new DatabaseSync(':memory:');let reads=0,active=0,max=0;
 const r=new CompanyIdentity(db,{readPage:async u=>{reads++;active++;max=Math.max(max,active);await new Promise(r=>setImmediate(r));active--;return {url:u,text:body};}});
 const job={company:'合成',company_url:url};await Promise.all([r.resolve(job),r.resolve(job)]);assert.equal(reads,1);assert.equal(max,1);assert.equal(r.get(job).full_name,full);
 r.readPage=async u=>{reads++;return {url:u,text:'请完成安全验证'};};
 await assert.rejects(r.resolve({...job,company_url:url.replace('test','gate')}),/verification_required/);
 await assert.rejects(r.resolve({...job,company_url:url.replace('test','another')}),/browser_paused/);assert.equal(reads,2);db.close();
});
