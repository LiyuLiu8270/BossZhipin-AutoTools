import test from 'node:test';
import assert from 'node:assert/strict';
import {buildJobSearchIndex,matchesJobSearch,normalizeSearch} from '../shared/job-search.js';
const page='https://www.zhipin.com/gongsi/company_one.html';
const row=(id,extra={})=>({dataset:'A',id,job:{title:'数据产品经理',company:'SenseTime',location:'深圳',url:`https://www.zhipin.com/job_detail/${id}.html`,company_url:page,...extra}});
const identity=id=>({state:'platform_verified',source_kind:'job_detail',source_url:`https://www.zhipin.com/job_detail/${id}.html`,full_name:'深圳市商汤科技有限公司',company_url:page});
const find=(rows,q)=>{const index=buildJobSearchIndex(rows);return rows.filter(r=>matchesJobSearch(index,r.dataset,r.id,normalizeSearch(q))).map(r=>r.id);};
test('同主页已核实全称与招聘显示名双向检索，不改变原始岗位',()=>{
 const rows=[row('one',{company_identity:identity('one')}),row('two'),row('three',{company:'商汤科技'})],before=JSON.stringify(rows);
 for(const q of ['商汤','商汤科技','深圳市商汤科技有限公司','SenseTime',' sense time ','ＳＥＮＳＥＴＩＭＥ'])assert.deepEqual(find(rows,q),['one','two','three']);
 assert.deepEqual(find(rows,'数据产品'),['one','two','three']);assert.deepEqual(find(rows,'深圳'),['one','two','three']);assert.deepEqual(find(rows,'无关'),[]);assert.equal(JSON.stringify(rows),before);
});
test('不按显示名跨主页/数据集猜别名，不向猎头代招或冲突主体传播',()=>{
 const rows=[row('one',{company_identity:identity('one')}),row('different',{company_url:page.replace('one','two')}),{...row('other'),dataset:'B'},row('head',{hiring_party:{type:'headhunter'}}),row('agency',{hiring_party:{type:'agency'}}),row('conflict',{company_identity:{...identity('conflict'),state:'conflict'}})];
 assert.deepEqual(find(rows,'商汤'),['one']);
});
test('同主页多个全称只检索各岗位自己的证据，不给无证据岗位选主体',()=>{
 const rows=[row('one',{company_identity:identity('one')}),row('two',{company_identity:{...identity('two'),full_name:'另一家公司有限公司'}}),row('three')];
 assert.deepEqual(find(rows,'商汤'),['one']);assert.deepEqual(find(rows,'另一家公司'),['two']);
});
test('全称必须已核实且绑定当前岗位/公司页；不从正文或链接字符串猜主体',()=>{
 const rows=[row('mismatch',{company_identity:identity('elsewhere')}),row('unchecked',{company_identity:{...identity('unchecked'),state:'unavailable'}}),row('body',{jd:'商汤科技'}),row('nopage',{company_url:null,company_identity:{...identity('nopage'),company_url:null}})];
 assert.deepEqual(find(rows,'商汤'),['nopage']);
 const direct=row('page',{company_identity:{state:'platform_verified',source_kind:'company_page',source_url:page,full_name:'深圳市商汤科技有限公司'}});assert.deepEqual(find([direct,row('sibling')],'商汤'),['page','sibling']);
});
