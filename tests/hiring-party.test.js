import test from 'node:test';
import assert from 'node:assert/strict';
import {hiringParty, isHeadhunter, isAgency} from '../shared/hiring-party.js';
import {normalizeJob, mergeJob, migrateDataset, csv} from '../shared/core.js';
import {applyCompanyCapture, needsCompany} from '../shared/company.js';

const url = 'https://www.zhipin.com/job_detail/a.html';
const ctx = {url, observed_at: '2026-09-29', page_type: 'detail'};
const badge = {evidence: [{field: 'type', text: '猎头', selector: '.tag'}]};
const raw = {url, title: 'ai产品经理', company: '', jd: '职位描述'.repeat(40), hiring_party: badge};

test('代招类型/图片证据独立保存，后续未读到仍保留；JSON/CSV及迁移不会变成猎头', () => {
  const image = 'https://img.bosszhipin.com/static/file/2022/xkthl0qxyk1661512634054.png';
  const observation = {evidence: [{field: 'type', text: '代招', selector: 'img', image_url: image, rendered_as: 'img'}]};
  const next = normalizeJob({...raw, hiring_party: observation}, ctx);
  assert.equal(next.hiring_party.type, 'agency'); assert.equal(next.hiring_party.evidence[0].image_url, image);
  assert.equal(next.hiring_party.evidence[0].recognition_rule, 'boss-agency-static-icon-v1');
  assert.equal(next.quality_flags.includes('company_missing'), false); assert.equal(needsCompany(next), false);
  assert.equal(isAgency(next), true); assert.equal(isHeadhunter(next), false);
  const later = normalizeJob({...raw, hiring_party: null}, {...ctx, observed_at: 'later'});
  const merged = mergeJob(next, later), d = {jobs: {[next.id]: merged}, runs: []};
  assert.deepEqual(merged.hiring_party, next.hiring_party); assert.equal(merged.company, '');
  assert.equal(merged.quality_flags.includes('company_missing'), false); assert.equal(merged.jd, next.jd);
  assert.equal(JSON.parse(JSON.stringify(merged)).hiring_party.type, 'agency');
  assert.match(csv(d), /agency/); assert.match(csv(d), /代招/);
  assert.deepEqual(migrateDataset(d).jobs[next.id].hiring_party, next.hiring_party);
});

test('不接受图片语义错配；同时出现两种标识时保留冲突证据、不强行归类', () => {
  const wrong = {evidence: [{field: 'type', text: '猎头', selector: 'img', image_url: 'https://img.bosszhipin.com/static/file/2022/xkthl0qxyk1661512634054.png'}]};
  assert.equal(hiringParty(wrong, ctx), null);
  const next = normalizeJob({...raw, hiring_party: {evidence: [...badge.evidence, {field: 'type', text: '代招', selector: '.tag'}]}}, ctx);
  assert.equal(next.hiring_party.type, 'conflicting'); assert.equal(next.hiring_party.evidence.length, 2);
  assert.equal(isHeadhunter(next), false); assert.equal(isAgency(next), false);
  assert.equal(next.quality_flags.includes('company_missing'), true);
});

test('图标识别依据在规范化/合并/JSON导出后保留，不改变公司及正文', () => {
  const imageUrl = 'https://img.bosszhipin.com/static/file/2022/cbdau7t7qt1661512634122.png';
  const observation = {evidence: [{field: 'type', text: '猎头', selector: 'img', rendered_as: 'img', image_url: imageUrl, recognition_rule: 'boss-headhunter-static-icon-v1'}]};
  const next = normalizeJob({...raw, hiring_party: observation}, ctx);
  const later = normalizeJob({...raw, hiring_party: null}, {...ctx, observed_at: 'later'});
  const saved = JSON.parse(JSON.stringify(mergeJob(next, later)));
  assert.equal(saved.hiring_party.evidence[0].image_url, imageUrl);
  assert.equal(saved.hiring_party.evidence[0].recognition_rule, 'boss-headhunter-static-icon-v1');
  assert.equal(saved.hiring_party.evidence[0].raw_text, undefined);
  assert.equal(saved.company, ''); assert.equal(saved.jd, next.jd);
});

test('仅明确徽标入库，公司/JD/沟通字段不变，不推断雇主或机构名称', () => {
  const base = normalizeJob({...raw, hiring_party: null}, ctx), next = normalizeJob(raw, ctx);
  const {hiring_party: party, ...rest} = next;
  assert.deepEqual(rest, {...base, quality_flags: base.quality_flags.filter(f => f !== 'company_missing')}); assert.equal(party.type, 'headhunter'); assert.equal(party.source_url, url); assert.equal(party.observed_at, ctx.observed_at);
  for (const evidence of [[], [{field: 'client', text: '客户公司：某公司', selector: 'p'}], [{field: 'type', text: '招聘代招人员', selector: '.tag'}], [{field: 'type', text: '猎头顾问', selector: 'h1'}]]) assert.equal(hiringParty({evidence}, ctx), null);
  assert.equal(party.employer_name, undefined); assert.equal(needsCompany(next), false);
});

test('之后未识别标识不抹除既有观察，旧数据升级不反推招聘类型，JSON/CSV可追溯', () => {
  const first = normalizeJob(raw, ctx);
  const later = normalizeJob({...raw, hiring_party: null}, {...ctx, observed_at: 'later'});
  const merged = mergeJob(first, later);
  assert.deepEqual(merged.hiring_party, first.hiring_party);
  assert.equal(merged.quality_flags.includes('company_missing'), false);
  const legacy = {schema_version: 2, jobs: {[later.id]: later}, runs: []};
  const upgraded = migrateDataset(legacy);
  assert.equal(upgraded.jobs[later.id].hiring_party, undefined);
  const output = csv({...legacy, jobs: {[merged.id]: merged}});
  assert.match(output, /hiring_type/); assert.match(output, /headhunter/); assert.match(output, /猎头/); assert.match(output, /2026-09-29/);
});

test('公司补采新识别猎头时豁免缺失，不改变公司原值和JD', () => {
  const base = normalizeJob({...raw, hiring_party: null}, ctx);
  const dataset = {jobs: {[base.id]: base}, runs: []};
  const r = applyCompanyCapture(dataset, {source_url: url, page_type: 'detail', status: 'captured', jobs: [raw]}, base.id, 'new');
  const saved = r.dataset.jobs[base.id];
  assert.equal(saved.hiring_party.type, 'headhunter'); assert.equal(saved.jd, base.jd); assert.equal(saved.company, '');
  assert.equal(saved.company_check.state, 'not_required');
  assert.equal(saved.company_check.reason, 'headhunter_badge');
  assert.equal(saved.company_check.previous_check.state, 'needs_review');
  assert.equal(saved.quality_flags.includes('company_missing'), false);
  assert.equal(needsCompany(saved), false);
});
