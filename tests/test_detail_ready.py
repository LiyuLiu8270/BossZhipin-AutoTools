import importlib.util
import json
from pathlib import Path
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('detail_bridge', Path(__file__).resolve().parents[1] / 'local/scraper-bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class ExtractionError(Exception):
    pass

class LoginError(ExtractionError):
    pass

URL = 'https://www.zhipin.com/job_detail/abc.html'

class DetailReadyTests(unittest.TestCase):
    def run_detail(self, descriptions=None, status='captured', address=URL, after_address=None, truncated=False, close_error=False, ready='complete', login_wall=False, extracted_url=URL, shared_url=URL):
        descriptions = descriptions or ['有效职位描述' * 40]
        calls, sleeps, indices = [], [], [-1]
        class Session:
            def __init__(self, port):
                assert port == 19222
                self.locations = 0
            def send(self, method, params=None, sid=None):
                calls.append((method, params))
                if close_error and method == 'Target.closeTarget':
                    raise ConnectionError('private')
                return {'result': {'targetId': 'owned', 'sessionId': 'sid'}}
            def eval_js(self, expression, sid):
                calls.append(('eval', expression))
                if expression == 'location.href':
                    self.locations += 1
                    return after_address if after_address and self.locations >= 2 else address
                if expression == 'capture':
                    indices[0] += 1
                    jd = descriptions[min(indices[0], len(descriptions)-1)]
                    return json.dumps({'status': status, 'jobs': [{'url': shared_url, 'title': '产品经理', 'jd': jd, 'jd_truncated': truncated, 'company_identity': {'state':'platform_verified', 'full_name':'合成有限公司', 'source_url': URL}}]})
                if expression == 'extract':
                    jd = descriptions[min(indices[0], len(descriptions)-1)]
                    return json.dumps({'url': extracted_url, 'jd': jd, 'tags': ['需求分析']})
                if expression == 'document.readyState':
                    return ready
                return True
            def close(self):
                calls.append(('disconnect', None))
                if close_error:
                    raise ConnectionError('private')
        def extract(value, min_length=120):
            if login_wall:
                raise LoginError()
            if not value.get('jd') or len(value['jd']) < min_length:
                raise ExtractionError()
            return {'jd': value['jd'], 'boss_active_status': ''}
        module = types.SimpleNamespace(incr_request=lambda:None, CDPSession=Session, build_detail_url=lambda j:j['job_link'], EXTRACT_DETAIL_JS='extract', extract_detail_fields=extract,
            build_detail_record=lambda job, raw:{'title': job['title'], 'jd': raw['jd'], 'job_link': job['job_link']}, DetailExtractionError=ExtractionError, DetailLoginRequiredError=LoginError)
        with patch.object(bridge.time, 'sleep', side_effect=lambda seconds:sleeps.append(seconds)):
            result = bridge.detail_job(module, {'job': {'job_link': URL, 'title': '产品经理'}, 'expression': 'capture'})
        return result, calls, sleeps

    def test_stable_ready_jd_finishes_in_three_polls_without_scroll_or_extra_sleep(self):
        (payload, error, meta), calls, sleeps = self.run_detail(close_error=True)
        self.assertIsNone(error)
        self.assertEqual(meta['detail_timing']['polls'], 3)
        self.assertEqual(sleeps, [1, 1, 1])
        self.assertFalse(meta['detail_timing']['lazy_scroll'])
        self.assertTrue(payload[0]['jd'])
        self.assertEqual(payload[0]['company_identity']['full_name'], '合成有限公司')
        self.assertEqual(payload[0]['company_identity']['source_url'], URL)
        self.assertIn(('Target.closeTarget', {'targetId': 'owned'}), calls)
        self.assertFalse(any(c[0] in ('Page.reload', 'Input.dispatchMouseEvent') for c in calls))

    def test_jd_changes_reset_stability(self):
        (payload, error, meta), _, _ = self.run_detail(['第一段'*40, '第二段'*40, '全文'*100])
        self.assertIsNone(error)
        self.assertEqual(meta['detail_timing']['polls'], 5)
        self.assertEqual(payload[0]['jd'], '全文'*100)

    def test_late_jd_gets_one_lazy_scroll_not_fixed_simulation(self):
        (payload, error, meta), calls, _ = self.run_detail(['']*5+['全文'*100])
        self.assertIsNone(error)
        self.assertEqual(meta['detail_timing']['polls'], 8)
        self.assertEqual(sum('scrollIntoView' in str(c) for c in calls), 1)

    def test_loading_truncated_and_unstable_never_return_success(self):
        for args in [{'ready':'loading'},{'truncated':True},{'descriptions':['']},{'descriptions':[str(i)*100 for i in range(20)]}]:
            (payload, error, _), _, sleeps = self.run_detail(**args)
            self.assertIsNone(payload)
            self.assertEqual(error, 'detail_not_readable')
            self.assertEqual(len(sleeps),20)

    def test_gates_never_persist_even_when_jd_present(self):
        for args, expected in [({'status':'blocked'},'verification_required'),({'status':'login_required'},'login_required'),({'login_wall':True},'login_required'),({'address':'https://www.zhipin.com/captcha'},'verification_required'),({'address':'https://www.zhipin.com/web/user/login'},'login_required'),({'after_address':'https://www.zhipin.com/job_detail/other.html'},'detail_page_changed')]:
            (payload,error,_), calls,_=self.run_detail(**args)
            self.assertIsNone(payload)
            self.assertEqual(error,expected)
            self.assertIn(('Target.closeTarget',{'targetId':'owned'}),calls)

    def test_closed_page_is_not_valid_jd(self):
        (payload,error,_),_,_=self.run_detail(status='job_unavailable')
        self.assertEqual(payload['status'], 'job_unavailable')
        self.assertIsNone(error)

    def test_identity_log_distinguishes_blank_parse_url_from_actual_navigation(self):
        for args, stage, actual, observed in [
            ({'extracted_url':''}, 'extracted_url', URL, ''),
            ({'shared_url':URL.replace('abc', 'wrong')}, 'shared_job_url', URL, URL.replace('abc','wrong')),
            ({'after_address':URL.replace('abc','other')+'?securityId=SECRET'}, 'after_extract_location', URL.replace('abc','other'), URL.replace('abc','other')),
        ]:
            (payload,error,meta),_,_=self.run_detail(**args)
            self.assertIsNone(payload)
            self.assertEqual(error,'detail_page_changed')
            self.assertEqual(meta['detail_identity']['stage'],stage)
            self.assertEqual(meta['detail_identity']['actual_url'],actual)
            self.assertEqual(meta['detail_identity']['observed_url'],observed)
            self.assertEqual(meta['detail_identity']['expected_url'],URL)
            self.assertNotIn('SECRET',json.dumps(meta))

    def test_short_jd_is_accepted_only_after_stable_ready_polls(self):
        (payload, error, meta), _, sleeps = self.run_detail(descriptions=['真实短岗位职责' * 8])
        self.assertIsNone(error)
        self.assertLess(len(payload[0]['jd']), 120)
        self.assertEqual(len(sleeps), 3)
        self.assertEqual(meta['detail_readiness']['reason'], 'ready')

if __name__ == '__main__':
    unittest.main()
