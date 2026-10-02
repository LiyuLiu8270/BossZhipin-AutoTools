import test from 'node:test';
import assert from 'node:assert/strict';
import {monthlySalary,salaryMatches} from '../shared/salary.js';
test('月薪保守解析，额外薪数不折算，不猜年薪日薪或面议',()=>{
 for(const text of ['15-25K','15K-25K·13薪','1.5-2.5万/月','15000-25000元/月','１５－２５Ｋ'])assert.deepEqual(monthlySalary(text),{min:15000,max:25000});
 assert.deepEqual(monthlySalary('20K'),{min:20000,max:20000});
 for(const text of ['面议','',null,'20-30万/年','200元/天','20-30美元/月','30-20K','0K','20000','底薪20K+提成'])assert.equal(monthlySalary(text),null);
});
test('范围按交集筛选，下边界包含、上边界不包含；未知单独选择',()=>{
 assert.equal(salaryMatches('15-25K','20-30'),true);
 assert.equal(salaryMatches('30K','20-30'),false);
 assert.equal(salaryMatches('20K','20-30'),true);
 assert.equal(salaryMatches('5-9K','20-30'),false);
 assert.equal(salaryMatches('面议','20-30'),false);
 assert.equal(salaryMatches('面议','unknown'),true);
 assert.equal(salaryMatches('20K','unknown'),false);
 assert.equal(salaryMatches('面议',''),true);
 assert.equal(salaryMatches('20K','bad'),false);
});
