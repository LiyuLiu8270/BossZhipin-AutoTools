import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {collectPage} from '../shared/collector.js';

// Selector fixtures simulate the expected DOM contract, not a live browser or real BOSS page.
class Element {
  constructor(innerText = '', attrs = {}, visible = true) { this.innerText = innerText; this.attrs = attrs; this.visible = visible; this.selectors = new Map(); }
  bind(selector, ...elements) { this.selectors.set(selector, elements); return this; }
  querySelectorAll(selector) { return [...new Set(selector.split(',').flatMap(s => this.selectors.get(s.trim()) || []))]; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getClientRects() { return this.visible ? [{}] : []; }
  getAttribute(key) { return this.attrs[key] || null; }
}
function run(document, pathname = '/web/geek/jobs?query=产品经理&securityId=secret', style = () => ({display: 'block', visibility: 'visible', opacity: '1'})) {
  return JSON.parse(JSON.stringify(vm.runInNewContext('(' + collectPage.toString() + ')()', {
    URL, location: {href: 'https://www.zhipin.com' + pathname}, document,
    getComputedStyle: style
    // Deliberately no network, credential or browser automation objects.
  })));
}
function documentFixture() { const d = new Element(); d.body = new Element('合成页面'); return d; }
function card(id, title = '测试岗位', visible = true) {
  return new Element(title, {}, visible)
    .bind('.job-name', new Element(title))
    .bind('.company-name', new Element('合成公司'))
    .bind('.job-salary', new Element('20-30K'))
    .bind('a[href*="/job_detail/"]', new Element(title, {href: `/job_detail/${id}.html?securityId=secret`}));
}

test('模拟列表：解析卡片、去重、排除隐藏卡片和安全参数', () => {
  const doc = documentFixture().bind('.job-card-wrapper', card('a'), card('a'), card('hidden', '隐藏', false), card('b'));
  const data = run(doc);
  assert.equal(data.status, 'captured');
  assert.equal(data.jobs.length, 2);
  assert.equal(data.jobs[0].jd, '');
  assert.equal(JSON.stringify(data).includes('secret'), false);
});
test('没有稳定岗位链接的卡片跳过并计入诊断', () => {
  const doc = documentFixture().bind('.job-card-box', new Element('无链接').bind('.job-name', new Element('测试')));
  const data = run(doc);
  assert.equal(data.jobs.length, 0);
  assert.equal(data.diagnostics.cards_without_job_link, 1);
});

test('含波浪号岗位同时支持列表识别与详情页类型判定',()=>{
  const doc=documentFixture().bind('.job-card-wrapper',card('test~'));
  assert.equal(run(doc).jobs[0].url,'https://www.zhipin.com/job_detail/test~.html');
  const header=new Element().bind('h1',new Element('测试岗位'));
  const detail=run(documentFixture().bind('.job-banner',header),'/job_detail/test~.html');
  assert.equal(detail.page_type,'detail');assert.equal(detail.jobs[0].url,'https://www.zhipin.com/job_detail/test~.html');
});

test('列表加载和结束提示仅保存短标签证据，隐藏提示不影响判断', () => {
  const doc = documentFixture().bind('.job-card-box', card('a'));
  const list = new Element().bind('.loading-text', new Element('加载中...'));
  doc.bind('.job-list-container', list);
  assert.equal(run(doc).diagnostics.list_state.state, 'loading');
  list.bind('.loading-text', new Element('加载中...', {}, false)).bind('.no-more', new Element('没有更多职位'));
  assert.equal(run(doc).diagnostics.list_state.state, 'end');
  list.bind('.loading', new Element(''));
  assert.equal(run(doc).diagnostics.list_state.state, 'conflicting');
  list.bind('.loading').bind('.no-more', new Element('岗位描述中提到没有更多职位，但这不是结束提示'));
  assert.equal(run(doc).diagnostics.list_state.state, 'unknown');
});
test('消息页、其他路径不能采集；安全验证页直接停止', () => {
  assert.equal(run(documentFixture(), '/web/geek/chat').status, 'unsupported');
  assert.equal(run(documentFixture(), '/web/user/safe/verify').status, 'blocked');
});

test('截图式标题区猎头徽标可识别并去重；保留原文，不依赖客户公司或缺公司', () => {
  const badge = new Element('猎头');
  const header = new Element().bind('h1', new Element('ai产品经理')).bind('span', badge).bind('.tag', badge);
  const doc = documentFixture().bind('.job-banner', header);
  const result = run(doc, '/job_detail/hunter.html');
  assert.equal(result.jobs[0].hiring_party.evidence.length, 1);
  assert.equal(result.jobs[0].hiring_party.evidence[0].text, '猎头');
  assert.equal(result.jobs[0].hiring_party.evidence[0].selector, '.tag');
  assert.equal(result.diagnostics.headhunter_badges_found, 1);
  header.bind('span', new Element('客户公司：北京某大型游戏公司')).bind('.tag');
  assert.equal(run(doc, '/job_detail/hunter.html').jobs[0].hiring_party, undefined);
});

test('猎头标识逐卡绑定，隐藏/正文/职位名/推荐卡与无主区全页不得污染', () => {
  const a = card('a').bind('span', new Element('猎头代招'));
  const b = card('b').bind('span', new Element('猎头', {}, false));
  const list = run(documentFixture().bind('.job-card-box', a, b));
  assert.ok(list.jobs[0].hiring_party); assert.equal(list.jobs[1].hiring_party, undefined);
  const root = new Element().bind('h1', new Element('猎头顾问'));
  const doc = documentFixture().bind('.job-banner', root).bind('span', new Element('猎头'));
  for (const label of ['猎头经验优先', '招聘猎头', '猎头顾问', '代招顾问']) {
    root.bind('span', new Element(label));
    assert.equal(run(doc, '/job_detail/a.html').jobs[0].hiring_party, undefined);
  }
  const nested = new Element('猎头'); nested.closest = selector => selector.includes('h1') ? new Element('猎头') : null;
  root.bind('span', nested); assert.equal(run(doc, '/job_detail/a.html').jobs[0].hiring_party, undefined);
  doc.bind('.job-banner'); doc.bind('h1', new Element('职位'));
  assert.equal(run(doc, '/job_detail/a.html').jobs[0].hiring_party, undefined);
});
test('可见登录/验证弹窗阻止采集，即使底下仍有卡片', () => {
  const doc = documentFixture().bind('.job-card-box', card('a')).bind('[role="dialog"]', new Element('请登录'));
  assert.equal(run(doc).status, 'blocked');
  const textWall = documentFixture(); textWall.body.innerText = '登录查看完整内容';
  assert.equal(run(textWall).status, 'login_required');
});

test('猎头徽标可为div/b/custom，嵌在job-name容器内不被整块排除', () => {
  const header = new Element().bind('h1', new Element('工业造型产品经理'));
  const wrapper = new Element('工业造型产品经理 猎头');
  const doc = documentFixture().bind('.job-banner', header);
  for (const tag of ['DIV', 'B', 'CUSTOM-BADGE']) {
    const badge = new Element('猎\u200b 头', {class: 'job-label'}); badge.tagName = tag;
    badge.closest = selector => selector === '.job-name, .job-title' ? wrapper : null;
    header.bind('*', badge);
    const r = run(doc, '/job_detail/a.html');
    assert.equal(r.jobs[0].hiring_party.evidence[0].text, '猎头');
    assert.equal(r.diagnostics.hiring_badge.root_strategy, 'known_header');
    assert.equal(r.diagnostics.hiring_badge.marker_nodes[0].tag, tag.toLowerCase());
  }
});

test('CSS前后伪元素徽标含转义文字可读，隐藏伪元素/url图形不能冒充标签', () => {
  const badge = new Element('', {class: 'job-label'}); badge.tagName = 'DIV';
  const header = new Element().bind('h1', new Element('工业造型产品经理')).bind('*', badge);
  const doc = documentFixture().bind('.job-banner', header);
  for (const pseudo of ['::before', '::after']) for (const content of ['"猎头"', '"\\730e\\5934"']) {
    const style = (el, kind) => ({display: 'block', visibility: 'visible', opacity: '1', content: el === badge && kind === pseudo ? content : 'none'});
    const r = run(doc, '/job_detail/a.html', style);
    assert.equal(r.jobs[0].hiring_party.evidence[0].text, '猎头');
    assert.equal(r.jobs[0].hiring_party.evidence[0].rendered_as, pseudo);
  }
  for (const mode of ['hidden', 'url']) {
    const style = (el, kind) => ({display: mode === 'hidden' && kind ? 'none' : 'block', visibility: 'visible', opacity: '1', content: kind ? mode === 'url' ? 'url(hunter.svg)' : '"猎头"' : 'none'});
    assert.equal(run(doc, '/job_detail/a.html', style).jobs[0].hiring_party, undefined);
  }
});

test('标题容器改名时从唯一H1定位有限祖先，不扩大到JD/body或多个岗位', () => {
  const heading = new Element('工业造型产品经理'); heading.tagName = 'H1';
  const wrapper = new Element().bind('h1', heading);
  const header = new Element().bind('h1', heading).bind('*', new Element('猎头'));
  const doc = documentFixture().bind('h1', heading);
  heading.parentElement = wrapper; wrapper.parentElement = header; header.parentElement = doc.body;
  let r = run(doc, '/job_detail/a.html');
  assert.equal(r.jobs[0].hiring_party.evidence[0].text, '猎头');
  assert.equal(r.diagnostics.hiring_badge.root_strategy, 'unique_title_ancestor');
  header.bind('.job-sec', new Element('职位描述 猎头'));
  assert.equal(run(doc, '/job_detail/a.html').jobs[0].hiring_party, undefined);
  doc.bind('h1', heading, new Element('工业造型产品经理'));
  r = run(doc, '/job_detail/a.html'); assert.equal(r.diagnostics.hiring_badge.root_found, false);
});

test('未知SVG只留短结构诊断不按图标名推断，无标签不等于直招', () => {
  const use = new Element('', {href: '#icon-lie'}); use.tagName = 'use';
  const badge = new Element('', {class: 'job-label'}).bind('use', use); badge.tagName = 'svg';
  const header = new Element().bind('h1', new Element('工业造型产品经理')).bind('*', badge, use);
  const r = run(documentFixture().bind('.job-banner', header), '/job_detail/a.html');
  assert.equal(r.jobs[0].hiring_party, undefined);
  assert.deepEqual(r.diagnostics.hiring_badge.marker_nodes[0].svg_refs, ['#icon-lie']);
  assert.equal(JSON.stringify(r.diagnostics.hiring_badge).includes('innerHTML'), false);
});

test('候选扫描有上限，JD/其他卡片不污染徽标诊断', () => {
  const wrong = new Element('猎头'); wrong.closest = selector => selector.includes('.job-sec') ? {} : null;
  const other = new Element('猎头'); other.closest = selector => selector === '.job-card-wrapper, .job-card-box' ? {} : null;
  const header = new Element().bind('h1', new Element('工业造型产品经理')).bind('*', wrong, other, ...Array.from({length: 600}, () => new Element('普通标签')));
  const r = run(documentFixture().bind('.job-banner', header), '/job_detail/a.html');
  assert.equal(r.jobs[0].hiring_party, undefined);
  assert.equal(r.diagnostics.hiring_badge.truncated, true); assert.equal(r.diagnostics.hiring_badge.scanned, 500);
  assert.equal(r.diagnostics.hiring_badge.excluded_content, 1); assert.equal(r.diagnostics.hiring_badge.excluded_other_card, 1);
});
const hunterIcon = 'https://img.bosszhipin.com/static/file/2022/cbdau7t7qt1661512634122.png';
function iconFixture(src = hunterIcon) {
  const image = new Element('', {src}); image.tagName = 'IMG'; image.complete = true; image.naturalWidth = 60;
  const header = new Element().bind('h1', new Element('工业造型产品经理')).bind('img', image);
  return {image, header, doc: documentFixture().bind('.job-banner', header)};
}
test('用户确认的静态猎头图标按完整域名和路径识别，证据保留图片而不冒充DOM文字', () => {
  for (const src of [hunterIcon, hunterIcon.replace('https:', ''), hunterIcon + '?v=1#badge']) {
    const {doc} = iconFixture(src), r = run(doc, '/job_detail/a.html');
    const e = r.jobs[0].hiring_party.evidence[0];
    assert.equal(r.diagnostics.headhunter_badges_found, 1);
    assert.equal(e.image_url, hunterIcon); assert.equal(e.raw_text, undefined);
    assert.equal(e.rendered_as, 'img'); assert.equal(e.recognition_rule, 'boss-headhunter-static-icon-v1');
    assert.equal(r.diagnostics.hiring_badge.marker_nodes[0].known_badge_images[0].image_url, hunterIcon);
    assert.deepEqual(r.diagnostics.hiring_badge.marker_nodes[0].exact_badge_text, []);
  }
});
test('同名其他域/其他路径/查询参数嵌入地址/未知图片不能认定猎头', () => {
  for (const src of [hunterIcon.replace('img.bosszhipin.com', 'example.com'), hunterIcon.replace('/2022/', '/2023/'), hunterIcon + '.other', 'https://example.com/?image=' + hunterIcon, 'data:image/png;base64,unknown', 'https://user:pass@img.bosszhipin.com/static/file/2022/cbdau7t7qt1661512634122.png']) {
    const {doc, image} = iconFixture(src); image.attrs.alt = '猎头';
    assert.equal(run(doc, '/job_detail/a.html').jobs[0].hiring_party, undefined);
  }
});
test('只认当前选中且已加载的可见图标，不读未启用srcset或lazy占位，不借隐藏祖先图标', () => {
  for (const mode of ['selected_other', 'unloaded', 'broken', 'hidden', 'hidden_parent', 'data_only']) {
    const {doc, image} = iconFixture();
    if (mode === 'selected_other') image.currentSrc = 'https://example.com/other.png';
    if (mode === 'unloaded') image.complete = false;
    if (mode === 'broken') image.naturalWidth = 0;
    if (mode === 'hidden') image.visible = false;
    if (mode === 'data_only') image.attrs = {'data-src': hunterIcon, srcset: hunterIcon + ' 2x'};
    const parent = new Element(); if (mode === 'hidden_parent') image.parentElement = parent;
    const style = el => ({display: 'block', visibility: 'visible', opacity: el === parent ? '0' : '1'});
    assert.equal(run(doc, '/job_detail/a.html', style).jobs[0].hiring_party, undefined, mode);
  }
  const {doc, image} = iconFixture('https://example.com/fallback.png'); image.currentSrc = hunterIcon;
  assert.equal(run(doc, '/job_detail/a.html').jobs[0].hiring_party.evidence[0].image_url, hunterIcon);
});
test('可识别已确认图片作为背景和生成伪元素图片；未生成或隐藏伪元素不识别', () => {
  const el = new Element(); el.tagName = 'DIV';
  const doc = documentFixture().bind('.job-banner', new Element().bind('h1', new Element('岗位')).bind('*', el));
  for (const mode of ['background', 'before_content', 'after_background', 'none', 'normal', 'hidden']) {
    const style = (node, pseudo) => {
      const s = {display: 'block', visibility: 'visible', opacity: '1', content: 'none', backgroundImage: 'none'};
      if (node !== el) return s;
      if (mode === 'background' && !pseudo) s.backgroundImage = `linear-gradient(red, blue), url('${hunterIcon}')`;
      if (mode === 'before_content' && pseudo === '::before') s.content = `url("${hunterIcon}")`;
      if (['after_background', 'none', 'normal', 'hidden'].includes(mode) && pseudo === '::after') {
        s.backgroundImage = `url(${hunterIcon})`; s.content = mode === 'none' || mode === 'normal' ? mode : '""';
        if (mode === 'hidden') s.display = 'none';
      }
      return s;
    };
    const r = run(doc, '/job_detail/a.html', style);
    assert.equal(!!r.jobs[0].hiring_party, ['background', 'before_content', 'after_background'].includes(mode), mode);
  }
});
test('图标仅绑定本岗位标题区/列表卡片，正文和其他推荐卡不得污染', () => {
  for (const mode of ['jd', 'other_card', 'outside']) {
    const {doc, image, header} = iconFixture();
    if (mode === 'jd') image.closest = selector => selector.includes('.job-sec') ? {} : null;
    if (mode === 'other_card') image.closest = selector => selector === '.job-card-wrapper, .job-card-box' ? {} : null;
    if (mode === 'outside') { header.bind('img'); doc.bind('img', image); }
    assert.equal(run(doc, '/job_detail/a.html').jobs[0].hiring_party, undefined, mode);
  }
  const {image} = iconFixture(); const a = card('a').bind('img', image), b = card('b');
  image.closest = selector => selector === '.job-card-wrapper, .job-card-box' ? a : null;
  const result = run(documentFixture().bind('.job-card-box', a, b));
  assert.equal(result.jobs[0].hiring_party.evidence[0].image_url, hunterIcon);
  assert.equal(result.jobs[1].hiring_party, undefined);
});

const agencyIcon = 'https://img.bosszhipin.com/static/file/2022/xkthl0qxyk1661512634054.png';
test('代招静态图标独立取证/计数，普通图片和CSS背景/伪元素均支持', () => {
  for (const mode of ['img', 'selected', 'background', 'before_content', 'after_background']) {
    const {doc, image} = iconFixture(mode === 'selected' ? 'https://example.com/fallback.png' : agencyIcon + '?v=1#badge');
    if (mode === 'selected') image.currentSrc = agencyIcon;
    if (['background', 'before_content', 'after_background'].includes(mode)) image.tagName = 'DIV';
    const style = (el, pseudo) => ({display: 'block', visibility: 'visible', opacity: '1',
      content: el === image && pseudo === '::before' && mode === 'before_content' ? `url("${agencyIcon}")` : el === image && pseudo === '::after' && mode === 'after_background' ? '""' : 'none',
      backgroundImage: el === image && ((!pseudo && mode === 'background') || (pseudo === '::after' && mode === 'after_background')) ? `url('${agencyIcon}')` : 'none'});
    const r = run(doc, '/job_detail/a.html', style), e = r.jobs[0].hiring_party.evidence[0];
    assert.equal(r.diagnostics.headhunter_badges_found, 0, mode); assert.equal(r.diagnostics.agency_badges_found, 1, mode);
    assert.equal(e.text, '代招'); assert.equal(e.image_url, agencyIcon); assert.equal(e.recognition_rule, 'boss-agency-static-icon-v1');
    assert.equal(e.raw_text, undefined);
  }
});
test('代招图片不按相似地址推断，不从隐藏/未加载/非本岗位图片取证', () => {
  for (const mode of ['wrong_host', 'wrong_path', 'embedded', 'hidden', 'broken', 'unloaded', 'jd', 'other_card', 'outside', 'unselected']) {
    const {doc, image, header} = iconFixture(agencyIcon);
    if (mode === 'wrong_host') image.attrs.src = agencyIcon.replace('img.bosszhipin.com', 'example.com');
    if (mode === 'wrong_path') image.attrs.src += '.other';
    if (mode === 'embedded') image.attrs.src = 'https://example.com/?image=' + agencyIcon;
    if (mode === 'hidden') image.visible = false;
    if (mode === 'broken') image.naturalWidth = 0;
    if (mode === 'unloaded') image.complete = false;
    if (mode === 'unselected') image.currentSrc = 'https://example.com/other.png';
    if (mode === 'jd') image.closest = selector => selector.includes('.job-sec') ? {} : null;
    if (mode === 'other_card') image.closest = selector => selector === '.job-card-wrapper, .job-card-box' ? {} : null;
    if (mode === 'outside') { header.bind('img'); doc.bind('img', image); }
    const r = run(doc, '/job_detail/a.html');
    assert.equal(r.jobs[0].hiring_party, undefined, mode); assert.equal(r.diagnostics.agency_badges_found, 0, mode);
  }
});
test('列表逐卡区分猎头/代招/未知；代招文字只接受精确徽标，不接受职位名', () => {
  const a = card('a').bind('img', iconFixture(agencyIcon).image), b = card('b').bind('img', iconFixture().image), c = card('c');
  const r = run(documentFixture().bind('.job-card-box', a, b, c));
  assert.equal(r.jobs[0].hiring_party.evidence[0].text, '代招'); assert.equal(r.jobs[1].hiring_party.evidence[0].text, '猎头');
  assert.equal(r.jobs[2].hiring_party, undefined); assert.equal(r.diagnostics.agency_badges_found, 1); assert.equal(r.diagnostics.headhunter_badges_found, 1);
  const tag = new Element('代招'), heading = new Element('代招');
  const header = new Element().bind('h1', heading).bind('span', tag);
  const doc = documentFixture().bind('.job-banner', header);
  assert.equal(run(doc, '/job_detail/a.html').diagnostics.agency_badges_found, 1);
  tag.closest = s => s === 'h1, h2, h3' ? heading : null;
  assert.equal(run(doc, '/job_detail/a.html').diagnostics.agency_badges_found, 0);
});

test('隐藏弹窗不当成当前登录墙', () => {
  const doc = documentFixture().bind('.job-card-box', card('a')).bind('.login-dialog', new Element('登录', {}, false));
  assert.equal(run(doc).status, 'captured');
});
test('独立详情页只读取职位描述，不把公司介绍或整页文字当 JD', () => {
  const section = new Element('职位描述：合成内容').bind('h3', new Element('职位描述')).bind('.job-sec-text', new Element('合成 JD 正文'));
  const primary = new Element().bind('h1', new Element('产品经理')).bind('.salary', new Element('20-25K'));
  const company = new Element('公司介绍：不应进入 JD').bind('h3', new Element('公司介绍'));
  const doc = documentFixture().bind('.job-banner', primary).bind('.sider-company .company-name', new Element('合成公司')).bind('.job-sec', company, section);
  const data = run(doc, '/job_detail/detail01.html');
  assert.equal(data.jobs[0].jd, '合成 JD 正文');
  assert.equal(data.jobs[0].title, '产品经理');
  assert.equal(data.jobs[0].company, '合成公司');
});
test('搜索页详情弹层不绑定给列表中的另一岗位', () => {
  const doc = documentFixture().bind('.job-card-box', card('a')).bind('.job-sec', new Element('职位 B 描述'));
  assert.equal(run(doc).jobs[0].jd, '');
});
test('未知页面结构返回 empty 而非伪造成功', () => {
  const data = run(documentFixture());
  assert.equal(data.status, 'empty');
  assert.equal(data.jobs.length, 0);
  assert.ok(data.warnings.some(w => w.includes('页面结构变化')));
});

test('公司补采仅读取目标公司区或显式工商公司名称，不借推荐卡/正文/隐藏元素', () => {
  const doc = documentFixture().bind('.job-banner', new Element().bind('h1', new Element('产品经理')))
    .bind('.company-name', new Element('推荐卡错误公司'))
    .bind('.job-detail .job-sec-text', new Element('JD举例提到另一家公司'));
  assert.equal(run(doc, '/job_detail/a.html').jobs[0].company, '');
  doc.bind('.job-detail .business-info li:first-child', new Element('法定代表人：某某'));
  assert.equal(run(doc, '/job_detail/a.html').jobs[0].company, '');
  doc.bind('.job-detail .business-info li:first-child', new Element('公司名称\n合成科技有限公司'));
  let j = run(doc, '/job_detail/a.html').jobs[0];
  assert.equal(j.company, '合成科技有限公司'); assert.match(j.company_evidence.selector, /business-info/);
  doc.bind('.job-detail .business-info li:first-child', new Element('公司名称：隐藏公司', {}, false));
  doc.bind('.sider-company .company-name', new Element('当前品牌公司'));
  assert.equal(run(doc, '/job_detail/a.html').jobs[0].company, '当前品牌公司');
  const nested = new Element('混入推荐公司'); nested.closest = () => ({});
  doc.bind('.sider-company .company-name', nested);
  assert.equal(run(doc, '/job_detail/a.html').jobs[0].company, '');
});

test('同组多个公司名称不擅自选择；多行简介或公司标题不能当公司名', () => {
  const doc = documentFixture().bind('.job-banner', new Element().bind('h1', new Element('产品经理')));
  for (const values of [['A公司', 'B公司'], ['公司介绍'], ['公司名称'], ['某公司\n五险一金\n10人']]) {
    doc.bind('.sider-company .company-name', ...values.map(v => new Element(v)));
    const data = run(doc, '/job_detail/a.html');
    assert.equal(data.jobs[0].company, ''); assert.equal(data.diagnostics.company.chosen_selector, null);
  }
});
test('仅读取已识别的可见搜索输入框，不读取其他输入内容', () => {
  const input = new Element(); input.value = 'B端产品经理';
  const doc = documentFixture().bind('input[name="query"]', input).bind('.job-card-box', card('a'));
  assert.equal(run(doc).keyword_input, 'B端产品经理');
  input.visible = false;
  assert.equal(run(doc).keyword_input, undefined);
});

test('卡片招聘者活跃标签逐岗绑定，不采姓名，不串到相邻岗位', () => {
  const a = card('a').bind('.boss-info span', new Element('今日活跃'), new Element('张女士'));
  const b = card('b').bind('.boss-online', new Element('较久未活跃'));
  const data = run(documentFixture().bind('.job-card-box', a, b));
  assert.deepEqual(data.jobs[0].recruitment_signals.recruiter_activity.map(e => e.text), ['今日活跃']);
  assert.deepEqual(data.jobs[1].recruitment_signals.recruiter_activity.map(e => e.text), ['较久未活跃']);
  assert.equal(JSON.stringify(data).includes('张女士'), false);
});

test('正文含活跃/关闭字样、隐藏招聘标签和详情推荐卡片不污染信号', () => {
  const primary = new Element().bind('h1', new Element('产品经理'));
  const doc = documentFixture().bind('.job-banner', primary)
    .bind('.job-detail .boss-online', new Element('今日活跃', {}, false))
    .bind('.boss-online', new Element('本周活跃'))
    .bind('.job-detail .job-sec-text', new Element('负责提高用户活跃，编写职位已关闭页面'));
  const data = run(doc, '/job_detail/a.html');
  assert.deepEqual(data.jobs[0].recruitment_signals.recruiter_activity, []);
  assert.deepEqual(data.jobs[0].recruitment_signals.availability, []);
});

test('详情按限定区块读取活跃、回复标签和带发布/更新字样的时间原文', () => {
  const doc = documentFixture().bind('.job-banner', new Element().bind('h1', new Element('产品经理')))
    .bind('.job-detail .boss-info span', new Element('3天前活跃'), new Element('回复率90%'), new Element('通常1小时内回复'))
    .bind('.job-banner .publish-time', new Element('发布于2026-09-28'))
    .bind('.job-banner .update-time', new Element('今日更新'));
  const signals = run(doc, '/job_detail/a.html').jobs[0].recruitment_signals;
  assert.equal(signals.recruiter_activity[0].text, '3天前活跃');
  assert.equal(signals.recruiter_response.length, 2);
  assert.equal(signals.published[0].text, '发布于2026-09-28');
  assert.equal(signals.updated[0].text, '今日更新');
});

test('职位关闭但无标题的页面返回单独状态；登录验证优先于关闭标签', () => {
  const doc = documentFixture().bind('.job-invalid', new Element('该职位已关闭'));
  const data = run(doc, '/job_detail/a.html');
  assert.equal(data.status, 'job_unavailable'); assert.equal(data.jobs[0].title, '');
  assert.equal(data.jobs[0].recruitment_signals.availability[0].text, '该职位已关闭');
  doc.bind('.login-dialog', new Element('请登录'));
  assert.equal(run(doc, '/job_detail/a.html').status, 'blocked');
});

test('保留真实页面的3日内/月内活跃原文，不误读正文或任意活跃短句', () => {
  for (const label of ['3日内活跃','7天内活跃','月内活跃','本月活跃','1个月内活跃']) {
    const doc=documentFixture().bind('.job-banner',new Element().bind('h1',new Element('产品经理')))
      .bind('.job-detail .job-boss-info span',new Element(label));
    assert.deepEqual(run(doc,'/job_detail/a.html').jobs[0].recruitment_signals.recruiter_activity.map(e=>e.text),[label]);
  }
  const doc=documentFixture().bind('.job-banner',new Element().bind('h1',new Element('产品经理')))
    .bind('.job-detail .job-boss-info span',new Element('负责提升用户活跃'));
  assert.deepEqual(run(doc,'/job_detail/a.html').jobs[0].recruitment_signals.recruiter_activity,[]);
});

test('半年/年/月及中文数字时间标签可读，仍拒绝任意活跃短句',()=>{
  for(const label of ['半年前活跃','半年内活跃','1年前活跃','3月内活跃','六个月前活跃','一年前活跃','2小时前在线']){
    const doc=documentFixture().bind('.job-banner',new Element().bind('h1',new Element('测试岗位')))
      .bind('.job-detail .boss-active-time',new Element(label));
    assert.deepEqual(run(doc,'/job_detail/a.html').jobs[0].recruitment_signals.recruiter_activity.map(e=>e.text),[label]);
  }
  for(const label of ['负责半年用户活跃','一年经验优先','很活跃的团队','半年前活跃的用户运营']){
    const doc=documentFixture().bind('.job-banner',new Element().bind('h1',new Element('测试岗位')))
      .bind('.job-detail .boss-active-time',new Element(label));
    assert.deepEqual(run(doc,'/job_detail/a.html').jobs[0].recruitment_signals.recruiter_activity,[]);
  }
});

test('招聘者主区块诊断不存姓名，未加载/未知标签不能认定未展示',()=>{
  const panel=new Element().bind('h2.name',new Element('不可保存的姓名')).bind('.boss-info-attr',new Element('公司 · HR'));
  const doc=documentFixture().bind('.job-banner',new Element().bind('h1',new Element('测试岗位'))).bind('.job-detail .job-boss-info',panel);
  let r=run(doc,'/job_detail/a.html');
  assert.equal(r.diagnostics.activity.recruiter_panel_ready,true);
  assert.doesNotMatch(JSON.stringify(r.diagnostics.activity),/不可保存的姓名/);
  panel.bind('.boss-active-time',new Element('另一个时间标签'));
  assert.deepEqual(run(doc,'/job_detail/a.html').diagnostics.activity.unrecognized_labels,['另一个时间标签']);
  panel.bind('h2.name');assert.equal(run(doc,'/job_detail/a.html').diagnostics.activity.recruiter_panel_ready,false);
});

test('列表关闭岗位仍入库，不因状态或活跃度过滤；按钮不是正在招聘证明', () => {
  const a = card('a').bind('.job-status', new Element('职位已下架'));
  const b = card('b').bind('.op-btn', new Element('立即沟通'));
  const data = run(documentFixture().bind('.job-card-box', a, b));
  assert.equal(data.jobs.length, 2); assert.equal(data.status, 'captured');
  assert.equal(data.jobs[0].recruitment_signals.availability[0].text, '职位已下架');
  assert.deepEqual(data.jobs[1].recruitment_signals.availability, []);
});
