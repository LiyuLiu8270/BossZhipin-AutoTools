import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

// Exercise the shipped handlers with a small synthetic DOM; not visual browser QA.
const source=readFileSync(new URL('../local/web/app.js',import.meta.url),'utf8');
test('任务标签互斥显示并保留面板节点，未知标签不改变当前内容',()=>{
 const panels=['collection','analysis','greeting','research','keywords'].map(key=>({dataset:{taskPanel:key},hidden:false,draft:'未保存'}));
 const tabs=panels.map(p=>({dataset:{taskTab:p.dataset.taskPanel},attrs:{},setAttribute(k,v){this.attrs[k]=v;}}));
 const c=createContext({$$:s=>s==='[data-task-panel]'?panels:tabs});
 runInContext(source.slice(source.indexOf('function showTaskTab('),source.indexOf('function installUsability(')),c);
 for(const key of panels.map(p=>p.dataset.taskPanel)){
  runInContext(`showTaskTab('${key}')`,c);
  assert.deepEqual(panels.filter(p=>!p.hidden).map(p=>p.dataset.taskPanel),[key]);
  assert.deepEqual(tabs.filter(t=>t.tabIndex===0).map(t=>t.dataset.taskTab),[key]);
  assert.equal(tabs.filter(t=>t.attrs['aria-selected']==='true').length,1);assert.ok(panels.every(p=>p.draft==='未保存'));
 }
 runInContext("showTaskTab('unknown')",c);assert.equal(panels.at(-1).hidden,false);
});
test('设置页不再包含自动开关，也不在运行设置提交中覆盖它们',()=>{
 const html=readFileSync(new URL('../local/web/index.html',import.meta.url),'utf8');
 assert.doesNotMatch(html,/id="auto-(?:analyze|greeting)"/);
 const handler=source.split('\n').find(line=>line.startsWith("$('#settings-form').addEventListener('submit'"));
 assert.doesNotMatch(handler,/autoAnalyze|autoGreeting/);assert.match(handler,/dailyLimit/);assert.match(handler,/hrActivity/);
 assert.match(html,/id="toggle-analysis"/);assert.match(html,/id="toggle-greeting"/);
});
function harness(){
 const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',disabled:false,textContent:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;}});return nodes.get(id);};
 const metrics=['total','details','job-closed','awaiting','优先沟通','可以尝试','低优先级','不匹配','pending','contacted','waiting'].map(key=>({dataset:{summary:key},attrs:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(type,handler){this[type]=handler;}}));
 const sandbox={$:id=>node(id),$$:()=>metrics,perform:fn=>fn(),clearTimeout:()=>{},loadJobs:async()=>{sandbox.loads++;},loads:0};
 const context=createContext(sandbox);
 runInContext(source.match(/const listFilters=\[[^;]+;/)[0]+'\nlet page=9,debounce,activeJob=null,quickView="recommended";\n'+source.slice(source.indexOf('function renderSummary('),source.indexOf('async function loadJobs('))+'\n'+source.slice(source.indexOf('function syncReplyInput('),source.indexOf("$('#action-stage').addEventListener")),context);
 return {node,metrics,sandbox,run:code=>runInContext(code,context)};
}
test('概览点击清除其他条件，保留数据集和排序，回到第一页，仅触发列表读取',async()=>{
 const h=harness();h.node('#dataset').value='synthetic';h.node('#sort').value='recent';
 for(const metric of h.metrics){
  h.run("for(const id of listFilters)$('#'+id).value='stale';page=9;");
  await metric.click();assert.equal(h.run('page'),1);assert.equal(h.node('#dataset').value,'synthetic');assert.equal(h.node('#sort').value,'recent');
  const active=h.run("listFilters.filter(id=>$('#'+id).value).map(id=>[id,$('#'+id).value])");
  const key=metric.dataset.summary,expected=key==='total'?[]:key==='details'?[['detail-filter','ready'],['availability-filter','unknown']]:key==='job-closed'?[['availability-filter','terminal']]:key==='awaiting'?[['detail-filter','unfinished']]:key==='contacted'?[['contact-filter','contacted']]:key==='waiting'?[['reply-filter','waiting']]:[['priority',key]];
  assert.deepEqual(JSON.parse(JSON.stringify(active)),expected);
 }
 assert.equal(h.sandbox.loads,11);
});
test('概览互斥数字、零待采隐藏，计数点击与筛选高亮一致',()=>{
 const h=harness(),summary={total:12,overview:{total:12,collected:9,terminal:3,awaiting:0,closed:2,unavailable:1},details:10,contacted:4,waiting:2,priorities:{'优先沟通':2,'可以尝试':3,'低优先级':1,'不匹配':1,pending:5}};
 h.sandbox.summary=summary;h.run('renderSummary(summary)');
 assert.equal(h.node('#count-details').textContent,9);assert.equal(h.node('#count-job-closed').textContent,3);assert.equal(h.node('#summary-awaiting').hidden,true);assert.equal(h.node('#count-pending').textContent,5);assert.equal(h.metrics[0].attrs['aria-pressed'],'true');
 summary.overview.awaiting=1;h.run('renderSummary(summary)');assert.equal(h.node('#summary-awaiting').hidden,false);
 h.node('#reply-filter').value='waiting';h.run('renderSummary(summary)');assert.equal(h.metrics.at(-1).attrs['aria-pressed'],'true');
 h.node('#search').value='additional';h.run('renderSummary(summary)');assert.ok(h.metrics.every(m=>m.attrs['aria-pressed']==='false'));
});
test('未采集分布显示可采、退避、关闭、不可用，不把未采集总数当可执行数',()=>{
 const h=harness();h.sandbox.summary={total:12,details:6,closed:4,contacted:0,waiting:0,priorities:{},detailCounts:{missing:6,pending:1,waiting_retry:1,review:0,closed:3,unavailable:1,unqueued:0}};h.run('renderSummary(summary)');
 assert.match(h.node('#detail-breakdown').textContent,/已保留正文 6 条/);assert.match(h.node('#detail-breakdown').textContent,/可立即采集 1 · 等待重试 1/);
});

test('新沟通预选待回复但无保存副作用，历史沟通未知不自动回填，取消沟通清空选择',()=>{
 const h=harness(),reply=h.node('#action-reply'),contact=h.node('#action-contact');
 h.run("activeJob={contact_status:'unknown'}");reply.disabled=true;reply.value='unknown';contact.value='contacted';h.run('syncReplyInput()');
 assert.equal(reply.value,'waiting');assert.equal(reply.disabled,false);assert.equal(h.sandbox.loads,0);
 reply.value='replied';h.run('syncReplyInput()');assert.equal(reply.value,'replied');
 contact.value='not_contacted';h.run('syncReplyInput()');assert.equal(reply.value,'unknown');assert.equal(reply.disabled,true);
 h.run("activeJob={contact_status:'contacted'}");contact.value='contacted';h.run('syncReplyInput()');assert.equal(reply.value,'unknown');assert.equal(reply.disabled,false);
});

test('轮询无数据变化不重读列表，数据变化才更新，隐藏页和抽屉不打断',async()=>{
 let callback,loads=0,refreshes=0;const drawer={open:false},state={revision:'same'};
 const c=createContext({document:{hidden:false},setInterval:fn=>{callback=fn;},refreshState:async()=>{refreshes++;},refreshInsights:async()=>{},loadJobs:async()=>{loads++;},$:()=>drawer,state});
 runInContext("let currentView='recommend',lastListRevision='same';\n"+source.slice(source.indexOf('let polling=false;')),c);
 await callback();assert.equal(loads,0);state.revision='changed';await callback();assert.equal(loads,1);
 drawer.open=true;await callback();assert.equal(loads,1);c.document.hidden=true;await callback();assert.equal(refreshes,3);
});
test('并行状态读取共用一个在途请求，完成后可重新查询',async()=>{
 let calls=0,release;const c=createContext({readAndRenderState:()=>{calls++;return new Promise(r=>{release=r;});}});
 runInContext('let stateRequest=null;\n'+source.slice(source.indexOf('function refreshState()'),source.indexOf('async function readAndRenderState()')),c);
 const first=runInContext('refreshState()',c),second=runInContext('refreshState()',c);assert.equal(first,second);assert.equal(calls,1);release();await first;
 const third=runInContext('refreshState()',c);assert.equal(calls,2);release();await third;
});
