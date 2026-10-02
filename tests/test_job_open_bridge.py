import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).resolve().parents[1] / "local/scraper-bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class ExtractError(Exception):
    pass


class LoginError(ExtractError):
    pass


class OpenTests(unittest.TestCase):
    def run_open(self, data, extract=None, focused=True):
        calls = []

        class Session:
            def __init__(self, port):
                self.port = port

            def send(self, method, params=None, sid=None):
                calls.append((method, params, sid))
                if method == 'SystemInfo.getProcessInfo':
                    return {'result': {'processInfo': [{'id': 1234, 'type': 'browser'}]}}
                return {"result": {"targetId": "new-tab", "sessionId": "new-session"}}

            def eval_js(self, js, sid):
                self.assert_sid = sid
                return json.dumps(data)

            def close(self):
                calls.append(("disconnect", None, None))

        module = types.SimpleNamespace(CDPSession=Session, build_detail_url=lambda job: job["job_link"] + "?securityId=test",
                                       EXTRACT_DETAIL_JS="read-only DOM extraction", extract_detail_fields=extract or (lambda d: {"jd": d.get("jd", "")}),
                                       DetailExtractionError=ExtractError, DetailLoginRequiredError=LoginError)
        with patch.object(bridge.time, "sleep"), patch.object(bridge, 'WindowFocus') as focus:
            focus.return_value.activate.return_value = focused
            result = bridge.open_job(module, {"job_link": "https://www.zhipin.com/job_detail/abc.html"})
            focus.assert_called_once_with(1234)
        return result, calls

    def test_open_is_foreground_and_never_closes_user_tab(self):
        result, calls = self.run_open({"url": "https://www.zhipin.com/job_detail/abc.html?securityId=test", "jd": "岗位描述" * 40})
        self.assertEqual(result["page_state"], "detail_visible")
        self.assertTrue(result["opened"])
        create = next(c for c in calls if c[0] == 'Target.createTarget')
        self.assertFalse(create[1]['background'])
        self.assertTrue(create[1]['newWindow'])
        self.assertTrue(result['foregrounded'])
        self.assertFalse(any(c[0] in ("Target.closeTarget", "Page.navigate", "Page.addScriptToEvaluateOnNewDocument") for c in calls))

    def test_login_and_validation_are_handoffs(self):
        def needs_login(data):
            raise LoginError()
        result, _ = self.run_open({"url": "https://www.zhipin.com/web/user/login"}, needs_login)
        self.assertEqual(result["page_state"], "login_required")
        result, _ = self.run_open({"url": "https://www.zhipin.com/captcha", "page_text": "请完成安全验证"})
        self.assertEqual(result["page_state"], "verification_required")

    def test_wrong_job_cannot_claim_visible_details(self):
        result, _ = self.run_open({"url": "https://www.zhipin.com/job_detail/other.html", "jd": "其他岗位" * 40})
        self.assertEqual(result["page_state"], "page_changed")

    def test_foreground_denied_keeps_open_success_without_claiming_focus(self):
        result, _ = self.run_open({'url': 'https://www.zhipin.com/job_detail/abc.html', 'jd': '岗位描述'}, focused=False)
        self.assertTrue(result['opened'])
        self.assertFalse(result['foregrounded'])


class BackfillTests(unittest.TestCase):
    def probe(self, labels=None, connect_error=False, close_error=False, parse_error=False, footer=""):
        calls, count = [], [0]
        class Session:
            def __init__(self, port):
                if connect_error:
                    raise ConnectionError("private connection diagnostics")
            def send(self, method, params=None, sid=None):
                calls.append((method, params))
                if close_error and method == "Target.closeTarget":
                    raise ConnectionError("tab already closed")
                return {"result": {"targetId": "owned", "sessionId": "sid"}}
            def eval_js(self, js, sid):
                if js == "location.href":
                    return "https://www.zhipin.com/job_detail/abc.html"
                if js == "legacy":
                    if parse_error:
                        raise ValueError("private malformed response")
                    return json.dumps({"url":"https://www.zhipin.com/job_detail/abc.html"})
                index = count[0]
                count[0] += 1
                label = (labels or [""])[min(index, len(labels or [""])-1)]
                return json.dumps({"status":"captured", "jobs":[{"recruitment_signals":{"recruiter_activity":[{"text":label}] if label else []}}], "diagnostics":{"activity":{"recruiter_panel_ready":True,"unrecognized_labels":[]}}})
            def close(self):
                if close_error:
                    raise ConnectionError("private cleanup error")
        module=types.SimpleNamespace(CDPSession=Session,build_detail_url=lambda j:j["job_link"],EXTRACT_DETAIL_JS="legacy",extract_detail_fields=lambda d:{"boss_active_status":footer},DetailExtractionError=ExtractError,DetailLoginRequiredError=LoginError)
        with patch.object(bridge.time,"sleep"):
            result=bridge.backfill_job(module,{"job":{"job_link":"https://www.zhipin.com/job_detail/abc.html"},"expression":"read-only"})
        return result,count[0],calls

    def test_browser_connection_loss_is_gate_not_generic_bridge_failure(self):
        (capture,error),count,calls=self.probe(connect_error=True)
        self.assertEqual(error,"browser_unavailable")
        self.assertIsNone(capture)
        self.assertEqual(count,0)

    def test_late_activity_is_not_lost_at_old_six_second_cutoff(self):
        (capture,error),count,calls=self.probe(labels=[""]*8+["半年前活跃"])
        self.assertIsNone(error)
        self.assertEqual(count,9)
        self.assertEqual(capture["jobs"][0]["recruitment_signals"]["recruiter_activity"][0]["text"],"半年前活跃")

    def test_absence_waits_for_bounded_settle_and_cleanup_cannot_erase_capture(self):
        (capture,error),count,calls=self.probe(close_error=True)
        self.assertIsNone(error)
        self.assertEqual(count,12)
        self.assertTrue(capture["diagnostics"]["activity_settled"])

    def test_legacy_footer_accepts_half_year_but_not_arbitrary_activity_prose(self):
        for text,expected in [("半年前活跃",True),("六个月前活跃",True),("负责提升用户活跃",False)]:
            (capture,error),_,_=self.probe(footer=text)
            self.assertIsNone(error)
            self.assertEqual(bool(capture["jobs"][0]["recruitment_signals"]["recruiter_activity"]),expected)

    def test_parse_errors_are_not_misreported_as_browser_offline(self):
        (_,error),_,_=self.probe(parse_error=True)
        self.assertEqual(error,"backfill_parse_failed")

    def run_capture(self, address, capture):
        calls = []

        class Session:
            def __init__(self, port):
                pass

            def send(self, method, params=None, sid=None):
                calls.append((method, params))
                return {"result": {"targetId": "owned", "sessionId": "sid"}}

            def eval_js(self, js, sid):
                return address if js == "location.href" else json.dumps(capture)

            def close(self):
                calls.append(("disconnect", {}))

        module = types.SimpleNamespace(CDPSession=Session, build_detail_url=lambda j: j["job_link"])
        with patch.object(bridge.time, "sleep"):
            result = bridge.backfill_job(module, {"job": {"job_link": "https://www.zhipin.com/job_detail/abc.html"}, "expression": "read-only"})
        return result, calls

    def test_capture_closes_only_owned_target_without_visibility_override(self):
        (capture, error), calls = self.run_capture("https://www.zhipin.com/job_detail/abc.html", {"status": "captured", "jobs": []})
        self.assertIsNone(error)
        self.assertEqual(capture["status"], "captured")
        self.assertIn(("Target.closeTarget", {"targetId": "owned"}), calls)
        self.assertFalse(any(c[0] in ("Page.addScriptToEvaluateOnNewDocument", "Page.reload") for c in calls))

    def test_gate_or_redirect_never_saved(self):
        for url, capture, error in [
            ("https://www.zhipin.com/captcha", {}, "verification_required"),
            ("https://www.zhipin.com/web/user/login", {}, "login_required"),
            ("https://www.zhipin.com/job_detail/other.html", {}, "detail_page_changed"),
            ("https://www.zhipin.com/job_detail/abc.html", {"status": "blocked", "block_reason": "login"}, "login_required"),
        ]:
            (data, actual), calls = self.run_capture(url, capture)
            self.assertIsNone(data)
            self.assertEqual(actual, error)
            self.assertIn(("Target.closeTarget", {"targetId": "owned"}), calls)


if __name__ == "__main__":
    unittest.main()
