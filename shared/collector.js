// Self-contained DOM parser serialized by the local scraper bridge.
// Reads rendered page content only. No requests, page mutations or credential access.
export function collectPage() {
  const url = new URL(location.href);
  const safe = new URL(url.origin + url.pathname);
  for (const key of ['query', 'city']) if (url.searchParams.has(key)) safe.searchParams.set(key, url.searchParams.get(key));
  const result = {source_url: safe.href, keyword: url.searchParams.get('query') || '', page_type: 'unknown', status: 'empty', jobs: [], warnings: [], diagnostics: {}};
  result.diagnostics.visibility = {visibility_state: document.visibilityState || 'unknown', hidden: document.hidden === true,
    document_focused: typeof document.hasFocus === 'function' ? document.hasFocus() : null};
  if (url.origin !== 'https://www.zhipin.com') { result.status = 'unsupported'; return result; }
  if (/security|verify|captcha/i.test(url.pathname)) { result.status = 'blocked'; result.block_reason = 'verification'; return result; }
  const detail = /^\/job_detail\/[\w~-]+\.html$/.test(url.pathname);
  const list = /^\/web\/geek\/(jobs|recommend)\/?$/.test(url.pathname);
  if (!detail && !list) { result.status = 'unsupported'; return result; }
  result.page_type = detail ? 'detail' : 'list';
  const visible = el => {
    if (!el || !el.getClientRects().length) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };
  const text = el => visible(el) ? (el.innerText || '').trim() : '';
  const all = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const first = (root, selectors) => {
    for (const selector of selectors) {
      const el = all(root, selector).find(el => text(el));
      if (el) return text(el);
    }
    return '';
  };
  // Only short labels inside the current card / primary detail sections. Never
  // scan the JD/body for activity words or bind another recommended job's status.
  const signals = (root, isDetail = false) => {
    const read = (selectors, pattern) => {
      const found = new Map();
      for (const selector of selectors) for (const el of all(root, selector)) {
        const value = text(el).replace(/\s+/g, ' ').trim();
        if (value && value.length <= 100 && pattern.test(value) && !found.has(value)) found.set(value, {text: value, selector});
      }
      return [...found.values()].slice(0, 8);
    };
    const boss = isDetail ? ['.job-detail .boss-info', '.job-detail .boss-online', '.job-detail .boss-active-time', '.job-detail .boss-active-status', '.job-detail .boss-name', '.job-detail .job-boss-info', '.job-detail .boss-info-attr'] : ['.boss-info', '.boss-online', '.boss-active-time', '.boss-active-status', '.boss-name'];
    const activitySelectors = boss.flatMap(s => [s + ' .active-time', s + ' .active-text', s + ' span', s + ' em', s]);
    const activityPattern = /^(?:(?:刚刚|当前|目前)?在线|(?:刚刚|今日|今天|昨日|昨天|本周|本月|近期|最近|(?:\d+|[一二三四五六七八九十两]+)\s*(?:分钟|小时|天|日|周|个月|月|年)(?:前|内)|半(?:年|个月|月)(?:前|内)|(?:日|周|月)内)活跃|(?:较久|很久|长期|暂未|近\d+天未)\s*(?:未)?活跃|\d+\s*(?:分钟|小时|天)前在线)$/;
    const replies = isDetail ? ['.job-detail .boss-info .reply', '.job-detail .boss-info .reply-rate', '.job-detail .boss-info .reply-time', '.job-detail .boss-info span', '.job-detail .boss-info .tag', '.job-detail .boss-info .boss-tag'] : ['.boss-info .reply', '.boss-info .reply-rate', '.boss-info .reply-time', '.boss-info span', '.boss-info .tag', '.boss-info .boss-tag'];
    const statusSelectors = isDetail ? ['.job-banner .job-status', '.job-banner .job-status-text', '.job-banner .job-close', '.job-detail .job-status', '.job-detail .job-status-text', '.job-detail .job-close', '.job-invalid', '.job-offline', '.job-error'] : ['.job-status', '.job-status-text', '.job-close'];
    const availabilityPattern = /^(?:(?:该|此|本)?(?:岗位|职位)\s*)?(?:(?:已|已经)?(?:关闭|下架|失效|停止招聘|结束招聘|暂停招聘)|不再招聘|招聘中|正在招聘|开放招聘)[。！!]?$/;
    const dates = isDetail ? ['.job-banner .publish-time', '.job-banner .update-time', '.job-detail .job-primary .publish-time', '.job-detail .job-primary .update-time'] : ['.publish-time', '.update-time'];
    const activity = read(activitySelectors, activityPattern);
    if (isDetail) {
      // Only the main recruiter panel, not JD text or recommended cards. Do not retain names.
      const panels = all(root, '.job-detail .job-boss-info').filter(e => !e.closest?.('.job-card-wrapper, .job-card-box, .recommend-job'));
      const ready = panels.length === 1 && !!first(panels[0], ['h2.name', '.boss-name']) && !!first(panels[0], ['.boss-info-attr']);
      const unknown = panels.flatMap(p => all(p, '.boss-active-time, .active-time, .active-text, .boss-online'))
        .map(e => text(e).replace(/\s+/g, ' ').trim()).filter(t => t && !activityPattern.test(t)).map(t=>t.slice(0,40));
      result.diagnostics.activity = {panel_count:panels.length, recruiter_panel_ready:ready, label_count:activity.length, unrecognized_labels:[...new Set(unknown)].slice(0,4)};
    }
    return {
      recruiter_activity: activity,
      recruiter_response: read(replies, /^(?:回复率\s*[:：]?\s*\d+(?:\.\d+)?[%％]|(?:平均)?\s*\d+\s*(?:分钟|小时|天)(?:内)?回复|回复(?:较快|很快|及时|率高)|通常\s*\d+\s*(?:分钟|小时|天)(?:内)?回复)$/),
      availability: read(statusSelectors, availabilityPattern),
      published: read(dates, /发布/), updated: read(dates, /更新/)
    };
  };
  const blockedTexts = all(document, '[role="dialog"], .login-dialog, .sign-dialog, .verify-dialog, .geetest_panel, .captcha-container').map(text);
  if (blockedTexts.some(t => /登录|验证|验证码/.test(t))) {
    result.status = 'blocked';
    result.block_reason = blockedTexts.some(t => /登录|注册|短信验证码/.test(t)) ? 'login' : 'verification';
    return result;
  }
  const body = (document.body?.innerText || '').slice(0, 12000);
  if (/请完成安全验证|访问过于频繁|滑动完成验证|访问异常|请进行安全验证/.test(body)) {
    result.status = 'blocked'; result.block_reason = /访问过于频繁|访问异常/.test(body) ? 'access_error' : 'verification'; return result;
  }
  if (/登录(?:后)?查看完整(?:内容|职位)|登录后查看职位/.test(body)) { result.status = 'login_required'; return result; }

  const titleSelectors = ['.job-name', '.job-title', '.name h1', 'h1', 'h3'];
  const companySelectors = ['.company-name', '.company-info .name', '.company-info a[ka*="company"]', '.company-info a[href*="/gongsi/"]', '.sider-company .company-info a'];
  const companyFrom = (root, selectors) => {
    const candidates = [];
    for (const selector of selectors) for (const el of all(root, selector)) {
      // Do not borrow another job's company from recommendation cards.
      if (typeof el.closest === 'function' && el.closest('.job-card-wrapper, .job-card-box, .recommend-job, .similar-job')) continue;
      const raw = text(el);
      const name = raw.replace(/^公司名称\s*[:：]?\s*/, '').trim();
      if (!name || name.length > 200 || /[\r\n]/.test(name) || /^(?:公司介绍|公司信息|公司名称|工商信息|查看.*|了解.*)$/.test(name)) continue;
      candidates.push({text: raw, name, selector});
    }
    const names = [...new Set(candidates.map(c => c.name))];
    return {value: names.length === 1 ? candidates[0] : null, diagnostics: {candidate_count: candidates.length, distinct_names: names.length, selectors: [...new Set(candidates.map(c => c.selector))]}};
  };
  const salarySelectors = ['.job-salary', '.salary'];
  const badgeText = value => String(value || '').replace(/[\s\u200B-\u200D\uFEFF]/g, '');
  const isHiringBadge = value => /^(猎头|猎头代招|代招)$/.test(badgeText(value));
  // User-confirmed static badges. Match the exact origin + path,
  // never an arbitrary image filename, alt text or recruitment company name.
  const hiringIcons = new Map([
    ['https://img.bosszhipin.com/static/file/2022/cbdau7t7qt1661512634122.png', {text: '猎头', recognition_rule: 'boss-headhunter-static-icon-v1'}],
    ['https://img.bosszhipin.com/static/file/2022/xkthl0qxyk1661512634054.png', {text: '代招', recognition_rule: 'boss-agency-static-icon-v1'}]
  ]);
  const knownHiringIcon = value => {
    if (!value) return null;
    try {
      const image = new URL(value, safe.href);
      const imageUrl = image.origin + image.pathname, badge = hiringIcons.get(imageUrl);
      return !image.username && !image.password && badge ? {...badge, image_url: imageUrl} : null;
    } catch { return null; }
  };
  const cssImageUrls = value => [...String(value || '').matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"]+))\s*\)/gi)].map(m => m[1] ?? m[2] ?? m[3]);
  const badgeVisible = el => {
    if (!visible(el)) return false;
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    return true;
  };
  const nodeInfo = el => ({tag: String(el?.tagName || '').toLowerCase(), class: String(el?.getAttribute?.('class') || '').slice(0, 160)});
  const pseudoText = style => {
    if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return '';
    const content = style.content || '';
    if (!/^(["']).*\1$/.test(content)) return ''; // Ignore url(), counters, attributes not resolved by the browser.
    return content.slice(1, -1).replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex) => {
      const cp = parseInt(hex, 16); return cp > 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
    });
  };
  const hiringLabels = (root, strategy) => {
    const evidence = [], candidates = new Map();
    const diagnostics = {root_found: !!root, root_strategy: strategy, root: nodeInfo(root), scanned: 0, truncated: false,
      excluded_content: 0, excluded_heading: 0, excluded_other_card: 0, marker_nodes: []};
    if (!root) return {party: null, diagnostics};
    // Keep selector-specific matching for familiar badges; cover div/b/custom/SVG
    // labels too. Never broaden the search to document/body or a JD section.
    for (const selector of ['.job-type', '.job-label', '.job-tag', '.tag', '.head-hunter', '.headhunter', 'img', 'span', 'em', 'i', '*']) {
      for (const el of all(root, selector)) { if (!candidates.has(el)) candidates.set(el, selector); if (candidates.size >= 500) { diagnostics.truncated = true; break; } }
      if (diagnostics.truncated) break;
    }
    for (const [el, selector] of candidates) {
      diagnostics.scanned++;
      if (!badgeVisible(el)) continue;
      let titleText = false;
      const value = text(el) || (el.namespaceURI === 'http://www.w3.org/2000/svg' && visible(el) ? String(el.textContent || '').trim() : '');
      if (typeof el.closest === 'function') {
        if (el.closest('.company-name, .job-sec, .job-detail-section, .job-sec-text, .job-detail-desc, .recommend-job, .similar-job')) { diagnostics.excluded_content++; continue; }
        const card = el.closest('.job-card-wrapper, .job-card-box');
        if (card && card !== root) { diagnostics.excluded_other_card++; continue; }
        // A .job-name/.job-title wrapper may contain both heading and badge.
        // Reject the actual title, not every descendant of that wrapper.
        const heading = el.closest('h1, h2, h3');
        const named = el.closest('.job-name, .job-title');
        if ((heading && badgeText(text(heading)) === badgeText(value)) || (!heading && named === el && isHiringBadge(value))) { diagnostics.excluded_heading++; titleText = true; }
      }
      const info = nodeInfo(el);
      const observations = titleText ? [] : [{text: value, selector, rendered_as: 'text'}];
      const observeImage = (imageValue, renderedAs, sourceSelector) => {
        const badge = knownHiringIcon(imageValue);
        if (badge) observations.push({...badge, selector: sourceSelector, rendered_as: renderedAs});
      };
      if (info.tag === 'img' && el.complete !== false && el.naturalWidth !== 0) {
        // currentSrc is the resource chosen from srcset/picture; do not infer from
        // unused src/srcset/data-src alternatives or unloaded/broken images.
        observeImage(el.currentSrc || el.getAttribute?.('src'), 'img', selector);
      }
      for (const imageUrl of cssImageUrls(getComputedStyle(el).backgroundImage)) observeImage(imageUrl, 'background-image', selector);
      for (const pseudo of ['::before', '::after']) {
        try {
          const style = getComputedStyle(el, pseudo);
          observations.push({text: pseudoText(style), selector: selector + pseudo, rendered_as: pseudo});
          if (style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && style.content && !['none', 'normal'].includes(style.content)) {
            for (const imageUrl of cssImageUrls(style.content)) observeImage(imageUrl, pseudo + ':content-image', selector + pseudo);
            for (const imageUrl of cssImageUrls(style.backgroundImage)) observeImage(imageUrl, pseudo + ':background-image', selector + pseudo);
          }
        } catch { /* No pseudo style support. */ }
      }
      for (const observation of observations) if (isHiringBadge(observation.text) && !evidence.some(e => e.text === badgeText(observation.text) && e.image_url === observation.image_url)) {
        evidence.push({field: 'type', text: badgeText(observation.text), ...(observation.image_url ? {image_url: observation.image_url, recognition_rule: observation.recognition_rule} : {raw_text: observation.text}), selector: observation.selector, rendered_as: observation.rendered_as, node: info});
      }
      // Small structural diagnostics only, no whole header text/HTML, recruiter
      // name, contact details, URLs or company guesses. Unknown icons stay unknown.
      if (diagnostics.marker_nodes.length < 12 && (/hunter|headhunt|badge|label|job-status|job-tag|icon-lie/i.test(info.class) || ['svg', 'use'].includes(info.tag) || observations.some(o => isHiringBadge(o.text)))) {
        const refs = [...(info.tag === 'use' ? [el] : el.querySelectorAll?.('use') || [])].map(n => n.getAttribute?.('href') || n.getAttribute?.('xlink:href')).filter(v => /^#[\w-]{1,100}$/.test(v || '')).slice(0, 4);
        diagnostics.marker_nodes.push({...info, exact_badge_text: observations.filter(o => isHiringBadge(o.text) && !o.image_url).map(o => ({text: badgeText(o.text), rendered_as: o.rendered_as})), svg_refs: refs,
          known_badge_images: observations.filter(o => o.image_url).map(o => ({image_url: o.image_url, rendered_as: o.rendered_as}))});
      }
    }
    return {party: evidence.length ? {evidence} : null, diagnostics};
  };
  const locationSelectors = ['.job-area', '.company-location', '.job-location', '.location-address', '.job-address'];
  const parse = (root, jobUrl) => ({
    url: jobUrl, title: first(root, titleSelectors), company: first(root, companySelectors),
    salary: first(root, salarySelectors), location: first(root, locationSelectors),
    tags: all(root, '.tag-list li, .job-tags span, .job-keyword-list span').map(text).filter(Boolean), jd: ''
  });

  if (detail) {
    // Bind a JD only on a dedicated job_detail URL. Never bind an ambiguous overlay to a list card.
    const primary = document.querySelector('.job-banner .job-primary, .job-banner, .job-primary') || document;
    const job = parse(primary, safe.href);
    // No primary header => no whole-page label scan, so another job cannot label this one.
    let hiringRoot = document.querySelector('.job-banner') || (primary !== document ? primary : null);
    let hiringStrategy = hiringRoot ? 'known_header' : 'not_found';
    if (!hiringRoot) {
      const headings = all(document, 'h1').filter(el => text(el) === job.title && !el.closest?.('.job-card-wrapper, .job-card-box, .job-sec, .job-detail-section, .recommend-job, .similar-job'));
      if (headings.length === 1) {
        // Bounded title-anchored fallback for changed header wrappers. A container
        // with JD sections/cards or another H1 is not the current job header.
        let parent = headings[0].parentElement;
        for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
          if (parent === document.body || /^(BODY|HTML)$/i.test(parent.tagName || '') || parent.querySelector('.job-sec, .job-detail-section, .job-card-wrapper, .job-card-box') || all(parent, 'h1').length > 1) break;
          hiringRoot = parent; hiringStrategy = 'unique_title_ancestor';
        }
      }
    }
    const hiring = hiringLabels(hiringRoot, hiringStrategy), party = hiring.party;
    if (party) job.hiring_party = party;
    // Explicit company-name fields first, then target company card. No whole-
    // document .company-name fallback, which can pick a recommendation card.
    const groups = [companyFrom(primary, companySelectors),
      companyFrom(document, ['.job-detail .business-info .company-name', '.job-detail .business-info .name', '.job-detail .business-info .company-info li:first-child', '.job-detail .business-info li:first-child']),
      companyFrom(document, ['.sider-company .company-name', '.sider-company .company-info .name', '.sider-company .company-info a[href*="/gongsi/"]', '.job-detail .company-info .company-name'])];
    // Generic business fields must explicitly say 公司名称, never a legal
    // representative, funding figure or another first row in the section.
    for (const g of groups) if (g.value?.selector.includes('.business-info') && !g.value.selector.endsWith('.company-name') && !/^公司名称\s*[:：]?\s*/.test(g.value.text)) g.value = null;
    const selected = groups.find(g => g.value)?.value;
    job.company = selected?.name || '';
    if (selected) job.company_evidence = {text: selected.name, raw_text: selected.text, selector: selected.selector};
    if (!job.location) job.location = first(document, locationSelectors);
    const sections = all(document, '.job-detail-section, .job-sec');
    const section = sections.find(el => /^职位描述/.test(first(el, ['h3', 'h2', '.title'])));
    let jd = section ? first(section, ['.job-sec-text', '.text', '.job-detail-desc']) || text(section) : '';
    if (!jd) jd = first(document, ['.job-detail-section .job-sec-text', '.job-detail .job-sec-text', '.job-detail-body .job-sec-text']);
    job.jd_truncated = jd.length > 40000;
    job.jd = jd.slice(0, 40000);
    job.recruitment_signals = signals(document, true);
    const unavailable = job.recruitment_signals.availability.some(e => /关闭|下架|失效|停止招聘|结束招聘|暂停招聘|不再招聘/.test(e.text));
    if (unavailable) {
      result.status = 'job_unavailable';
      result.jobs = [job];
      result.diagnostics = {availability_found: true, title_found: !!job.title, hiring_badge: hiring.diagnostics};
      result.warnings.push('页面明确显示岗位不可招聘；只更新已有岗位的状态观察，不删除岗位或旧 JD。');
      return result;
    }
    result.diagnostics = {...result.diagnostics, description_sections: sections.length, title_found: !!job.title, company_found: !!job.company, company: {groups: groups.map(g => g.diagnostics), chosen_selector: selected?.selector || null}, hiring_badge: hiring.diagnostics, jd_chars: job.jd.length};
    if (job.title) result.jobs.push(job);
    if (!job.jd) result.warnings.push('未识别到职位描述；不会把整页文字当作 JD。');
  } else {
    for (const selector of ['input[name="query"]', '.search-input input', 'input.search-input', '.search-box input[placeholder*="职位"]']) {
      const input = all(document, selector).find(el => el.value?.trim());
      if (input) { result.keyword_input = input.value.trim().slice(0, 80); break; }
    }
    const cards = all(document, '.job-card-wrapper, .job-card-box, .job-list-box > li');
    const unique = new Map();
    let missingLinks = 0;
    for (const card of cards) {
      const link = all(card, 'a[href*="/job_detail/"]').find(a => {
        try { const u = new URL(a.getAttribute('href'), url); return u.origin === url.origin && /^\/job_detail\/[\w~-]+\.html$/.test(u.pathname); } catch { return false; }
      });
      if (!link) { missingLinks++; continue; }
      const jobUrl = new URL(link.getAttribute('href'), url);
      const canonical = jobUrl.origin + jobUrl.pathname;
      const job = parse(card, canonical);
      const party = hiringLabels(card, 'current_card').party;
      if (party) job.hiring_party = party;
      job.recruitment_signals = signals(card);
      if (job.title && !unique.has(canonical)) unique.set(canonical, job);
    }
    result.jobs = [...unique.values()];
    result.diagnostics = {cards_found: cards.length, cards_without_job_link: missingLinks, companies_found: result.jobs.filter(j => j.company).length};
    // Only short, rendered list-status labels. Do not read framework state,
    // whole-page HTML, request internals or treat an unknown state as exhausted.
    const listRoot = document.querySelector('.job-list-container, .job-list-wrapper, .job-list-box, .rec-job-list');
    const stateEvidence = [];
    const loadingSelectors = ['.loading', '.loading-more', '.loadmore', '.load-more', '.loadmore-loading', '.loading-icon', '.loading-text', '[role="status"]'];
    const endSelectors = ['.no-more', '.nomore', '.no-data', '.empty-tips', '.loadmore', '.load-more', '.data-tips', '.list-bottom'];
    if (listRoot) for (const selector of [...new Set([...loadingSelectors, ...endSelectors])]) for (const el of all(listRoot, selector)) {
      const raw = text(el).replace(/\s+/g, ' ').trim();
      if (raw.length > 80) continue;
      const ended = /^(?:没有更多(?:了|职位|岗位|结果)?|暂无更多(?:职位|岗位|结果)?|已(?:经)?到底(?:了)?|已加载全部(?:职位|岗位|结果)?)[。.!！]?$/.test(raw);
      const loading = /^(?:(?:正在)?加载(?:中|更多)?|请稍(?:等|候))(?:\.{1,3}|…+)?$/.test(raw);
      const hint = !raw && loadingSelectors.includes(selector) && !['.loadmore', '.load-more', '[role="status"]'].includes(selector);
      if (ended || loading || hint) stateEvidence.push({selector, text: raw, kind: ended ? 'end' : loading ? 'loading' : 'loading_hint'});
    }
    const hasEnd = stateEvidence.some(e => e.kind === 'end'), hasLoading = stateEvidence.some(e => e.kind.startsWith('loading'));
    result.diagnostics.list_state = {state: hasEnd && hasLoading ? 'conflicting' : hasEnd ? 'end' : hasLoading ? 'loading' : 'unknown', evidence: stateEvidence.slice(0, 12)};
    result.warnings.push('仅采集当前已加载的卡片；列表摘要不作为完整 JD。');
    if (missingLinks) result.warnings.push('部分卡片没有可识别的岗位链接，已跳过；可手动打开详情页补采。');
  }
  result.status = result.jobs.length ? 'captured' : 'empty';
  result.diagnostics.headhunter_badges_found = result.jobs.filter(j => j.hiring_party?.evidence?.some(e => /^(猎头|猎头代招)$/.test(e.text))).length;
  result.diagnostics.agency_badges_found = result.jobs.filter(j => j.hiring_party?.evidence?.some(e => e.text === '代招')).length;
  result.diagnostics.recruitment_signals = Object.fromEntries(['recruiter_activity', 'recruiter_response', 'availability', 'published', 'updated'].map(f => [f + '_found', result.jobs.filter(j => j.recruitment_signals?.[f]?.length).length]));
  if (!result.jobs.length) result.warnings.push('没有识别到岗位：可能尚未加载、登录失效或页面结构变化；请勿反复刷新。');
  result.warnings.push('登录状态由用户确认，采集器不读取或验证 Cookie。薪资取自 DOM，需与页面核对。');
  return result;
}
