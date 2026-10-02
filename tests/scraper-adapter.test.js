import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptScraper, mergeScraperJob, prepareScraperList} from '../local/scraper-adapter.mjs';
import {IntakeStore, analysisInput} from '../local/intake.mjs';
import {activityDisplay, activityReport} from '../local/activity-display.mjs';
const listAt='2026-09-30T10:00:00', detailAt='2026-09-30T10:10:00+08:00';
const raw=(id='abc',extra={})=>({title:'产品经理',salary:'20-30K·13薪',salary_source:'api',location:'深圳··',tags:'3-5年 | 本科',
 boss_name:'公司展示名',boss_title:'招聘经理',boss_active_status:'在线',company_scale:'100-499人',company_stage:'A轮',company_industry:'企业服务',
 job_labels:'B端 | 五险一金',skills:'PRD | SQL',welfare:'年终奖 | 五险一金',encrypt_job_id:id,encrypt_boss_id:'boss-id',encrypt_brand_id:'brand-id',
 job_link:`https://www.zhipin.com/job_detail/${id}.html`,company_link:'https://www.zhipin.com/gongsi/brand-id.html',
 security_id:'TEST_CONTEXT_NOT_SECRET',lid:'TEST_LID',job_id:'upstream-hash-'+id,is_new:true,...extra});
const detail=(r=raw(),extra={})=>({job_id:r.job_id,title:r.title,company:r.boss_name,salary:r.salary,salary_source:r.salary_source,
 location:r.location,boss_active_status:'刚刚活跃',tags_list:r.tags,job_link:r.job_link,link:r.job_link,
 skill_tags:['kanzhun','SQL'],jd:'负责产品需求分析和设计。'.repeat(25)+'\n认证资质\n人力资源服务许可证',...extra});
const input=(rows=[raw()],details=[detail(rows[0])],extra={})=>({list:{keyword:'产品经理',city:'深圳',filters:{},filter_desc:[],scraped_at:listAt,total:rows.length,jobs:rows},
 details,label:'测试',timezoneOffset:'+08:00',detailsObservedAt:detailAt,...extra});

test('波浪号真实结构回归；预处理隔离异常并保留正常行，不覆盖输入',()=>{
 const good=raw('synthetic-id~'),batch=input([good,{...good},null,raw('wrong',{encrypt_job_id:'other'}),raw('bad',{company_link:'broken'}),raw('blank',{title:''}),raw('x'),raw('x',{title:'另一岗位'})],[]).list;
 const before=JSON.stringify(batch),p=prepareScraperList(batch);
 assert.equal(p.list.jobs.length,1);assert.equal(p.duplicates,1);assert.equal(p.issues.length,6);
 assert.deepEqual(p.issues.map(x=>x.reason),['scraper_list_invalid_record','scraper_list_identity_mismatch','scraper_company_identity_conflict','scraper_list_empty_title','scraper_list_duplicate_conflict','scraper_list_duplicate_conflict']);
 assert.equal(JSON.stringify(batch),before);assert.ok(!JSON.stringify(p.issues).includes('TEST_CONTEXT'));
 assert.equal(adaptScraper({...input([good],[detail(good)]),list:p.list}).jobs[0].id,'boss:synthetic-id~');
 assert.throws(()=>adaptScraper(input([raw('bad',{job_link:'https://evil.example/job_detail/bad.html'})],[])),/scraper_list_invalid_link/);
});

test('全部源字段保留且按语义映射，平台ID而非散列去重',()=>{
 const source=input(),p=adaptScraper(source),j=p.jobs[0];
 assert.equal(j.id,'boss:abc');assert.equal(j.job_id,'abc');assert.equal(j.company,'公司展示名');assert.equal(j.recruiter_title,'招聘经理');
 assert.equal(j.recruiter_id,'boss-id');assert.equal(j.company_id,'brand-id');assert.equal(j.salary_source,'api');assert.equal(j.location,'深圳');
 assert.equal(j.company_scale,'100-499人');assert.equal(j.company_stage,'A轮');assert.equal(j.company_industry,'企业服务');
 assert.equal(j.experience,'3-5年');assert.equal(j.education,'本科');assert.deepEqual(j.skills,['PRD','SQL']);assert.ok(j.benefits.includes('五险一金'));
 assert.equal(j.jd.endsWith('许可证'),false);assert.ok(j.jd_raw.endsWith('许可证'));
 assert.deepEqual(j.scraper_source.list,source.list.jobs[0]);assert.deepEqual(j.scraper_source.detail,source.details[0]);
 assert.equal(j.last_seen_at,'2026-09-30T02:00:00.000Z');assert.equal(j.jd_observed_at,'2026-09-30T02:10:00.000Z');
 assert.equal(j.contact_status,'unknown');assert.equal(j.hiring_party,undefined);assert.equal(j.recruitment_signals.availability.value,'unknown');
 assert.equal(j.scraper_source.batch.total,1);assert.equal(j.is_new,undefined);
 assert.equal(j.recruiter_name,undefined);assert.equal(j.scraper_access.lid,'TEST_LID');
 assert.equal(activityDisplay(j).raw[0],'刚刚活跃');assert.match(activityReport(j),/批次时间/);
 const ai=JSON.stringify(analysisInput(j));assert.ok(ai.includes('企业服务'));assert.equal(ai.includes('TEST_CONTEXT'),false);assert.equal(ai.includes('boss-id'),false);
});

test('经验学历缺失不补不限，匿名公司不推断猎头，详情不伪造观察时间',()=>{
 const r=raw('a',{tags:'',boss_name:'某知名公司',boss_active_status:'',encrypt_brand_id:'',company_link:''});
 const j=adaptScraper(input([r],[detail(r)],{detailsObservedAt:null})).jobs[0];
 assert.equal(j.experience,'');assert.equal(j.education,'');assert.equal(j.company_name_kind,'anonymous_description');assert.equal(j.hiring_party,undefined);
 assert.equal(j.jd_observed_at,null);assert.equal(j.scraper_activity_observations.detail.checked_at,null);assert.equal(activityDisplay(j).state,'unknown');
 assert.ok(j.scraper_source.warnings.includes('detail_observation_time_not_provided'));
});

test('公司加密ID支持波浪号，仍校验链接域名和ID一致性',()=>{
 const id='4095028ee0ce8aeb33Z-3d65GA~~';
 const r=raw('abc',{encrypt_brand_id:id,company_link:`https://www.zhipin.com/gongsi/${id}.html`});
 assert.equal(adaptScraper(input([r],[])).jobs[0].company_url,r.company_link);
 assert.throws(()=>adaptScraper(input([raw('abc',{company_link:r.company_link})],[])),/company_identity/);
});

test('详情回退列表值不能伪装为新观察；不覆盖旧活跃/关闭/回复证据',()=>{
 const r=raw();const j=adaptScraper(input([r],[detail(r,{boss_active_status:'在线'})])).jobs[0];
 assert.equal(j.scraper_activity_observations.detail,undefined);assert.equal(activityDisplay(j).observed_at,j.last_seen_at);
 const old={...j,recruitment_signals:{checked_at:'2026-09-30T01:00:00Z',page_type:'detail',recruiter_activity:{raw:['本周活跃']},
   availability:{value:'explicit_unavailable'},recruiter_response:{raw:['回复及时']}}};
 const incoming=adaptScraper(input([raw('abc',{boss_active_status:''})],[],{detailsObservedAt:null})).jobs[0];
 const merged=mergeScraperJob(old,incoming);assert.deepEqual(merged.recruitment_signals,old.recruitment_signals);
 assert.equal(merged.scraper_activity_observations.list.recruiter_activity.raw[0],'在线');
});

test('缺失、重复、冲突身份和缺时区拒绝，孤立详情不能混入其他岗位',()=>{
 assert.throws(()=>adaptScraper(input([raw('abc',{encrypt_job_id:'other'})])),/identity/);
 assert.throws(()=>adaptScraper(input([raw(),raw()])),/identity/);
 assert.throws(()=>adaptScraper(input([raw()],[detail(raw(),{link:'https://www.zhipin.com/job_detail/other.html'})])),/identity/);
 assert.throws(()=>adaptScraper(input([raw()],[detail(raw(),{job_id:'wrong'})])),/identity/);
 assert.throws(()=>adaptScraper(input([raw()],[detail(raw(),{title:'销售总监'})])),/identity/);
 assert.throws(()=>adaptScraper(input([raw()],[detail(raw('other'))])),/orphan/);
 assert.throws(()=>adaptScraper(input([raw()],[],{timezoneOffset:undefined})),/timezone/);
 assert.throws(()=>adaptScraper(input([raw()],[],{detailsObservedAt:'2026-09-29T10:00:00Z'})),/before_list/);
 assert.throws(()=>adaptScraper(input([raw('abc',{company_link:'https://evil.example/gongsi/brand-id.html'})])),/company_identity/);
});

test('工程字段和人工记录不受新采集的默认值覆盖，缺JD和匿名公司不降级旧记录',()=>{
 const j=adaptScraper(input()).jobs[0];
 const old={...j,company:'已核实公司',location:'深圳·南山区·科技园',contact_status:'contacted',jd:'完整历史正文'.repeat(50),
   first_seen_at:'2026-09-01T00:00:00Z',seen_count:8,hiring_party:{type:'agency',evidence:[]},
   detail_review:{state:'needs_review'},company_check:{state:'found'},activity_check:{state:'needs_review'},link_access:{state:'unavailable'},
   custom_project_field:{keep:true},quality_flags:['custom_check']};
 const r=raw('abc',{boss_name:'某大型公司',salary:'',boss_active_status:'',company_scale:''});
 const incoming=adaptScraper(input([r],[],{detailsObservedAt:null,observationId:'next-batch'})).jobs[0];
 const merged=mergeScraperJob(old,incoming);
 for(const key of ['contact_status','first_seen_at','hiring_party','detail_review','company_check','activity_check','link_access','custom_project_field','quality_flags','jd','salary','company_scale'])assert.deepEqual(merged[key],old[key],key);
 assert.equal(merged.company,'已核实公司');assert.equal(merged.company_display_name,'某大型公司');assert.equal(merged.location,old.location);
 assert.equal(merged.seen_count,9);assert.equal(mergeScraperJob(merged,incoming).seen_count,9);
});

test('名称冲突隔离原业务数据；旧列表不能借较新详情时间覆盖薪资',()=>{
 const j=adaptScraper(input()).jobs[0];const conflict=mergeScraperJob({...j,title:'销售总监'},j);
 assert.equal(conflict.title,'销售总监');assert.equal(conflict.scraper_review.reason,'title_conflict');
 const old={...j,last_seen_at:'2026-09-30T03:00:00Z',salary:'40-50K',title_list_raw:'新观察标题'};
 const merged=mergeScraperJob(old,j);assert.equal(merged.salary,old.salary);assert.equal(merged.title_list_raw,old.title_list_raw);assert.equal(merged.last_seen_at,old.last_seen_at);
 const undated=adaptScraper(input([raw()],[detail(raw(),{jd:'不同的新正文'.repeat(100)})],{detailsObservedAt:null})).jobs[0];
 assert.equal(mergeScraperJob(old,undated).jd,old.jd);
});

test('正式接收接口原子去重、保留工程字段、跨数据集隔离、旧批次不回滚',()=>{
 const store=new IntakeStore(':memory:');try{
  const i=input();assert.equal(store.importScraper(i).added,1);assert.equal(store.importScraper(i).status,'already_imported');
  const before=store.get('测试','boss:abc');assert.equal(before.seen_count,1);
  const row={...before,contact_status:'contacted',custom_project_field:42};
  store.importPayload({schema_version:2,label:'测试',exported_at:'2026-09-30T02:11:00Z',jobs:[row]});
  const next=input([raw('abc',{salary:'25-35K'})],[],{detailsObservedAt:null});next.list.scraped_at='2026-09-30T10:20:00';
  const result=store.importScraper(next);assert.equal(result.added,0);assert.equal(result.updated,1);
  const saved=store.get('测试','boss:abc');assert.equal(saved.contact_status,'contacted');assert.equal(saved.custom_project_field,42);assert.equal(saved.jd,before.jd);assert.equal(saved.salary,'25-35K');
  assert.equal(saved.seen_count,2);assert.equal(saved.first_seen_at,before.first_seen_at);
  assert.equal(store.importScraper({...i,label:'另外的数据集'}).added,1);
  const older=input([raw('abc',{salary:'1K'})]);older.list.scraped_at='2026-09-28T10:00:00';older.detailsObservedAt=null;
  assert.equal(store.importScraper(older).older_skipped,1);assert.equal(store.get('测试','boss:abc').salary,'25-35K');
  // Older extension versions omit new fields; they must not erase adapter metadata.
  const {scraper_source,skills,...legacy}=saved;
  store.importPayload({schema_version:2,label:'测试',exported_at:'2026-09-30T04:00:00Z',jobs:[legacy]});
  assert.deepEqual(store.get('测试','boss:abc').skills,saved.skills);assert.deepEqual(store.get('测试','boss:abc').scraper_source,saved.scraper_source);
 }finally{store.close();}
});

test('列表后补同一批详情不增加发现次数，重导入不改分析指纹',()=>{
 const store=new IntakeStore(':memory:');try{
  store.importScraper(input([raw()],[],{detailsObservedAt:null}));
  assert.equal(store.db.prepare('SELECT reason FROM intake_analysis_queue').get().reason,'jd_not_readable');
  store.importScraper(input());assert.equal(store.get('测试','boss:abc').seen_count,1);
  assert.equal(store.db.prepare('SELECT state FROM intake_analysis_queue').get().state,'pending');
  const fingerprint=store.db.prepare('SELECT fingerprint FROM intake_analysis_queue').get().fingerprint;
  assert.equal(store.importScraper(input()).status,'already_imported');
  assert.equal(store.db.prepare('SELECT fingerprint FROM intake_analysis_queue').get().fingerprint,fingerprint);
 }finally{store.close();}
});
