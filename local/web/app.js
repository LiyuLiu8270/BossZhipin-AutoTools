'use strict';
const $=q=>document.querySelector(q),$$=q=>[...document.querySelectorAll(q)];
const labels={recommend:'岗位推荐',tasks:'采集与任务',profile:'我的资料',settings:'设置'};
const stages={new:'待评估',saved:'准备沟通',contacted:'已沟通',followup:'后续跟进',ignored:'暂不考虑'};
const states={pending:'等待分析',running:'分析中',completed:'已完成',retry:'等待重试',failed:'分析失败',deferred:'暂缓分析',activity_skipped:'活跃条件跳过'};
const activityGateReasons={historical_excluded:'仅有历史活跃记录，当前设置不处理历史标签。',outside_range:'已采集的 HR 活跃标签超出你设置的允许范围。',unknown_excluded:'活跃度未知或无法确定范围，当前设置不处理这类岗位。'};
const runtimeUnavailable='Codex 程序不可用，请检查 Codex 安装或显式路径配置；任务未发送到模型。';
function loadHrActivitySettings(){
  const p=state.settings.hrActivity||{enabled:false,maxDays:7,includeUnknown:true,includeHistorical:false};
  $('#hr-activity-enabled').checked=p.enabled;$('#hr-activity-days').value=p.maxDays;
  $('#hr-activity-unknown').checked=p.includeUnknown;$('#hr-activity-historical').checked=p.includeHistorical;
  syncHrActivityInputs();
}
function syncHrActivityInputs(){for(const id of ['days','unknown','historical'])$('#hr-activity-'+id).disabled=!$('#hr-activity-enabled').checked;}
function readHrActivitySettings(){return {enabled:$('#hr-activity-enabled').checked,maxDays:Number($('#hr-activity-days').value),includeUnknown:$('#hr-activity-unknown').checked,includeHistorical:$('#hr-activity-historical').checked};}
const contacts={unknown:'未知 · 待核对',not_contacted:'已确认未沟通',contacted:'已沟通'};
const replies={unknown:'回复未记录',waiting:'待回复',replied:'已回复',closed:'已结束'};
const jobStates={closed:'已关闭',unavailable:'链接不可用',unknown:'未确认关闭'};
const reasons={closed:'采集时提示岗位关闭',link_unavailable:'岗位链接不可用',jd_review:'JD 等待复查',jd_not_readable:'正文尚未采集完成'};
const errors={reload_required:'页面会话已失效，请刷新页面重新连接。',analysis_busy:'当前批次仍在分析，请暂停并等待它完成后再操作。',invalid_profile:'资料格式不完整，请检查目标、事实和能力边界。',invalid_settings:'请检查每日额度和关键词格式。',contact_stage_conflict:'已沟通或后续跟进阶段需要确认已发出沟通。',request_failed:'操作未完成。请检查输入或稍后重试。',job_not_found:'该岗位不存在或已经变化，请刷新列表。'};
let currentView='recommend',page=1,lastPage=1,state=null,profile=null,activeJob=null,toastTimer,listVersion=0,detailVersion=0;
let stateRequest=null,listAbort=null,lastListRevision=null,lastListRender=null;
const listFilters=['search','priority','stage','contact-filter','salary-filter','activity-filter','detail-filter','reply-filter','availability-filter'];
let openingSource=false;
let policyData=null,policyDirty=false,policyLoading=false,policySaving=false;
Object.assign(errors,{invalid_settings:'请检查每日任务额度、并发上限（1–16）、HR 活跃天数（0–3720）和关键词格式。',analysis_busy:'仍有模型任务在运行，请暂停补位并等待在途任务完成。'});
Object.assign(errors,{invalid_matching_policy:'匹配规则格式不正确，或超过长度限制；未保存。'});
errors.contact_reply_conflict='请先确认已发出沟通，再记录回复状态；未沟通只能选择“未记录”。';
Object.assign(errors,{invalid_job_link:'岗位链接无效，未打开。',job_open_busy:'已有岗位正在打开，请稍候。',job_open_uncertain:'打开操作未能确认，请先检查专用 Edge 是否已有新标签页，不要连续重试。',browser_unavailable:'专用 Edge 未能连接，请检查浏览器后重试。'});
Object.assign(errors,{collection_busy:'已有采集任务运行中，请等待完成或停止本轮。',collection_keywords_required:'请先添加并启用至少一个搜索关键词。',invalid_collection_settings:'请检查采集设置：间隔至少 15 分钟，搜索 1–20 页，每天详情上限为正整数。',detail_daily_limit:'今日详情额度已用完，请提高每天上限或明天再采；重复点击、重启不会重置额度。'});
Object.assign(errors,{resume_import_busy:'已有简历正在解析，请稍候。',resume_invalid_filename:'文件名无效，请使用普通 Word 文件名。',resume_docx_required:'目前支持 .docx；旧版 .doc 请先另存为 .docx。',resume_file_size:'文件为空或超过 10 MB，请检查所选文件。',resume_invalid_docx:'文件不是有效的 Word .docx，或文件已损坏；原资料未改变。',resume_archive_limit:'文档解压后过大或结构过于复杂，未导入。',resume_encrypted:'文档已加密，请另存为未加密的 .docx。',resume_macro_unsupported:'不支持含宏的文档，请另存为普通 .docx。',resume_no_text:'没有解析到可读文字，可能是扫描图片简历；未覆盖已有资料。',resume_text_limit:'文档文字过多，未导入。',resume_parse_timeout:'解析超时，原资料未改变，请检查文档后重试。',resume_parse_failed:'解析失败，原资料未改变。',resume_parser_unavailable:'本地解析组件不可用，请检查软件运行环境。'});
const collectionLabels={running:'采集中',completed:'本轮完成',partial:'本轮结束，部分记录待处理',failed:'采集失败',needs_attention:'需要人工处理',cancelled:'已停止',interrupted:'服务重启中断'};
const detailFailureLabels={shared_not_captured:'详情区未就绪',title_missing:'标题未加载',jd_missing:'正文未加载',jd_truncated:'正文疑似截断',upstream_parse_failed:'上游正文校验失败',page_loading:'页面未加载完成',jd_encoded_font:'正文包含无法识别的字体字符',jd_content_rejected:'正文包含登录或展开提示等无效内容',detail_not_readable:'正文未通过读取校验',capture_timeout:'详情读取超时',detail_failed:'详情读取异常'};
const collectionErrors={login_required:'登录已失效，请在专用 Edge 登录后恢复。',verification_required:'BOSS 要求验证，请人工完成后恢复。',detail_page_changed:'详情页跳转或身份不符，已暂停，请检查专用 Edge。',browser_unavailable:'专用浏览器连接失败，请检查 Edge。',no_search_response:'没有捕获到有效搜索响应，未当作零岗位成功。',search_response_error:'搜索响应异常，稍后重试。',collection_failed:'采集未完成，可重试。',service_restarted:'服务重启，已结束旧任务；剩余详情保留。',collection_timeout:'本次读取超时，已保存此前完成的数据。',cancelled:'已停止本轮；定时设置不变。'};
collectionLabels.daily_limit='今日详情额度已用完';collectionErrors.detail_daily_limit=errors.detail_daily_limit;
Object.assign(collectionErrors,{backfill_repeated_failure:'连续 3 个岗位读取失败，已暂停，未继续消耗后续队列。',capture_timeout:'页面读取超时',capture_not_readable:'页面尚未就绪或无法读取',backfill_parse_failed:'招聘者区块解析失败',bridge_failed:'采集桥接异常',detail_identity_conflict:'岗位身份冲突',backfill_merge_failed:'补采结果合并失败'});
function backfillProgress(r){
  const counters=r.activityCompletionVersion===1?`已完成·页面未展示 ${r.activityNotDisplayed||0} · 活跃待复查 ${r.activityMissing||0}（标签待识别 ${r.activityUnrecognized||0}） · 公司未补到 ${r.companyMissing||0}`:typeof r.activityMissing==='number'?`旧版统计·活跃标签未读到 ${r.activityMissing}（页面未展示 ${r.activityNotDisplayed||0} · 标签待识别 ${r.activityUnrecognized||0}） · 公司未补到 ${r.companyMissing||0}`:`历史记录：仍缺字段的岗位 ${r.unresolved}`;
  return `已处理 ${r.processed}/${r.detailTotal||0} · 活跃标签补到 ${r.activityFound} · ${counters} · 读取失败 ${r.failedDetails} · 待处理 ${r.remaining??Math.max(0,(r.detailTotal||0)-r.processed)}${r.lastError?' · 最近错误：'+(collectionErrors[r.lastError]||r.lastError):''}`;
}
Object.assign(collectionErrors,{scraper_list_identity_conflict:'旧版列表校验失败（可能为不支持的岗位 ID 字符），原始结果已保留。',scraper_list_invalid_record:'岗位记录格式异常',scraper_list_invalid_link:'岗位链接格式不支持',scraper_list_identity_mismatch:'岗位 ID 与链接不一致',scraper_list_empty_title:'岗位标题为空',scraper_list_duplicate_identity:'同批岗位 ID 重复',scraper_list_duplicate_conflict:'同一岗位 ID 返回不同内容',scraper_company_identity_conflict:'公司链接与 ID 不一致或格式异常'});
Object.assign(collectionErrors,{no_search_response:'搜索等待中出现无响应，已取得的数据保留；新版按警告继续其余关键词及详情，不将无响应视为零岗位。',search_page_changed:'搜索页离开预期路径，已暂停，请检查专用 Edge。'});
const searchReasons={request_not_observed:'未观察到搜索请求',request_failed:'搜索请求网络失败',http_error:'搜索接口 HTTP 异常',response_body_unreadable:'响应体无法读取或解析',response_not_consumed:'响应完成但未被捕获器接收',response_not_finished:'请求发出但响应未完成'};
const searchStops={keyword_time_budget:'达到单词总耗时上限',consecutive_no_response:'连续3次没有响应',upstream_early_exit:'上游提前结束',no_search_response:'未收到有效响应',explicit_end:'平台返回结束，但此前存在响应缺口',page_limit:'达到配置页数，但此前存在响应缺口'};
Object.assign(errors,{collection_resume_unavailable:'任务已变化或无可恢复断点，请刷新任务状态后重试。',collection_search_retry_unavailable:'没有可重试的不完整关键词。'});
function listProgress(r){
  const counts={};for(const batch of r.listIssues||[])for(const issue of batch.issues||[])counts[issue.reason]=(counts[issue.reason]||0)+1;
  const searches=r.searchDiagnostics||[],warnings=searches.flatMap(s=>(s.warnings||[]).map(w=>`${s.keyword} 第 ${w.page} 次响应等待：${searchReasons[w.reason]||w.reason}`));
  const partial=[...new Map(searches.map(s=>[s.keyword,s])).values()].filter(s=>s.partial||s.error==='no_search_response');
  return (r.listRejected?` · 列表异常隔离 ${r.listRejected} 条（${Object.entries(counts).map(([k,n])=>(collectionErrors[k]||k)+' '+n).join('；')}）`:'')+(r.listDuplicates?` · 同批完全重复合并 ${r.listDuplicates} 条`:'')+
    (r.searchWarnings?` · 搜索不完整 ${r.searchWarnings} 个关键词：${partial.map(s=>`${s.keyword}（${s.valid_responses??s.pages_observed??0}/${s.requested_pages||r.pages} 次有效响应，${searchStops[s.stop_reason]||collectionErrors[s.error]||s.stop_reason||'存在缺口'}）`).join('；')}；已保留结果${r.state==='running'?'，继续后续任务':''}`:'')+
    (warnings.length?' · '+warnings.slice(-3).join('；'):'')+
    (r.diagnosticVersion||searches.some(s=>s.debugFile)?` · Debug：local/data/collection/${r.id}/*-debug.jsonl`:'')+
    (r.debugWriteFailed?' · 警告：诊断日志写入失败，请检查磁盘空间和目录权限':'')+
    (r.trigger!=='backfill'&&r.unavailable?` · 确认关闭 ${r.unavailable} 条（不计详情成功或失败）`:'')+
    (r.trigger!=='backfill'&&r.failureReasons?` · 详情失败原因：${Object.entries(r.failureReasons).map(([reason,count])=>`${detailFailureLabels[reason]||collectionErrors[reason]||'其他读取失败'} ${count}`).join('；')}`:'');
}
let collectionFormLoaded=false;
function renderCollection(){
  const c=state.collection;if(!c){$('#collection-status').textContent='请重启服务以启用自动采集';return;}
  if(!collectionFormLoaded){for(const [key,id] of [['dataset','dataset'],['city','city'],['pages','pages'],['dailyDetailLimit','details'],['intervalMinutes','interval']])$('#collection-'+id).value=c.config[key];$('#collection-enabled').checked=c.config.enabled;collectionFormLoaded=true;}
  const r=c.active||c.history[0];$('#collection-status').textContent=c.running?'采集中':c.config.blocked?'等待人工恢复':c.config.enabled?'定时已开启':'定时未开启';
  $('#collection-start').disabled=c.running;$('#collection-backfill').disabled=c.running;$('#collection-stop').disabled=!c.running;$('#collection-retry').disabled=c.running;
  const budget=c.dailyDetails;
  $('#collection-detail-start').disabled=c.running||budget?.remaining===0||c.detailSummary?.pending===0;
  $('#collection-backfill').disabled=c.running||budget?.remaining===0;
  $('#collection-budget').textContent=budget?`今日详情已用 ${budget.used} / ${budget.limit} · 剩余 ${budget.remaining} · ${budget.day}（北京时间每天 0 点重置）。搜索后详情、立即采集详情及字段补采共享额度，普通失败重试计入；登录/验证暂停不计。`:'请刷新页面读取每日额度。';
  $('#collection-resume').disabled=c.running||!c.resumable;$('#collection-retry-search').disabled=c.running||!!c.resumable||!c.incompleteKeywords?.length;
  $('#collection-resume-help').textContent=c.resumable?.state==='daily_limit'?'今日额度已用完，剩余队列已保留。提高上限或北京时间次日后，可点“恢复上次任务”或“立即采集详情”。':c.resumable?`有可恢复任务${c.resumable.trigger==='backfill'?'：重新扫描剩余缺失字段。':'：跳过已完成的关键词，继续剩余详情；搜索中断则重搜当前词并去重。'}请完成专用 Edge 登录/验证后点“恢复上次任务”。不会自动清除门禁或重试验证。`:'“立即采集详情”不搜索，只处理当前可执行的待采详情，不改变搜索计划；“立即采集”搜索全部启用词后再采详情；两者共用每日额度。';
  $('#collection-progress').textContent=r?`${collectionLabels[r.state]||r.state} · ${r.phase==='search'?'搜索：'+r.keyword:r.phase==='details'?'读取详情：'+(r.jobTitle||''):''} 已识别 ${r.found} · 新增 ${r.added} · 详情成功 ${r.details}${r.detailTotal?' / '+r.detailTotal:''} · 失败 ${r.failedDetails}${r.error?'；'+(collectionErrors[r.error]||r.error):''}`:'尚未运行采集。先保存设置并添加关键词，再点击立即采集。';
  if(r?.trigger==='backfill')$('#collection-progress').textContent=`字段补采 · ${r.state==='partial'?'本轮已结束，部分字段待复查':collectionLabels[r.state]||r.state} · ${backfillProgress(r)} · 公司信息已解决 ${r.companyResolved} · 关闭 ${r.unavailable}${r.phase==='backfill'?' · '+(r.jobTitle||''):''}${r.error?'；'+(collectionErrors[r.error]||r.error):''}`;
  else if(r)$('#collection-progress').textContent+=listProgress(r);
  const ds=c.detailSummary;
  $('#collection-next').textContent=`${c.config.blocked?'定时已暂停：'+(collectionErrors[c.config.blocked]||c.config.blocked):c.config.enabled?'下次计划：'+date(c.config.nextRun):'定时未开启'} · ${ds?`可立即采集 ${ds.pending} · 等待重试 ${ds.waiting_retry}${ds.nextRetryAt?'（最早 '+date(ds.nextRetryAt)+'）':''} · 待人工检查 ${ds.review} · 未入队 ${ds.unqueued} · 无正文且已关闭 ${ds.closed} · 无正文且链接不可用 ${ds.unavailable}`:'详情状态待更新'}`;
  $('#collection-history').replaceChildren();for(const row of c.history){const tr=el('tr');for(const value of [date(row.startedAt)+' / '+(row.trigger==='details'?'仅采详情':row.trigger==='search_retry'?'补搜关键词':row.trigger==='backfill'?'字段补采':row.trigger==='scheduled'?'定时':'手动'),row.trigger==='backfill'&&row.state==='partial'?(row.activityCompletionVersion===1?'部分字段待复查':'旧版·部分标签未展示/待复查'):collectionLabels[row.state]||row.state,`${row.found} / ${row.added} / ${row.details}`,row.trigger==='backfill'?`${backfillProgress(row)}${row.error?'；'+(collectionErrors[row.error]||row.error):''}`:(collectionErrors[row.error]||row.error||(row.trigger==='details'?'仅采待补详情，不搜索关键词':row.keywords.join('、')))+listProgress(row)])tr.append(el('td',value));$('#collection-history').append(tr);}
}
$('#collection-form').addEventListener('submit',e=>{e.preventDefault();perform(async()=>{await api('collection/settings',{enabled:$('#collection-enabled').checked,dataset:$('#collection-dataset').value,city:$('#collection-city').value,pages:Number($('#collection-pages').value),dailyDetailLimit:Number($('#collection-details').value),intervalMinutes:Number($('#collection-interval').value)});collectionFormLoaded=false;await refreshState();toast('采集设置已保存。');});});
$('#collection-detail-start').addEventListener('click',()=>perform(async()=>{await api('collection/details',{});await refreshState();toast('已开始采集待补详情，不搜索关键词；达到每日额度后保留剩余队列。');}));
$('#collection-start').addEventListener('click',()=>perform(async()=>{await api('collection/start',{});await refreshState();toast('采集任务已启动，结果会自动入库并进入匹配队列。');}));
$('#collection-resume').addEventListener('click',()=>perform(async()=>{const id=state.collection?.resumable?.id;if(!id)return;$('#collection-resume').disabled=true;try{await api('collection/resume',{id});await refreshState();toast('已从保存的进度恢复，若仍需登录或验证会再次暂停。');}finally{$('#collection-resume').disabled=!!state.collection?.running||!state.collection?.resumable;}}));
$('#collection-retry-search').addEventListener('click',()=>perform(async()=>{const id=state.collection?.latestSearchId;if(!id)return;await api('collection/retry-search',{id});await refreshState();toast('已单独重试不完整关键词，已保存岗位按 ID 去重。');}));
$('#collection-backfill').addEventListener('click',()=>perform(async()=>{await api('collection/backfill',{});await refreshState();toast('缺失字段补采已启动，任务页会显示进度。');}));
$('#collection-stop').addEventListener('click',()=>perform(async()=>{await api('collection/stop',{});await refreshState();toast('已请求停止本轮，已入库的数据保留。');}));
$('#collection-retry').addEventListener('click',()=>perform(async()=>{await api('collection/retry',{});await refreshState();toast('失败详情已重新排队，下次采集将继续处理。');}));
function el(tag,text,className){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(className)n.className=className;return n;}
function button(text,fn){const b=el('button',text);b.type='button';b.addEventListener('click',()=>perform(fn));return b;}
function toast(text){const t=$('#toast');if($('#job-drawer').open)$('#job-drawer').append(t);else document.body.append(t);t.textContent=text;t.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{t.hidden=true;},4500);}
async function perform(fn){try{await fn();}catch(e){if(e.name!=='AbortError')toast(e.message||'操作失败，请重试。');}}
async function api(path,body,signal){
  const timeout=AbortSignal.timeout(['job/open','profile/resume'].includes(path)?90000:15000);
  const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Local-UI':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,timeout]):timeout});
  let data;try{data=await response.json();}catch(e){if(e.name==='AbortError')throw e;throw new Error('本地服务返回异常，请检查服务是否仍在运行。');}
  if(!response.ok)throw new Error(errors[data.error]||'请求未成功，请重试。');return data;
}
function date(value){return value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'未记录';}
function activityLines(a){
  if(!a||a.state==='unknown')return ['未知',a?.reason==='identity_conflict'?'岗位身份待核对，未采纳本次状态':a?.reason==='detail_not_checked'?'尚未完成详情状态采集':`${a?.reason==='not_displayed'?'招聘者区块已加载，页面未展示活跃标签':a?.reason==='label_unrecognized'?'存在尚未识别的活跃标签，待核查':'已检查，未读到标签'}${a?.latest_checked_at?' · '+date(a.latest_checked_at):''}`];
  const source={list:'列表页',detail:'详情页'}[a.page_type]||'来源未记录';
  return [`${a.state==='historical'?'历史记录':'采集记录'}：${a.raw.join(' / ')}`,`${a.time_precision==='batch'?'采集批次时间':'观察于'} ${date(a.observed_at)} · ${source}`,
    a.state==='historical'?`最新检查（${date(a.latest_checked_at)}）未读到标签`:'原文相对于观察时刻，不代表当前在线'];
}
function company(job){return job.company||({headhunter:'猎头 · 实际雇主待确认',agency:'代招 · 实际雇主待确认'}[job.hiring_type||job.hiring_party?.type]||'公司待确认');}
async function navigate(view){
  if(!labels[view])view='recommend';currentView=view;history.replaceState(null,'','#'+view);
  $$('.view').forEach(n=>n.hidden=n.id!=='view-'+view);$$('[data-view]').forEach(n=>{n.classList.toggle('active',n.dataset.view===view);if(n.dataset.view===view)n.setAttribute('aria-current','page');else n.removeAttribute('aria-current');});$('#crumb').textContent=labels[view];
  window.scrollTo({top:0});
  if(view==='profile')await loadProfile();else if(view==='settings'){await refreshState();$('#daily-limit').value=state.settings.dailyLimit;$('#model-concurrency').value=state.settings.modelConcurrency||1;$('#auto-analyze').checked=state.settings.autoAnalyze;loadHrActivitySettings();if(!policyData&&!policyLoading)await loadMatchingPolicy();}
  else if(view==='tasks'){await refreshState();renderKeywords();}else await loadJobs();
}
$$('[data-view]').forEach(b=>b.addEventListener('click',()=>perform(()=>navigate(b.dataset.view))));
$$('[data-goto]').forEach(b=>b.addEventListener('click',()=>perform(()=>navigate(b.dataset.goto))));
$('.brand').addEventListener('click',e=>{e.preventDefault();perform(()=>navigate('recommend'));});
window.addEventListener('hashchange',()=>perform(()=>navigate(location.hash.slice(1))));
function refreshState(){
  if(stateRequest)return stateRequest;
  stateRequest=readAndRenderState().finally(()=>{stateRequest=null;});return stateRequest;
}
async function readAndRenderState(){
  try{
    state=await api('state');$('#global-error').hidden=true;$('#connection').textContent='本地服务已连接';$('#connection').classList.add('good');
    const ac=state.activityCollection;
    $('#activity-collection').textContent=ac?`业务状态未知 ${ac.unknown} 条（不等于待采集） · 待首次补采 ${ac.pending} 条 · 已处理·页面未展示 ${ac.notDisplayed||0} 条 · 补采后待复查 ${ac.review} 条 · 已补到标签 ${ac.found} 条（未知不等于不活跃，可能包含关闭/链接不可用项）。`:'请重启本地服务以读取补采状态。';
    const running=state.busy?(state.settings.autoAnalyze?'模型任务运行中':'已暂停补位，等待在途任务完成'):state.settings.autoAnalyze?(state.status.runtime?.available===false?'Codex 程序不可用，待办已保留，等待运行环境恢复':state.status.daily_used>=state.status.daily_limit?'今日额度已用完':'自动分析已开启'):'自动分析已暂停';
    $('#analysis-brief').textContent=running;$('#worker-status').textContent=running;
    $('#toggle-analysis').textContent=state.settings.autoAnalyze?'暂停后续分析':'开启自动匹配';
    $('#budget').textContent=`今日模型任务 ${state.status.daily_used} / ${state.status.daily_limit} 次（匹配、招呼和重试均计入） · 暂缓 ${state.status.deferred} 条`;
    const active=state.status.active_stages||{matching:0,greeting:0};$('#model-concurrency-status').textContent=`并发占用 ${active.matching+active.greeting} / ${state.settings.modelConcurrency||1} · 匹配 ${active.matching} · 招呼 ${active.greeting}`;
    const hp=state.settings.hrActivity;$('#hr-activity-status').textContent=hp?.enabled?`HR 活跃条件：${hp.maxDays===0?'仅在线 / 刚刚活跃':hp.maxDays+'天内及更近期'} · 未知${hp.includeUnknown?'仍处理':'跳过'} · 仅历史标签${hp.includeHistorical?'按范围判断':'跳过'}。按采集时标签判断；放宽条件可恢复，已有结果保留。`:'HR 活跃条件未开启；可在设置中自行定义不活跃范围。';
    $('#greeting-queue-states').replaceChildren();for(const name of ['pending','running','completed','retry','failed','activity_skipped']){const line=el('div',undefined,'status-row');line.append(el('span',states[name].replace('分析','生成')),el('b',String(state.status.greeting_states?.find(s=>s.state===name)?.count||0)));$('#greeting-queue-states').append(line);}
    $('#queue-states').replaceChildren();for(const name of ['pending','running','completed','retry','failed','activity_skipped']){const line=el('div',undefined,'status-row');line.append(el('span',states[name]),el('b',String(state.status.states.find(s=>s.state===name)?.count||0)));$('#queue-states').append(line);}
    const datasets=state.datasets.map(d=>d.dataset),existing=[...$('#dataset').options].slice(1).map(o=>o.value);
    if(JSON.stringify(datasets)!==JSON.stringify(existing)){const chosen=$('#dataset').value;$('#dataset').replaceChildren(new Option('全部数据集',''),...datasets.map(d=>new Option(d,d)));if(datasets.includes(chosen))$('#dataset').value=chosen;}
    const activityChoices=state.activityFilterOptions||[['','全部活跃状态'],['state:unknown','未知 / 未采到'],['state:historical','仅历史记录'],...(state.activityFilterLabels||[]).map(label=>['label:'+label,label])];
    const activitySelect=$('#activity-filter'),chosenActivity=activitySelect.value;
    if(chosenActivity&&!activityChoices.some(([value])=>value===chosenActivity))activityChoices.push([chosenActivity,chosenActivity.slice(6)+'（本次无记录）']);
    if(JSON.stringify([...activitySelect.options].map(o=>[o.value,o.text]))!==JSON.stringify(activityChoices)){activitySelect.replaceChildren(...activityChoices.map(([value,label])=>new Option(label,value)));activitySelect.value=chosenActivity;}
    renderCollection();if(currentView==='tasks')renderKeywords();
  }catch(e){$('#connection').textContent='本地服务连接异常';$('#connection').classList.remove('good');$('#global-error').textContent='未能读取最新状态。保留的内容可能已过期，请确认本地服务正在运行后刷新。';$('#global-error').hidden=false;throw e;}
}
function priorityBadge(value){return el('span',value||'尚无匹配结果','priority '+(value==='优先沟通'?'high':value==='可以尝试'?'medium':''));}
function renderSummary(s){
  const o=s.overview;
  $('#count-job-closed').textContent=o?.terminal??'—';$('#count-awaiting').textContent=o?.awaiting??'—';
  $('#summary-awaiting').hidden=!o?.awaiting;$('#awaiting-plus').hidden=!o?.awaiting;
  $('#summary-job-closed').title=o?`已关闭 ${o.closed} ＋ 链接不可用 ${o.unavailable}；不可用不等于确认停招。已关闭岗位即使已有正文，也仅计在这里。`:'已关闭＋链接不可用；不可用不等于确认停招。';
  const d=s.detailCounts;
  $('#detail-breakdown').textContent=d?`已保留正文 ${s.details} 条（含关闭岗位的历史正文）。可立即采集 ${d.pending} · 等待重试 ${d.waiting_retry} · 待人工检查 ${d.review} · 未入队 ${d.unqueued}。关闭／不可用项不重复计入上方“已采集”，正文不会删除。`:'详情状态分布待更新';
  $('#count-total').textContent=s.total;$('#count-details').textContent=o?.collected??'—';$('#count-contacted').textContent=s.contacted;$('#count-waiting').textContent=s.waiting;
  for(const [id,key] of [['priority','优先沟通'],['try','可以尝试'],['low','低优先级'],['mismatch','不匹配'],['pending','pending']])$('#count-'+id).textContent=s.priorities[key];
  const active=listFilters.filter(id=>$('#'+id).value),single=(id,value)=>active.length===1&&$('#'+id).value===value;
  for(const b of $$('[data-summary]')){const key=b.dataset.summary;const selected=key==='total'?active.length===0:key==='details'?active.length===2&&$('#detail-filter').value==='ready'&&$('#availability-filter').value==='unknown':key==='job-closed'?single('availability-filter','terminal'):key==='awaiting'?single('detail-filter','unfinished'):key==='contacted'?single('contact-filter','contacted'):key==='waiting'?single('reply-filter','waiting'):single('priority',key);b.setAttribute('aria-pressed',String(selected));}
}
$$('[data-summary]').forEach(b=>b.addEventListener('click',()=>perform(async()=>{
  clearTimeout(debounce);for(const id of listFilters)$('#'+id).value='';
  const key=b.dataset.summary;if(key==='details'){$('#detail-filter').value='ready';$('#availability-filter').value='unknown';}else if(key==='job-closed')$('#availability-filter').value='terminal';else if(key==='awaiting')$('#detail-filter').value='unfinished';else if(key==='contacted')$('#contact-filter').value='contacted';else if(key==='waiting')$('#reply-filter').value='waiting';else if(key!=='total')$('#priority').value=key;
  page=1;await loadJobs();
})));
async function loadJobs(){
  listAbort?.abort();listAbort=new AbortController();
  const version=++listVersion,params=new URLSearchParams({page,q:$('#search').value,priority:$('#priority').value,stage:$('#stage').value,contact:$('#contact-filter').value,dataset:$('#dataset').value,sort:$('#sort').value,salary:$('#salary-filter').value,activity:$('#activity-filter').value,detail:$('#detail-filter').value,reply:$('#reply-filter').value,availability:$('#availability-filter').value});
  const data=await api('jobs?'+params,undefined,listAbort.signal);if(version!==listVersion)return;page=data.page;lastPage=data.pages;lastListRevision=data.revision;
  const renderKey=params.toString()+'|'+JSON.stringify(data);if(renderKey===lastListRender)return;lastListRender=renderKey;
  renderSummary(data.summary);
  $('#jobs').replaceChildren();$('#list-empty').hidden=data.total>0;
  if(!data.total){$('#list-empty h2').textContent=state?.total?'没有符合当前条件的岗位':'这里还没有岗位';$('#list-empty p').textContent=state?.total?'调整搜索词或筛选条件后再看看。':'连接采集器或导入采集 JSON 后，岗位会进入这个列表。';}
  for(const job of data.items){
    const tr=el('tr'),a=el('td'),title=button(job.title,()=>openJob(job.dataset,job.id));title.className='job-title';a.append(title,el('span',company(job),'secondary'));if(job.hiring_type==='headhunter'||job.hiring_type==='agency')a.append(el('span',job.hiring_type==='headhunter'?'猎头招聘':'代招','secondary'));
    a.append(el('span',`岗位状态：${jobStates[job.job_state]||jobStates.unknown}`,job.job_state==='closed'?'priority':'secondary'));
    const b=el('td');b.append(el('span',job.salary||'薪资未记录'),el('span',job.location||'地区未记录','secondary'));
    const c=el('td');c.append(priorityBadge(job.priority),el('span',job.reason?reasons[job.reason]||job.reason:states[job.analysis_state],'secondary'));
    const d=el('td');d.append(el('span',stages[job.stage]),el('span',contacts[job.contact_status]||'沟通状态待核对','secondary'));
    if(job.contact_status==='contacted')d.append(el('span',replies[job.reply_status]||replies.unknown,'secondary'));
    const e=el('td'),activity=activityLines(job.activity_display);e.append(el('span',activity[0]),el('span',activity[1],'secondary'));e.title=activity.join('\n');
    if(job.activity_display?.state==='historical')e.append(el('span','最新采集未读到标签','secondary'));
    if(job.availability==='explicit_unavailable')e.append(el('span','采集时岗位已关闭','secondary'));
    const f=el('td'),open=button('查看 →',()=>openJob(job.dataset,job.id));open.className='detail-button';f.append(open);tr.append(a,b,c,d,e,f);$('#jobs').append(tr);
  }
  $('#page-summary').textContent=`共 ${data.total} 个岗位 · 第 ${page} / ${lastPage} 页`;$('#prev').disabled=page<=1;$('#next').disabled=page>=lastPage;
}
let debounce;$('#search').addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(()=>{page=1;perform(loadJobs);},250);});
for(const id of ['dataset','priority','stage','contact-filter','sort','salary-filter','activity-filter','detail-filter','reply-filter','availability-filter'])$('#'+id).addEventListener('change',()=>{page=1;perform(loadJobs);});
$('#prev').addEventListener('click',()=>{page--;perform(loadJobs);});$('#next').addEventListener('click',()=>{page++;perform(loadJobs);});
function showTab(name){$$('[data-tab]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.tab===name)));for(const t of ['match','jd','record'])$('#tab-'+t).hidden=t!==name;}
$$('[data-tab]').forEach(b=>b.addEventListener('click',()=>showTab(b.dataset.tab)));
async function openJob(dataset,id){
  const version=++detailVersion,r=await api('job?'+new URLSearchParams({dataset,id}));if(version!==detailVersion)return;activeJob=r;
  $('#drawer-title').textContent=r.job.title;$('#drawer-meta').textContent=[company(r.job),r.job.salary,r.job.location].filter(Boolean).join(' · ');$('#drawer-dataset').textContent='数据集：'+r.dataset;
  const availability=r.job.recruitment_signals?.availability;
  $('#drawer-job-state').textContent=`岗位状态：${jobStates[r.job_state]||jobStates.unknown}${r.job_state==='closed'?` · 确认时间：${date(r.job.recruitment_signals.checked_at)} · 依据：${(availability?.raw||[]).join('；')}。已存正文与沟通记录保留；不再进入普通详情采集和匹配。`:r.job_state==='unavailable'?'；链接不可用不等于岗位关闭。':'；未观察到关闭证据，不保证当前仍在招聘。'}`;
  const safe=/^https:\/\/www\.zhipin\.com\/job_detail\/[a-zA-Z0-9_-]+\.html(?:\?[^\s]*)?$/.test(r.job.url||'');$('#source-link').hidden=!safe;$('#copy-source-link').hidden=!safe;$('#source-link').disabled=openingSource;
  $('#source-open-status').textContent='复用采集器专用 Edge 的登录态；若登录已过期，仍需在该窗口重新登录。';
  const content=$('#match-content');content.replaceChildren();
  if(r.result){
    content.append(priorityBadge(r.result.priority),el('p',r.result.reason,'drawer-summary'),el('h3','匹配依据'));
    for(const item of r.result.evidence){const block=el('div',undefined,'evidence');block.append(el('b',item.relation),el('blockquote','JD：'+item.jd_quote),el('p',`${item.fact_id} · ${r.facts[item.fact_id]||'事实待核对'}`));content.append(block);}
    for(const [title,values] of [['能力缺口 / 风险',r.result.gaps],['建议向招聘者确认',r.result.questions]]){content.append(el('h3',title));const ul=el('ul',undefined,'bullet-list');for(const v of values||[])ul.append(el('li',v));if(!ul.children.length)ul.append(el('li','未列出，仍需人工核实'));content.append(ul);}
    content.append(el('p',`分析时间：${date(r.analyzed_at)} · 模型建议仍需人工核实。`,'help'));
  }else content.append(el('h3',states[r.analysis_state]||'尚无匹配结果'),el('p',r.analysis_state==='activity_skipped'?(activityGateReasons[r.activity_gate?.reason]||'被 HR 活跃条件跳过。'):reasons[r.reason]||(r.error?`最近失败原因：${r.error}`:'开启自动匹配后，已采集的可读 JD 会按队列分析。资料更新后，旧分析不会作为当前结果显示。'),'description'));
  if(r.analysis_state==='activity_skipped'||r.greeting_state==='activity_skipped')content.append(el('p','岗位和已有结果保留。前往“设置 → 分析与运行”放宽 HR 活跃条件即可恢复处理。','help'));
  $('#jd-text').textContent=r.job.jd||'尚未采集到可读 JD。';
  $('#signals').textContent=`招聘者活跃：${activityLines(r.activity_display).join('\n')}\n首次发现：${date(r.job.first_seen_at)}（不是发布日期）\n岗位状态：${jobStates[r.job_state]||jobStates.unknown}`;
  $('#signals').classList.add('prose');
  $('#contact-notice').textContent=r.contact_status==='contacted'?'这个岗位已记录沟通，避免重复打招呼。':r.contact_status==='unknown'?'沟通状态未知，请先核对 BOSS 消息历史。':'已人工确认未沟通，发送前仍请检查最新状态。';
  $('#greeting').value=r.contact_status==='contacted'?'已沟通，不再推荐重复发送。':r.result?.greeting||({activity_skipped:'招呼生成被 HR 活跃条件跳过；匹配结果保留，放宽条件后可继续。',pending:'匹配结论已固定，招呼等待生成。',running:'匹配结论已固定，正在生成招呼。',retry:'招呼生成暂未成功，等待重试；匹配结果保留。',failed:'招呼未通过核查或生成失败，请检查后在任务页重试；匹配结果保留。',not_required:'该匹配档位不生成招呼。'}[r.greeting_state]||'等待完成匹配。');$('#copy-greeting').disabled=r.contact_status==='contacted'||!r.result?.greeting;
  $('#action-stage').value=r.stage;$('#action-contact').value=r.contact_status in contacts?r.contact_status:'unknown';$('#action-note').value=r.note;
  $('#action-reply').value=r.reply_status||'unknown';$('#action-reply').disabled=r.contact_status!=='contacted';
  showTab('match');if(!$('#job-drawer').open){document.body.classList.add('drawer-open');$('#job-drawer').showModal();}$('#job-drawer').scrollTop=0;
}
$('#close-drawer').addEventListener('click',()=>$('#job-drawer').close());
$('#job-drawer').addEventListener('click',e=>{if(e.target===$('#job-drawer')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
$('#job-drawer').addEventListener('close',()=>{document.body.classList.remove('drawer-open');document.body.append($('#toast'));perform(async()=>{await refreshState();await loadJobs();});});
async function copy(text){if(!text.trim())throw new Error('没有可复制的内容。');try{await navigator.clipboard.writeText(text);toast('已复制；未发送任何消息。');}catch{throw new Error('浏览器未允许复制，请选中文本后手动复制。');}}
$('#source-link').addEventListener('click',()=>perform(async()=>{
  if(openingSource||!activeJob)return;
  const target=activeJob;openingSource=true;$('#source-link').disabled=true;$('#source-open-status').textContent='正在专用 Edge 打开新标签页，请稍候…';
  try{
    const r=await api('job/open',{dataset:target.dataset,id:target.id});
    const messages={detail_visible:'已在专用 Edge 打开，并读到岗位描述。请切换到 Edge 查看最新信息或沟通。',login_required:'已打开专用 Edge，但登录已过期或页面要求登录。请在该窗口登录后查看。',verification_required:'已打开专用 Edge，BOSS 要求安全验证，请在该窗口手动处理。',page_changed:'已打开专用 Edge，但页面发生跳转。可能是链接参数失效或岗位变化，请检查该标签页；本地岗位原文仍保留。',unverified:'已在专用 Edge 新建标签页，暂未确认岗位描述加载完成。请在 Edge 查看；若要求登录或验证，请手动处理。'};
    if(activeJob?.id===target.id&&activeJob?.dataset===target.dataset){
      const message=(messages[r.page_state]||messages.unverified).replace('请切换到 Edge 查看最新信息或沟通。','可在 Edge 查看最新信息或沟通。');
      $('#source-open-status').textContent=message+(r.foregrounded?' 已将岗位窗口切到前台。':' 岗位已打开，但系统未确认窗口已切到前台，请从任务栏切换到 Edge。');
    }
  }catch(e){if(activeJob?.id===target.id&&activeJob?.dataset===target.dataset)$('#source-open-status').textContent=e.name==='TimeoutError'?'请求超时，可能已打开标签页。请先检查专用 Edge，再决定是否重试。':e.message;throw e;}
  finally{openingSource=false;$('#source-link').disabled=false;}
}));
$('#copy-source-link').addEventListener('click',()=>perform(()=>copy(new URL(activeJob.job.url).origin+new URL(activeJob.job.url).pathname)));
$('#copy-greeting').addEventListener('click',()=>perform(()=>copy($('#greeting').value)));
function syncReplyInput(){const contact=$('#action-contact').value,reply=$('#action-reply');if(contact!=='contacted'){reply.value='unknown';reply.disabled=true;}else{if(reply.disabled&&activeJob?.contact_status!=='contacted')reply.value='waiting';reply.disabled=false;}}
$('#action-stage').addEventListener('change',()=>{if(['contacted','followup'].includes($('#action-stage').value))$('#action-contact').value='contacted';syncReplyInput();});
$('#action-contact').addEventListener('change',()=>{if($('#action-contact').value==='contacted'&&$('#action-stage').value==='new')$('#action-stage').value='contacted';syncReplyInput();});
$('#action-form').addEventListener('submit',e=>{e.preventDefault();perform(async()=>{
  const value={dataset:activeJob.dataset,id:activeJob.id,stage:$('#action-stage').value,contact:$('#action-contact').value,reply:$('#action-reply').value,note:$('#action-note').value};
  await api('action',value);await openJob(value.dataset,value.id);await loadJobs();showTab('record');toast('记录已保存到本地；没有发送消息。');
});});
async function saveSettings(changes){const fresh=await api('state');await api('settings',{...fresh.settings,...changes});await refreshState();}
$('#toggle-analysis').addEventListener('click',()=>perform(async()=>{await refreshState();await saveSettings({autoAnalyze:!state.settings.autoAnalyze});toast(state.settings.autoAnalyze?'自动匹配已开启。':'已暂停补位，所有在途任务会自然完成。');}));
$('#retry').addEventListener('click',()=>perform(async()=>{const r=await api('retry',{});await refreshState();if(currentView==='recommend')await loadJobs();toast(r.requeued?.total?`已移回等待队列：匹配 ${r.requeued.matching} 条、招呼 ${r.requeued.greeting} 条。${state.settings.autoAnalyze?'自动匹配会继续处理。':'开启自动匹配后执行。'}`:'没有需要重新排队的失败或待重试任务。');}));
$('#refresh-tasks').addEventListener('click',()=>perform(refreshState));
async function updateKeywords(fn){const fresh=await api('state'),keywords=fn(fresh.settings.keywords);await api('settings',{...fresh.settings,keywords});await refreshState();}
async function addKeyword(word){word=word.trim();if(!word)throw new Error('请先填写关键词。');await updateKeywords(words=>words.some(k=>k.text===word)?words:[...words,{text:word,enabled:true}]);toast('关键词已加入，下次采集使用。');}
function renderKeywords(){
  if(!state)return;$('#keyword-list').replaceChildren();for(const k of state.settings.keywords){const box=el('div',undefined,'keyword'+(k.enabled?'':' off'));box.append(el('span',k.text),button(k.enabled?'停用':'启用',()=>updateKeywords(words=>words.map(w=>w.text===k.text?{...w,enabled:!w.enabled}:w))),button('删除',()=>updateKeywords(words=>words.filter(w=>w.text!==k.text))));$('#keyword-list').append(box);}if(!state.settings.keywords.length)$('#keyword-list').append(el('p','还没有搜索关键词。','help'));
  $('#keyword-suggestions').replaceChildren();for(const word of state.suggestions){const box=el('div',undefined,'keyword');box.append(el('span',word),button('加入',()=>addKeyword(word)));$('#keyword-suggestions').append(box);}if(!state.suggestions.length)$('#keyword-suggestions').append(el('p','分析结果产生后，这里会显示尚未加入的建议词。','help'));
}
$('#keyword-form').addEventListener('submit',e=>{e.preventDefault();perform(async()=>{await addKeyword($('#keyword-input').value);$('#keyword-input').value='';});});
$('#copy-keywords').addEventListener('click',()=>perform(()=>copy(state.settings.keywords.filter(k=>k.enabled).map(k=>k.text).join('\n'))));
let resumeDocument=null,resumeImporting=false,resumeInsights=null;
Object.assign(errors,{resume_required:'请先导入 Word 简历。',resume_only:'已切换为简历全文，请通过 Word 导入更新资料。',resume_changed:'简历已经变化，请刷新后重新分析。',insight_busy:'已有简历分析正在运行，请稍候。'});
const insightErrors={codex_timeout:'Codex 响应超时，可手动重试。',codex_network_unavailable:'模型网络不可用，请检查服务运行环境。',codex_turn_failed:'模型调用失败，可稍后重试。',codex_no_valid_completion:'未收到有效结果，未同步关键词。',codex_start_failed:'无法启动 Codex，请检查本机配置。',insight_invalid:'模型输出格式不符合要求，未同步关键词。',insight_evidence_invalid:'原文引文校验未通过，未采纳结果或同步关键词。',resume_changed:'分析期间简历已变化，结果未应用。',resume_too_long:'全文超过本次分析支持的长度，未截断或发送。',service_restarted:'服务重启打断了分析，请手动重试。'};
insightErrors.codex_binary_unavailable=runtimeUnavailable;
function updateResumeButtons(){for(const id of ['resume-roles','resume-score'])$('#'+id).disabled=!resumeDocument||resumeImporting||!!resumeInsights?.running;}
function insightEvidence(container,evidence){for(const e of evidence||[]){const q=el('blockquote',e.block_id+' · '+e.quote);container.append(q);}}
function renderInsights(value){
  resumeInsights=value;updateResumeButtons();
  $('#resume-ai-status').textContent=value.running?`${value.active.kind==='roles'?'岗位解析':'简历评分'}运行中，完成后会自动保存；你可以离开此页。`:resumeDocument?'可点击按钮开始。结果以当前简历版本为准。':'请先导入简历。';
  for(const kind of ['roles','score']){
    const run=value[kind],panel=$('#resume-'+kind+'-panel'),area=$('#resume-'+kind+'-result');panel.hidden=!run;area.replaceChildren();if(!run)continue;
    area.append(el('p',`开始：${date(run.started_at)}${run.finished_at?' · 结束：'+date(run.finished_at):''}`,'help'));
    if(run.state!=='completed'){area.append(el('p',run.state==='running'?'Codex 正在分析简历全文…':insightErrors[run.error]||'未能完成，可点击按钮重试。','notice'));continue;}
    const r=run.result;area.append(el('p',r.summary,'description'));
    if(kind==='roles'){
      area.append(el('p',`已同步新增：${run.sync?.added.join('、')||'无'}；已有词保留原状态：${run.sync?.existing.join('、')||'无'}${run.sync?.skipped.length?'；关键词达到上限，未加入：'+run.sync.skipped.join('、'):''}`,'notice'));
      for(const role of r.roles){const item=el('div',undefined,'evidence');item.append(el('h3',role.keyword+' · '+role.fit),el('p',role.reason));insightEvidence(item,role.evidence);if(role.gaps.length)item.append(el('p','待补齐／核实：'+role.gaps.join('；')));area.append(item);}
      area.append(button('查看采集搜索关键词',()=>navigate('tasks')));
    }else{
      area.append(el('p',`内容诊断参考分：${r.total} / 100`,'resume-score-total'));
      for(const d of r.dimensions){const item=el('div',undefined,'evidence');item.append(el('h3',value.dimensions[d.id]+' · '+d.score+' / 20'),el('p',d.reason));insightEvidence(item,d.evidence);area.append(item);}
      area.append(el('h3','简历亮点'));const ul=el('ul',undefined,'bullet-list');for(const s of r.strengths)ul.append(el('li',s));area.append(ul);
      area.append(el('h3','优先改进建议'));for(const i of r.improvements){const item=el('div',undefined,'evidence');item.append(el('b',i.issue),el('p',i.action));insightEvidence(item,i.evidence);area.append(item);}
    }
    const ul=el('ul',undefined,'bullet-list');for(const v of r.limitations)ul.append(el('li',v));area.append(el('h3','判断边界'),ul);
  }
}
async function refreshInsights(){renderInsights(await api('profile/insights'));}
for(const kind of ['roles','score'])$('#resume-'+kind).addEventListener('click',()=>perform(async()=>{
  if(!resumeDocument||resumeInsights?.running||resumeImporting)return;
  $('#resume-roles').disabled=true;$('#resume-score').disabled=true;
  try{await api('profile/insights',{kind,resume_id:resumeDocument.id});await refreshInsights();}finally{updateResumeButtons();}
}));
function renderResume(doc){
  resumeDocument=doc;$('#resume-original').disabled=!doc||resumeImporting;
  $('#resume-state').textContent=doc?'已保存 · 当前匹配依据':'尚未导入';updateResumeButtons();
  $('#resume-meta').textContent=doc?`${doc.filename} · ${(doc.bytes/1024).toFixed(1)} KB · ${date(doc.imported_at)} · ${doc.stats.characters.toLocaleString()} 字符 · ${doc.stats.paragraphs} 段 · ${doc.stats.tables} 个表格`:'导入后，可在这里核对解析内容。';
  $('#resume-warnings').replaceChildren();for(const warning of doc?.warnings||[])$('#resume-warnings').append(el('li',warning));
  const area=$('#resume-preview');area.replaceChildren();if(!doc){area.append(el('p','尚无 Word 简历，请先导入；不会回退到旧摘要匹配。','help'));return;}
  let source='';for(const block of doc.blocks){
    if(block.source!==source){source=block.source;area.append(el('h3',source==='body'?'正文':source.startsWith('header')?'页眉':source.startsWith('footer')?'页脚':source.includes('textbox')?'文本框':source.startsWith('footnote')?'脚注':source.startsWith('endnote')?'尾注':source));}
    if(block.type==='table'){
      const wrapper=el('div',undefined,'resume-table'),table=el('table'),body=el('tbody');
      for(const row of block.rows){const tr=el('tr');for(const cell of row)tr.append(el('td',cell));body.append(tr);}table.append(body);wrapper.append(table);area.append(wrapper);
    }else area.append(el('p',block.text,'resume-paragraph'));
  }
}
async function loadProfile(){
  const saved=await api('profile/resume');renderResume(saved.document);await refreshInsights();
}
$('#resume-import').addEventListener('click',()=>perform(async()=>{
  if(resumeImporting)return;
  const file=$('#resume-file').files[0];if(!file)throw new Error('请先选择 Word 简历。');
  if(!/\.docx$/i.test(file.name))throw new Error(errors.resume_docx_required);
  if(!file.size||file.size>10*1024*1024)throw new Error(errors.resume_file_size);
  resumeImporting=true;updateResumeButtons();$('#resume-import').disabled=true;$('#resume-file').disabled=true;$('#resume-original').disabled=true;$('#resume-feedback').textContent='正在本地解析并保存，请稍候…';
  try{
    const base64=await new Promise((ok,no)=>{const reader=new FileReader();reader.onload=()=>ok(String(reader.result).split(',')[1]);reader.onerror=()=>no(new Error('无法读取文件，请重新选择。'));reader.readAsDataURL(file);});
    const result=await api('profile/resume',{filename:file.name,base64});renderResume(result.document);
    await refreshInsights();await refreshState();$('#resume-feedback').textContent=result.status==='already_saved'?'已显示该文件的解析全文，并用作匹配依据。':'原 Word 与解析全文已保存，后续匹配将以这份简历为准。';toast('简历已保存并更新匹配依据。');
  }catch(e){$('#resume-feedback').textContent=e.name==='TimeoutError'?'请求超时，保存结果尚未确认。请重新进入“我的资料”核对后再决定是否重试。':e.message;throw e;}
  finally{resumeImporting=false;updateResumeButtons();$('#resume-import').disabled=false;$('#resume-file').disabled=false;$('#resume-original').disabled=!resumeDocument;}
}));
$('#resume-original').addEventListener('click',()=>perform(async()=>{
  if(!resumeDocument)return;const r=await fetch('/api/profile/resume/original',{headers:{'X-Local-UI':'1'}});if(!r.ok)throw new Error('原文件读取失败，请刷新后重试。');
  const url=URL.createObjectURL(await r.blob()),a=el('a');a.href=url;a.download=resumeDocument.filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}));
function policyDraft(){return {matchingSkill:$('#matching-skill').value.replace(/\r\n?/g,'\n').trim(),greetingStyle:$('#greeting-style').value.replace(/\r\n?/g,'\n').trim()};}
function policyChanged(){policyDirty=JSON.stringify(policyDraft())!==JSON.stringify(policyData?.policy);$('#policy-status').textContent=policyDirty?'有未保存修改，尚未影响模型。':'当前已保存 · 匹配 '+policyData.version.slice(0,8)+' · 招呼 '+(policyData.greetingVersion||'').slice(0,8);}
function showMatchingPolicy(data){
  policyData=data;$('#matching-skill').value=data.policy.matchingSkill;$('#greeting-style').value=data.policy.greetingStyle;
  $('#matching-skill').maxLength=data.limits.matchingSkill;$('#greeting-style').maxLength=data.limits.greetingStyle;
  $('#greeting-preset').replaceChildren(new Option('选择一个风格预设',''),...data.presets.map(p=>new Option(p.name,p.id)));
  policyChanged();
}
async function loadMatchingPolicy(){
  if(policyLoading||policySaving)return;
  policyLoading=true;$('#policy-fields').disabled=true;$('#reload-matching-policy').disabled=true;$('#policy-status').textContent='正在读取匹配规则…';
  try{showMatchingPolicy(await api('matching-policy'));}
  catch(e){$('#policy-status').textContent='加载失败，未覆盖文本；请重新读取。';throw e;}
  finally{policyLoading=false;$('#policy-fields').disabled=!policyData;$('#reload-matching-policy').disabled=false;}
}
for(const id of ['matching-skill','greeting-style'])$('#'+id).addEventListener('input',policyChanged);
$('#apply-greeting-preset').addEventListener('click',()=>{
  const preset=policyData?.presets.find(p=>p.id===$('#greeting-preset').value);if(!preset)return toast('请先选择风格预设。');
  if($('#greeting-style').value&&$('#greeting-style').value!==preset.text&&!confirm('用该预设替换当前风格文本？保存后才会生效。'))return;
  $('#greeting-style').value=preset.text;policyChanged();
});
$('#reset-matching-policy').addEventListener('click',()=>{
  if(!confirm('清空两个文本框以恢复系统默认规则？保存后才会生效。'))return;
  $('#matching-skill').value='';$('#greeting-style').value='';policyChanged();
});
$('#reload-matching-policy').addEventListener('click',()=>perform(async()=>{
  if(policyDirty&&!confirm('放弃未保存的修改，重新读取已保存设置？'))return;
  await loadMatchingPolicy();
}));
$('#matching-policy-form').addEventListener('submit',e=>{e.preventDefault();perform(async()=>{
  if(!policyData||policySaving)return;
  policySaving=true;$('#policy-fields').disabled=true;$('#reload-matching-policy').disabled=true;
  try{
    const draft=policyDraft(),fresh=await api('state'),saved=await api('matching-policy');
    const changed=JSON.stringify(draft)!==JSON.stringify(saved.policy);
    const impact=draft.matchingSkill!==saved.policy.matchingSkill?'将删除旧匹配及草稿，按新规则重新匹配。':'匹配结论保留，只删除并重新生成招呼草稿。';
    if(changed&&!confirm(impact+(fresh.settings.autoAnalyze?'自动处理已开启，会消耗模型任务额度。':'开启自动处理后才会消耗模型任务额度。')+'确定保存？'))return;
    const data=await api('matching-policy',draft);showMatchingPolicy(data);await refreshState();
    toast(data.report_error?'规则已保存，但本地报告文件更新失败；请稍后重新导出报告。':data.changed?'匹配与招呼规则已保存，后续批次使用新版本。':'设置已保存，内容未变化，不重复分析。');
  }finally{policySaving=false;$('#policy-fields').disabled=false;$('#reload-matching-policy').disabled=false;}
});});
window.addEventListener('beforeunload',e=>{if(policyDirty){e.preventDefault();e.returnValue='';}});
$('#hr-activity-enabled').addEventListener('change',syncHrActivityInputs);
$('#settings-form').addEventListener('submit',e=>{e.preventDefault();perform(async()=>{await saveSettings({dailyLimit:Number($('#daily-limit').value),modelConcurrency:Number($('#model-concurrency').value),autoAnalyze:$('#auto-analyze').checked,hrActivity:readHrActivitySettings()});toast('运行设置及 HR 活跃条件已保存。');});});
$('#export-report').addEventListener('click',()=>perform(async()=>{const report=await api('report'),url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download='循序-匹配报告.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('已生成匹配报告下载。');}));
perform(async()=>{await refreshState();await navigate(location.hash.slice(1)||'recommend');});
let polling=false;setInterval(async()=>{if(document.hidden||polling)return;polling=true;try{await refreshState();if(currentView==='profile')await refreshInsights();if(currentView==='recommend'&&!$('#job-drawer').open&&state.revision!==lastListRevision)await loadJobs();}catch{/* Visible persistent banner; avoid repeating toasts. */}finally{polling=false;}},10000);
