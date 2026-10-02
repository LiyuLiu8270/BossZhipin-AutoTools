"""Bounded, allowlisted diagnostics around pinned scraper search (no raw traffic)."""
import json
import re
import time
import traceback
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, parse_qs


PAGE_PROBE = r"""JSON.stringify((()=>{
 const visible=e=>{if(!e||!e.getClientRects().length)return false;const s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';};
 const has=s=>[...document.querySelectorAll(s)].some(visible);
 const path=location.pathname;
 const gate=/captcha|security|verify/.test(path)||has('.geetest_panel,.geetest_window,.verify-wrap')?'verification_required':
   /\/web\/user\/|\/login/.test(path)||has('.login-dialog,.login-register-dialog')?'login_required':null;
 const route=/^\/web\/geek\/(jobs|recommend)\/?$/.test(path)?'search':location.href==='about:blank'?'loading':'other';
 const roots=[['window',document.scrollingElement],['job-list-container',document.querySelector('.job-list-container')],['job-list-box',document.querySelector('.job-list-box')],['search-job-result',document.querySelector('.search-job-result')]];
 const labels=[...document.querySelectorAll('.loading-text,.no-more,.load-more')].filter(visible).map(e=>(e.innerText||'').trim());
 return {route,gate,ready:document.readyState,visibility:document.visibilityState,focused:document.hasFocus(),
  cards:[...document.querySelectorAll('.job-card-wrapper,.job-card-box')].filter(visible).length,
  loading:labels.some(t=>/加载中/.test(t)),end:labels.some(t=>/没有更多|到底了|全部加载/.test(t)),
  scroll:roots.filter(([,e])=>e).map(([name,e])=>({name,top:Math.round(e.scrollTop),height:e.scrollHeight,client:e.clientHeight}))};
})())"""


class DebugLog:
    def __init__(self, path, mode, keyword=None):
        self.path, self.mode, self.keyword = Path(path), mode, keyword
        self.count = 0
        self.failed = False

    def write(self, event, **fields):
        if self.count >= 1200:
            return
        self.count += 1
        if self.count == 1200:
            event, fields = 'diagnostic_limit', {}
        row = {'at': datetime.now().astimezone().isoformat(), 'task_id': self.path.parent.name,
               'operation_id': self.path.stem.removesuffix('-debug'), 'mode': self.mode, 'event': event, **fields}
        if self.keyword is not None:
            row['keyword'] = self.keyword
        try:
            with self.path.open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(row, ensure_ascii=False) + '\n')
        except OSError:
            self.failed = True

    def exception(self, event, exc, **fields):
        # No exception message, source lines, URL, headers, body or absolute paths.
        frames = [{'file': Path(f.filename).name, 'line': f.lineno, 'function': f.name}
                  for f in traceback.extract_tb(exc.__traceback__)[-6:]]
        self.write(event, exception=type(exc).__name__, frames=frames, **fields)


class SearchStop(RuntimeError):
    pass


def connection_failure(exc):
    names = {'ConnectionError', 'ConnectionRefusedError', 'ConnectionResetError', 'WebSocketConnectionClosedException', 'WebSocketBadStatusException', 'OSError'}
    return any(c.__name__ in names for c in type(exc).__mro__)


def safe_page(value):
    if not isinstance(value, dict):
        return {'probe': 'invalid_result'}
    enums = {'route': {'search', 'loading', 'other'}, 'gate': {'login_required', 'verification_required'},
             'ready': {'loading', 'interactive', 'complete'}, 'visibility': {'visible', 'hidden'}}
    result = {key: value.get(key) if value.get(key) in choices else None for key, choices in enums.items()}
    for key in ('focused', 'loading', 'end'):
        result[key] = value.get(key) is True
    result['cards'] = value.get('cards') if type(value.get('cards')) is int else None
    result['scroll'] = [{k: r[k] for k in ('name', 'top', 'height', 'client')}
                        for r in value.get('scroll', [])[:4] if isinstance(r, dict)
                        and r.get('name') in {'window', 'job-list-container', 'job-list-box', 'search-job-result'}
                        and all(type(r.get(k)) is int for k in ('top', 'height', 'client'))]
    return result


def network_summary(capture, previous):
    """Only job-list endpoint metadata; exclude query, headers and response bodies."""
    records = {}
    events = getattr(capture.cdp, 'events', [])
    for ev in events:
        if ev.get('sessionId') not in (None, capture.sid):
            continue
        p = ev.get('params', {}); rid = p.get('requestId')
        if ev.get('method') == 'Network.requestWillBeSent':
            u = urlparse(p.get('request', {}).get('url', ''))
            if u.hostname == 'www.zhipin.com' and u.path == '/wapi/zpgeek/search/joblist.json' and rid not in previous:
                page = parse_qs(u.query).get('page', [''])[0]
                records[rid] = {'page': int(page) if re.fullmatch(r'\d{1,4}', page) else None,
                                'status': None, 'finished': False, 'failed': False}
    for ev in events:
        if ev.get('sessionId') not in (None, capture.sid):
            continue
        p = ev.get('params', {}); r = records.get(p.get('requestId'))
        if r is None:
            continue
        if ev.get('method') == 'Network.responseReceived':
            status = p.get('response', {}).get('status')
            r['status'] = status if type(status) in (int, float) else None
            mime = p.get('response', {}).get('mimeType')
            r['mime'] = mime if mime in {'application/json','text/html','text/plain'} else 'other'
        if ev.get('method') == 'Network.loadingFinished':
            r['finished'] = True
        if ev.get('method') == 'Network.loadingFailed':
            r['failed'] = True
            code = p.get('errorText', '')
            r['network_error'] = code if re.fullmatch(r'net::ERR_[A-Z_]+', code) else 'network_failure'
            r['cancelled'] = p.get('canceled') is True
    return records


def missing_reason(records, body_failures):
    rows = list(records.values())
    if not rows:
        return 'request_not_observed'
    if any(r['failed'] for r in rows):
        return 'request_failed'
    if any((r['status'] or 0) >= 400 for r in rows):
        return 'http_error'
    if body_failures:
        return 'response_body_unreadable'
    if any(r['finished'] for r in rows):
        return 'response_not_consumed'
    return 'response_not_finished'


def collect_search(module, config, output, log):
    """Keep upstream navigation/paging, observe boundaries and isolate missing responses."""
    observations, pages, seen_requests = [], [], set()
    current = {'page': 0, 'missing': 0, 'body_failures': 0}
    fatal, stop_reason = None, None
    started = time.monotonic()
    # Node supplies a page-scaled budget and a larger hard process deadline.
    # Keep upstream pacing unchanged; bounded waiting is not evidence of no jobs.
    budget = config.get('keywordBudgetSeconds', 1260)
    if type(budget) is not int or not 120 <= budget <= 1260:
        budget = 1260
    originals = (module.NetworkJoblistCapture.wait_next_response, module.NetworkJoblistCapture._fetch_body,
                 module.map_api_jobs, module.CDPSession.eval_js, module.CDPSession.send)
    original_wait, original_body, original_map, original_eval, original_send = originals

    def probe(cdp, sid):
        nonlocal fatal
        try:
            value = original_eval(cdp, PAGE_PROBE, sid)
            result = safe_page(json.loads(value) if isinstance(value, str) else value)
            if result.get('gate'):
                fatal = result['gate']
            if result.get('route') == 'other' and not fatal:
                fatal = 'search_page_changed'
            return result
        except Exception as exc:
            log.exception('page_probe_error', exc, page=current['page'])
            return {'probe': 'failed'}

    def send(cdp, method, *args, **kwargs):
        nonlocal fatal
        try:
            result = original_send(cdp, method, *args, **kwargs)
            if method in ('Page.navigate', 'Network.getResponseBody'):
                log.write('cdp_result', page=current['page'], command=method, has_error=bool(result.get('error')))
            return result
        except Exception as exc:
            log.exception('cdp_error', exc, page=current['page'], command=method if re.fullmatch(r'[A-Za-z]+\.[A-Za-z]+', method) else 'unknown')
            if connection_failure(exc):
                fatal = 'browser_unavailable'
            raise

    def evaluate(cdp, js, sid):
        action = 'scroll_bottom' if 'window.scrollTo(' in js else 'scroll_relative' if 'window.scrollBy(' in js else None
        if not action:
            return original_eval(cdp, js, sid)
        before = probe(cdp, sid)
        result = original_eval(cdp, js, sid)
        log.write('scroll', page=current['page']+1, action=action, before=before, after=probe(cdp, sid))
        if fatal:
            raise SearchStop(fatal)
        return result

    def fetch_body(capture, rid):
        body = original_body(capture, rid)
        valid = False
        if body is not None:
            try:
                valid = isinstance(json.loads(body), dict)
            except (ValueError, TypeError):
                pass
        if not valid:
            current['body_failures'] += 1
        log.write('response_body', page=current['page'], present=body is not None,
                  characters=len(body) if isinstance(body, str) else 0, valid_json_object=valid)
        return body

    def classify(data):
        nonlocal fatal
        result = module.classify_login_probe_response(data).status.value
        observations.append(result)
        if result in ('restricted', 'unauthenticated'):
            fatal = {'restricted':'verification_required', 'unauthenticated':'login_required'}[result]
        return result

    def wait(capture, *args, **kwargs):
        nonlocal stop_reason, fatal
        current['page'] += 1; current['body_failures'] = 0
        if time.monotonic()-started > budget:
            stop_reason = 'keyword_time_budget'; raise SearchStop(stop_reason)
        before = probe(capture.cdp, capture.sid)
        if fatal:
            raise SearchStop(fatal)
        at = time.monotonic()
        log.write('wait_start', page=current['page'], timeout=kwargs.get('timeout', args[0] if args else None),
                  trigger='navigate' if kwargs.get('trigger') else 'after_scroll', before=before)
        try:
            data = original_wait(capture, *args, **kwargs)
        except Exception as exc:
            if connection_failure(exc):
                fatal = 'browser_unavailable'
            log.exception('wait_error', exc, page=current['page']); raise
        after = probe(capture.cdp, capture.sid)
        records = network_summary(capture, seen_requests)
        seen_requests.update(rid for rid, r in records.items() if r['finished'] or r['failed'])
        state = classify(data) if data is not None else 'no_response'
        zp = data.get('zpData') if isinstance(data, dict) else None
        zp = zp if isinstance(zp, dict) else {}
        raw_jobs = zp.get('jobList')
        page = {'page':current['page'], 'outcome':state, 'seconds':round(time.monotonic()-at,3),
                'network':list(records.values())[:30], 'requests':len(records),
                'api_code':data.get('code') if isinstance(data,dict) and type(data.get('code')) is int else None,
                'jobs':len(raw_jobs) if isinstance(raw_jobs,list) else None,
                'has_more':zp.get('hasMore') if type(zp.get('hasMore')) is bool else None,
                'reason':missing_reason(records,current['body_failures']) if data is None else state, 'after':after}
        pages.append(page); log.write('wait_end', **page)
        if fatal:
            raise SearchStop(fatal)
        current['missing'] = current['missing']+1 if data is None else 0
        if current['missing'] >= 3:
            stop_reason = 'consecutive_no_response'; raise SearchStop(stop_reason)
        return data

    def mapped(data):
        state = classify(data)
        if state not in ('available', 'empty'):
            raise SearchStop(fatal or 'search_response_error')
        return original_map(data)

    module.NetworkJoblistCapture.wait_next_response, module.NetworkJoblistCapture._fetch_body = wait, fetch_body
    module.map_api_jobs, module.CDPSession.eval_js, module.CDPSession.send = mapped, evaluate, send
    failure = None
    log.write('search_start', requested_pages=config['pages'], city=config['city'], budget_seconds=budget)
    try:
        module.scrape_list(config['keyword'], config['city'], config['pages'], {}, output, cdp_port=19222)
    except Exception as exc:
        if connection_failure(exc):
            fatal = 'browser_unavailable'
        failure = 'collection_failed'; log.exception('search_exception', exc, page=current['page'])
    finally:
        (module.NetworkJoblistCapture.wait_next_response, module.NetworkJoblistCapture._fetch_body,
         module.map_api_jobs, module.CDPSession.eval_js, module.CDPSession.send) = originals
    payload = json.loads(Path(output).read_text(encoding='utf-8')) if Path(output).exists() else None
    valid = any(p['outcome'] in ('available','empty') for p in pages)
    warnings = [p for p in pages if p['outcome'] == 'no_response']
    if not fatal and not stop_reason and not failure and len(pages) < config['pages'] and not (pages and pages[-1]['has_more'] is False):
        stop_reason = 'upstream_early_exit'
    error = fatal or ('search_response_error' if 'response_error' in observations else None) or failure
    if not valid and not error:
        error = 'no_search_response'
    if valid and payload is None:
        payload = {'keyword':config['keyword'], 'city':config['city'], 'jobs':[], 'total':0}
    if payload is not None:
        payload['scraped_at'] = datetime.now().astimezone().isoformat()
        Path(output).write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8')
    diagnostic = {'version':2, 'requested_pages':config['pages'], 'budget_seconds':budget, 'pages_observed':len(pages), 'missing_responses':len(warnings),
                  'valid_responses':sum(p['outcome'] in ('available','empty') for p in pages),
                  'stop_reason':fatal or stop_reason or error or ('explicit_end' if pages and pages[-1]['has_more'] is False else 'page_limit'),
                  'warnings':[{'page':p['page'],'reason':p['reason']} for p in warnings],
                  'partial':bool(warnings or stop_reason or error)}
    log.write('search_end', **diagnostic, error=error, jobs=len(payload.get('jobs',[])) if payload else 0,
              seconds=round(time.monotonic()-started,3))
    return payload, error, diagnostic
