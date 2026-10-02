"""Small process boundary around the pinned upstream collector; no credential reads.

Stdout is structured status only. Upstream diagnostics are not forwarded because
they can include access parameters. Raw results remain in the local run folder.
"""
import contextlib
import importlib.util
import json
import os
import re
from pathlib import Path
import sys
import time
from datetime import datetime
from urllib.parse import urlparse
sys.path.insert(0, str(Path(__file__).resolve().parent))
from window_focus import WindowFocus
from search_diagnostics import DebugLog, collect_search


def open_job(module, job):
    """Foreground user-owned tab; no visibility spoofing, no close on completion."""
    expected = urlparse(job["job_link"])
    if expected.scheme != "https" or expected.netloc != "www.zhipin.com" or not expected.path.startswith("/job_detail/"):
        raise ValueError("invalid_job_link")
    ws = module.CDPSession(19222)
    opened = False
    result = {"opened": False, "page_state": "unverified", "jd_characters": 0, "foregrounded": False, "foreground_status": "unverified"}
    try:
        focus = None
        try:
            processes = ws.send("SystemInfo.getProcessInfo")["result"]["processInfo"]
            pid = next(p["id"] for p in processes if p["type"] == "browser")
            focus = WindowFocus(pid)
        except Exception:
            pass  # Foreground limitations must not prevent opening the job.
        target = ws.send("Target.createTarget", {"url": module.build_detail_url(job), "background": False, "newWindow": True})["result"]["targetId"]
        opened = True
        sid = ws.send("Target.attachToTarget", {"targetId": target, "flatten": True})["result"]["sessionId"]
        ws.send("Target.activateTarget", {"targetId": target})
        ws.send("Page.bringToFront", {}, sid)
        # Short bounded readiness check. Do not refresh, retry navigation or solve gates.
        for _ in range(8):
            time.sleep(0.75)
            value = ws.eval_js(module.EXTRACT_DETAIL_JS, sid)
            data = json.loads(value) if isinstance(value, str) else {}
            parsed = urlparse(data.get("url", ""))
            page_text = data.get("page_text", "")
            if any(text in page_text for text in ("请完成安全验证", "请完成验证", "访问过于频繁")) or "/captcha" in parsed.path:
                result["page_state"] = "verification_required"
                break
            try:
                fields = module.extract_detail_fields(data)
            except module.DetailLoginRequiredError:
                result["page_state"] = "login_required"
                break
            except module.DetailExtractionError:
                fields = {}
            if parsed.hostname == expected.hostname and parsed.path == expected.path and fields.get("jd"):
                result.update(page_state="detail_visible", jd_characters=len(fields["jd"]))
                break
            if "/login" in parsed.path or "/web/user/" in parsed.path:
                result["page_state"] = "login_required"
                break
            if parsed.scheme in ("http", "https") and (parsed.hostname != expected.hostname or parsed.path != expected.path):
                result["page_state"] = "page_changed"
        result["opened"] = opened
        try:
            ws.send("Target.activateTarget", {"targetId": target})
            ws.send("Page.bringToFront", {}, sid)
            result["foregrounded"] = bool(focus and focus.activate())
            result['foreground_status'] = focus.status if focus else 'window_not_identified'
        except Exception:
            pass
        return result
    except Exception:
        if not opened:
            raise
        return {**result, "opened": True, "page_state": "unverified"}
    finally:
        ws.close()


def backfill_job(module, config):
    """Read only rendered fields in an owned foreground tab; close only this tab."""
    expected = urlparse(config["job"]["job_link"])
    if expected.scheme != "https" or expected.netloc != "www.zhipin.com" or not expected.path.startswith("/job_detail/"):
        raise ValueError("invalid_job_link")
    try:
        ws = module.CDPSession(19222)
    except Exception:
        return None, "browser_unavailable"
    target = None
    capture, error = None, None
    stage = "create_target"
    try:
        target = ws.send("Target.createTarget", {"url": module.build_detail_url(config["job"]), "background": False})["result"]["targetId"]
        sid = ws.send("Target.attachToTarget", {"targetId": target, "flatten": True})["result"]["sessionId"]
        stage = "read_dom"
        for attempt in range(12):
            time.sleep(1)
            address = urlparse(ws.eval_js("location.href", sid) or "")
            if any(s in address.path for s in ("captcha", "security", "verify")):
                return None, "verification_required"
            if "/web/user/" in address.path or "/login" in address.path:
                return None, "login_required"
            if address.scheme == "about":
                continue
            if address.hostname != expected.hostname or address.path != expected.path:
                return None, "detail_page_changed"
            raw = ws.eval_js(config["expression"], sid)
            capture = json.loads(raw) if isinstance(raw, str) else None
            if not capture:
                continue
            if capture.get("status") == "login_required" or capture.get("block_reason") == "login":
                return None, "login_required"
            if capture.get("status") == "blocked":
                return None, "verification_required"
            # A title alone does not prove the recruiter panel has loaded. Wait up
            # to 12 observations when no activity label is present; no reload loop.
            jobs = capture.get("jobs", [])
            found = len(jobs) == 1 and bool(jobs[0].get("recruitment_signals", {}).get("recruiter_activity"))
            if capture.get("status") == "job_unavailable" or (capture.get("status") == "captured" and ((attempt >= 2 and found) or attempt == 11)):
                capture.setdefault("diagnostics", {})["activity_settled"] = attempt == 11
                # Upstream supports the current recruiter footer layout as well as
                # the older scoped CSS labels. Retain only its exact activity label.
                jobs = capture.get("jobs", [])
                if capture.get("status") == "captured" and len(jobs) == 1 and not jobs[0].get("recruitment_signals", {}).get("recruiter_activity"):
                    stage = "legacy_footer"
                    raw = ws.eval_js(module.EXTRACT_DETAIL_JS, sid)
                    extracted = json.loads(raw) if isinstance(raw, str) else {}
                    final = urlparse(extracted.get("url", ""))
                    if final.hostname != expected.hostname or final.path != expected.path:
                        return None, "detail_page_changed"
                    try:
                        fields = module.extract_detail_fields(extracted)
                        activity = fields.get("boss_active_status", "").strip()
                        if re.fullmatch(r"(?:(?:刚刚|当前|目前)?在线|(?:刚刚|今日|今天|昨日|昨天|本周|本月|近期|最近|(?:\d+|[一二三四五六七八九十两]+)\s*(?:分钟|小时|天|日|周|个月|月|年)(?:前|内)|半(?:年|个月|月)(?:前|内)|(?:日|周|月)内)活跃|(?:较久|很久|长期|暂未|近\d+天未)\s*(?:未)?活跃|\d+\s*(?:分钟|小时|天)前在线)", activity):
                            jobs[0].setdefault("recruitment_signals", {})["recruiter_activity"] = [{"text": activity, "selector": "upstream:recruiter_footer"}]
                    except module.DetailLoginRequiredError:
                        return None, "login_required"
                    except module.DetailExtractionError:
                        pass
                return capture, None
        return capture, None if capture and capture.get("status") == "job_unavailable" else "capture_not_readable"
    except (TimeoutError, json.JSONDecodeError):
        return None, "capture_timeout"
    except Exception as exc:
        # Never print exception text (it may contain private URL parameters).
        connection_errors = {"ConnectionError", "ConnectionRefusedError", "ConnectionResetError", "WebSocketConnectionClosedException", "WebSocketBadStatusException", "OSError"}
        if any(cls.__name__ in connection_errors for cls in type(exc).__mro__):
            return None, "browser_unavailable"
        return None, "backfill_parse_failed" if stage == "legacy_footer" else "capture_not_readable"
    finally:
        # Cleanup cannot overwrite a successful capture or a specific login gate.
        try:
            if target:
                ws.send("Target.closeTarget", {"targetId": target})
        except Exception:
            pass
        try:
            ws.close()
        except Exception:
            pass


def detail_job(module, config, debug=None):
    """Read a ready, stable JD; no blind reading simulation or post-job sleep."""
    expected = urlparse(config['job']['job_link'])
    if expected.scheme != 'https' or expected.netloc != 'www.zhipin.com' or not expected.path.startswith('/job_detail/'):
        return None, 'detail_page_changed', {}
    if not isinstance(config.get('expression'), str) or not config['expression']:
        return None, 'detail_not_readable', {}
    ws, target = None, None
    started = time.monotonic()
    previous, stable, polls, scrolled = None, 0, 0, False
    readiness = {'reason': 'not_observed'}
    def metrics():
        return {'detail_timing': {'seconds': round(time.monotonic()-started, 3), 'polls': polls, 'lazy_scroll': scrolled}, 'detail_readiness': readiness}
    def gate(address):
        parsed = urlparse(address or '')
        if any(part in parsed.path for part in ('captcha', 'security', 'verify')):
            return 'verification_required'
        if '/web/user/' in parsed.path or '/login' in parsed.path:
            return 'login_required'
        if parsed.scheme == 'about':
            return 'loading'
        if parsed.scheme != 'https' or parsed.hostname != expected.hostname or parsed.path != expected.path:
            return 'detail_page_changed'
        return None
    try:
        module.incr_request()
        ws = module.CDPSession(19222)
        target = ws.send('Target.createTarget', {'url': module.build_detail_url(config['job']), 'background': False})['result']['targetId']
        sid = ws.send('Target.attachToTarget', {'targetId': target, 'flatten': True})['result']['sessionId']
        for attempt in range(20):
            time.sleep(1)
            polls += 1
            before = gate(ws.eval_js('location.href', sid))
            if before == 'loading':
                stable, previous = 0, None
                continue
            if before:
                return None, before, metrics()
            capture = json.loads(ws.eval_js(config['expression'], sid) or '{}')
            if capture.get('status') == 'login_required' or capture.get('block_reason') == 'login':
                return None, 'login_required', metrics()
            if capture.get('status') == 'blocked':
                return None, 'verification_required', metrics()
            if capture.get('status') == 'job_unavailable':
                readiness = {'reason': 'job_unavailable'}
                if debug:
                    debug.write('detail_probe', poll=polls, **readiness)
                after = gate(ws.eval_js('location.href', sid))
                if after:
                    return None, 'detail_page_changed' if after == 'loading' else after, metrics()
                # A closure is evidence, not a fabricated successful JD. Node
                # validates identity/evidence and only updates an existing job.
                return capture, None, metrics()
            raw = ws.eval_js(module.EXTRACT_DETAIL_JS, sid)
            extracted = json.loads(raw) if isinstance(raw, str) else {}
            # Recheck after both DOM reads: never attribute another job's JD.
            after = gate(ws.eval_js('location.href', sid))
            if after:
                return None, 'detail_page_changed' if after == 'loading' else after, metrics()
            if gate(extracted.get('url')):
                return None, 'detail_page_changed', metrics()
            jobs = capture.get('jobs') or []
            readable = False
            fields = None
            try:
                # The application's short_unverified state accepts nonempty
                # short descriptions. Retain upstream login/navigation/footer
                # validation, but don't equate its default 120 chars with completeness.
                fields = module.extract_detail_fields(extracted, min_length=1)
                readable = capture.get('status') == 'captured' and len(jobs) == 1 and bool(jobs[0].get('title')) and bool(jobs[0].get('jd')) and not jobs[0].get('jd_truncated')
                if readable and gate(jobs[0].get('url')):
                    return None, 'detail_page_changed', metrics()
            except module.DetailLoginRequiredError:
                return None, 'login_required', metrics()
            except module.DetailExtractionError:
                pass
            ready = ws.eval_js('document.readyState', sid) == 'complete'
            job = jobs[0] if len(jobs) == 1 else {}
            reason = 'shared_not_captured' if capture.get('status') != 'captured' or len(jobs) != 1 else 'title_missing' if not job.get('title') else 'jd_missing' if not job.get('jd') else 'jd_truncated' if job.get('jd_truncated') else 'upstream_parse_failed' if not fields else 'page_loading' if not ready else 'ready' if readable else 'not_readable'
            readiness = {'reason': reason, 'shared_jd_chars': len(job.get('jd') or ''), 'upstream_jd_chars': len((fields or {}).get('jd') or ''), 'title_found': bool(job.get('title')), 'ready': ready}
            if debug:
                debug.write('detail_probe', poll=polls, **readiness)
            fingerprint = (fields['jd'], jobs[0].get('title'), jobs[0].get('jd'), tuple(extracted.get('tags') or [])) if readable else None
            stable = stable+1 if readable and ready and fingerprint == previous else 1 if readable and ready else 0
            previous = fingerprint if readable and ready else None
            if stable >= 3:
                extracted.update(fields)
                # Retain the actual detail title for the adapter's conflict check.
                record = module.build_detail_record({**config['job'], 'title': jobs[0]['title']}, extracted)
                return [record], None, metrics()
            if not readable and attempt >= 2 and not scrolled:
                # Only attempt lazy loading for a missing/invalid description.
                # No synthetic mouse movement, random reading, clicks or reloads.
                ws.eval_js("(()=>{const el=document.querySelector('.job-detail-section,.job-sec');if(el){el.scrollIntoView({block:'start'});return true;}return false;})()", sid)
                scrolled = True
        return None, 'detail_not_readable', metrics()
    except module.DetailLoginRequiredError:
        return None, 'login_required', metrics()
    except (TimeoutError, json.JSONDecodeError):
        return None, 'capture_timeout', metrics()
    except Exception as exc:
        names = {'ConnectionError', 'ConnectionRefusedError', 'ConnectionResetError', 'WebSocketConnectionClosedException', 'WebSocketBadStatusException', 'OSError'}
        return None, 'browser_unavailable' if any(c.__name__ in names for c in type(exc).__mro__) else 'detail_failed', metrics()
    finally:
        try:
            if ws and target:
                ws.send('Target.closeTarget', {'targetId': target})
        except Exception:
            pass
        try:
            if ws:
                ws.close()
        except Exception:
            pass


def main():
    mode, source, output = sys.argv[1:4]
    config = json.loads(Path(source).read_text(encoding="utf-8"))
    debug = DebugLog(Path(output).with_name(Path(output).name.replace('-output.json','-debug.jsonl')), mode, config.get('keyword'))
    debug.write('bridge_start')
    upstream = Path(__file__).resolve().parents[1] / "vendor/boss-zhipin-scraper/scripts/boss_cdp_raw.py"
    sys.path.insert(0, str(upstream.parent))
    spec = importlib.util.spec_from_file_location("collector_upstream", upstream)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    error = None
    payload = None
    open_result = {}
    # Keep imported scripts' prints/loggers private too.
    with open(os.devnull, "w", encoding="utf-8") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        spec.loader.exec_module(module)
        targets = []
        original_create = module.create_page_session

        def create_session(connection):
            target, session = original_create(connection)
            targets.append((connection, target))
            return target, session

        module.create_page_session = create_session
        if mode == "open":
            open_result = open_job(module, config["job"])
        elif mode == "backfill":
            payload, error = backfill_job(module, config)
            if payload is not None:
                Path(output).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        elif mode == "list":
            payload, error, diagnostic = collect_search(module, config, output, debug)
            open_result['search_diagnostics'] = diagnostic
        elif mode == "detail":
            payload, error, open_result = detail_job(module, config, debug)
            if payload is not None:
                Path(output).write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        else:
            error = "invalid_operation"
        # Upstream does not close a detail session on every exception path.
        # Only close target IDs created by this invocation, never user tabs.
        for connection, target in targets:
            try:
                connection.send("Target.closeTarget", {"targetId": target})
                connection.close()
            except Exception:
                pass
    debug.write('bridge_end', error=error, **{key: open_result[key] for key in ('detail_timing', 'detail_readiness') if key in open_result})
    print(json.dumps({"ok": error is None, "error": error, "debug_write_failed": debug.failed, **open_result,
                      "count": len(payload.get("jobs", [])) if isinstance(payload, dict) else len(payload or []),
                      "observed_at": datetime.now().astimezone().isoformat()}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        try:
            path = Path(sys.argv[3]); DebugLog(path.with_name(path.name.replace('-output.json','-debug.jsonl')), sys.argv[1]).exception('bridge_exception', exc)
        except Exception:
            pass
        print(json.dumps({"ok": False, "error": "bridge_failed"}), flush=True)
        sys.exit(1)
