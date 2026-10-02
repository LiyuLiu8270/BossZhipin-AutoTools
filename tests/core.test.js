import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {jobIdentity, sourceUrl, normalizeJob, mergeJob, emptyDataset, applyCapture, csv, exportData} from '../shared/core.js';

const url = 'https://www.zhipin.com/job_detail/test_01.html?securityId=secret&lid=abc';
const context = {observed_at: '2026-09-29T01:00:00Z', url: 'https://www.zhipin.com/web/geek/jobs?query=SaaS&city=101280600&securityId=secret', keyword: 'SaaS'};
const raw = {url, title: 'SaaS 产品经理', company: '测试公司（合成）', salary: '20-30K', jd: '', tags: ['B端', 'B端']};
const normalize = (extra = {}) => normalizeJob({...raw, ...extra}, context);
const capture = (jobs, keyword = 'SaaS') => ({source_url: context.url, keyword, page_type: 'list', status: 'captured', jobs, warnings: [], diagnostics: {cards_found: jobs.length}});
const longJd = '本测试使用合成职位描述：负责企业服务产品的需求调研、业务流程设计、需求评审、研发协同及上线验证。任职要求为具备 B 端项目经验、跨团队沟通能力及数据分析能力。'.repeat(3);

test('岗位稳定 ID 去掉追踪与安全参数', () => {
  assert.deepEqual(jobIdentity(url), {id: 'boss:test_01', job_id: 'test_01', url: 'https://www.zhipin.com/job_detail/test_01.html'});
  assert.equal(sourceUrl(context.url).includes('secret'), false);
  for (const value of ['https://evil.example/job_detail/x.html', 'javascript:alert(1)', 'https://www.zhipin.com/web/geek/chat', 'http://www.zhipin.com/job_detail/a.html']) assert.equal(jobIdentity(value), null);
  assert.equal(sourceUrl('https://www.zhipin.com/web/geek/chat'), '');
});

test('含波浪号岗位 ID 保留原身份、清理访问参数，不放开域名与路径校验',()=>{
  const base='https://www.zhipin.com/job_detail/synthetic_01-~.html';
  assert.equal(jobIdentity(base+'?securityId=private').id,'boss:synthetic_01-~');
  assert.equal(sourceUrl(base+'?securityId=private'),base);
  for(const bad of [base.replace('www.zhipin.com','evil.example'),base.replace('~','/'),base.replace('~','%2F'),base.replace('https:','http:')])assert.equal(jobIdentity(bad),null);
});

test('缺 ID/标题拒绝入库；不臆测公司、登录态或沟通状态', () => {
  assert.equal(normalize({url: ''}), null);
  assert.equal(normalize({title: ''}), null);
  const job = normalize({company: ''});
  assert.equal(job.company, '');
  assert.equal(job.contact_status, 'unknown');
  assert.equal(job.login_evidence, 'user_confirmed_not_automatically_verified');
  assert.deepEqual(job.tags, ['B端']);
});

test('JD 缺失/短文本/登录墙/展开提示/字体编码/截断不标为完整', () => {
  assert.equal(normalize().jd_status, 'missing');
  assert.equal(normalize({jd: '短描述'}).jd_status, 'short_unverified');
  for (const jd of [longJd + '登录查看完整内容', longJd + '展开全部', longJd + '\uE123']) assert.equal(normalize({jd}).jd_status, 'partial');
  assert.equal(normalize({jd: longJd, jd_truncated: true}).jd_status, 'partial');
  assert.equal(normalize({jd: longJd}).jd_status, 'captured_unverified');
});

test('特殊字体薪资标记待核对，不自行解码数字', () => {
  const job = normalize({salary: '\uE012-\uE015K'});
  assert.ok(job.quality_flags.includes('salary_encoded_font'));
  assert.equal(job.salary, '\uE012-\uE015K');
  assert.equal(job.salary_source, 'rendered_dom_unverified');
});

test('跨关键词、跨日期同岗位去重，保留首次发现时间', () => {
  const first = applyCapture(emptyDataset('A'), capture([raw]), '2026-09-28T00:00:00Z');
  const second = applyCapture(first.dataset, capture([raw], 'B端'), '2026-09-29T00:00:00Z');
  assert.equal(first.run.added, 1);
  assert.equal(second.run.added, 0);
  assert.equal(Object.keys(second.dataset.jobs).length, 1);
  const job = second.dataset.jobs['boss:test_01'];
  assert.equal(job.first_seen_at, '2026-09-28T00:00:00Z');
  assert.equal(job.last_seen_at, '2026-09-29T00:00:00Z');
  assert.deepEqual(job.keywords, ['SaaS', 'B端']);
  assert.equal(job.seen_count, 2);
});

test('先列表后详情能补全；随后列表不覆盖已保存 JD', () => {
  const one = applyCapture(emptyDataset('A'), capture([raw])).dataset;
  const two = applyCapture(one, capture([{...raw, jd: longJd}])).dataset;
  const three = applyCapture(two, capture([raw])).dataset;
  assert.equal(three.jobs['boss:test_01'].jd, longJd);
  assert.equal(three.jobs['boss:test_01'].jd_status, 'captured_unverified');
  assert.equal(mergeJob(normalize({jd: longJd}), normalize({jd: '登录查看完整内容'})).jd, longJd);
});

test('新完整候选 JD 更新旧版本；不同岗位不能混合', () => {
  assert.equal(mergeJob(normalize({jd: longJd}), normalize({jd: longJd + '更新'})).jd, longJd + '更新');
  assert.throws(() => mergeJob(normalize(), normalize({url: '/job_detail/other.html'})), /ID/);
});

test('重复 DOM 卡片只计一次；独立数据集互不污染', () => {
  const first = applyCapture(emptyDataset('A'), capture([raw, raw]));
  assert.equal(first.run.matched, 1);
  assert.equal(first.dataset.jobs['boss:test_01'].seen_count, 1);
  assert.equal(Object.keys(emptyDataset('B').jobs).length, 0);
});

test('验证页残留卡片不能入库；零岗位也保留诊断', () => {
  const blocked = applyCapture(emptyDataset('A'), {...capture([raw]), status: 'blocked'});
  assert.equal(Object.keys(blocked.dataset.jobs).length, 0);
  assert.equal(blocked.dataset.runs[0].status, 'blocked');
  let dataset = blocked.dataset;
  for (let i = 0; i < 120; i++) dataset = applyCapture(dataset, {...capture([]), status: 'empty'}).dataset;
  assert.equal(dataset.runs.length, 100);
});

test('JSON 不导出追踪参数；CSV 防公式注入、引号和中文多行', () => {
  const dataset = applyCapture(emptyDataset('A'), capture([{...raw, title: '=HYPERLINK("bad")', jd: '第一行\n第二行'}])).dataset;
  const output = csv(dataset);
  assert.ok(output.startsWith('\uFEFF'));
  assert.ok(output.includes("'=HYPERLINK"));
  assert.ok(output.includes('第一行\n第二行'));
  const data = exportData(dataset);
  assert.equal(data.jobs.length, 1);
  assert.equal(JSON.stringify(data).includes('secret'), false);
  assert.equal(data.jobs[0].contact_status, 'unknown');
});
