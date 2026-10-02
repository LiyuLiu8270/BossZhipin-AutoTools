import importlib.util
import json
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('search_diagnostics', Path(__file__).resolve().parents[1]/'local/search_diagnostics.py')
sd = importlib.util.module_from_spec(spec); spec.loader.exec_module(sd)


def response(jobs=1, more=True, code=0):
    return {'code':code, 'zpData':{'jobList':[{'title':'synthetic', 'securityId':'DO_NOT_LOG'}]*jobs, 'hasMore':more}}


def fake_module(sequence, route='search', gate=None, connection_failure=False):
    class CDP:
        def __init__(self):
            self.events = []
        def send(self, method, *args, **kwargs):
            if connection_failure:
                raise ConnectionError('PRIVATE_URL_AND_COOKIE')
            return {'result':{}}
        def eval_js(self, js, sid):
            if connection_failure:
                self.send('Runtime.evaluate')
            return json.dumps({'route':route,'gate':gate,'ready':'complete','visibility':'visible','focused':True,'cards':2,
                               'scroll':[{'name':'window','top':0,'height':1000,'client':500}]})
    class Capture:
        def __init__(self):
            self.cdp,self.sid = CDP(),'test-session'
        def _fetch_body(self,rid):
            return 'not json PRIVATE_SECRET'
        def wait_next_response(self,*args,**kwargs):
            if connection_failure:
                self.cdp.send('Network.getResponseBody')
            item=sequence.pop(0) if sequence else None
            if isinstance(item,dict) and item.get('invalid_body'):
                self.cdp.events.extend([
                    {'sessionId':self.sid,'method':'Network.requestWillBeSent','params':{'requestId':'private-request','request':{'url':'https://www.zhipin.com/wapi/zpgeek/search/joblist.json?page=2&securityId=PRIVATE_SECRET','headers':{'Cookie':'PRIVATE_COOKIE'}}}},
                    {'sessionId':self.sid,'method':'Network.responseReceived','params':{'requestId':'private-request','response':{'status':502,'headers':{'Authorization':'PRIVATE_AUTH'}}}},
                    {'sessionId':self.sid,'method':'Network.loadingFinished','params':{'requestId':'private-request'}}])
                self._fetch_body('private-request');return None
            return item
    module=types.SimpleNamespace(CDPSession=CDP,NetworkJoblistCapture=Capture)
    module.classify_login_probe_response=lambda d:types.SimpleNamespace(status=types.SimpleNamespace(value='restricted' if d['code']==37 else 'unauthenticated' if d['code']==1 else 'available' if d['zpData']['jobList'] else 'empty'))
    module.map_api_jobs=lambda d:d['zpData']['jobList']
    def scrape(keyword,city,pages,filters,output,**kwargs):
        capture=module.NetworkJoblistCapture();jobs=[]
        try:
            for _ in range(pages):
                data=capture.wait_next_response(timeout=20)
                if data is None:
                    continue
                jobs.extend(module.map_api_jobs(data))
                Path(output).write_text(json.dumps({'jobs':jobs,'keyword':keyword}),encoding='utf-8')
                if data['zpData']['hasMore'] is False:
                    break
        except RuntimeError:
            pass  # Pinned upstream swallows this; instrumentation must retain reason.
    module.scrape_list=scrape
    return module


class SearchDiagnosticsTests(unittest.TestCase):
    def test_normal_progress_after_500_seconds_and_bounded_budget(self):
        for budget, elapsed, expected in [(1260, 514, 'explicit_end'), (120, 121, 'keyword_time_budget')]:
            with tempfile.TemporaryDirectory() as tmp:
                module=fake_module([response(more=False)])
                ticks=iter([0]+[elapsed]*100)
                with patch.object(sd.time,'monotonic',side_effect=lambda:next(ticks)):
                    payload,error,diag=sd.collect_search(module,{'keyword':'合成','city':'101280600','pages':20,'keywordBudgetSeconds':budget},str(Path(tmp)/'out.json'),sd.DebugLog(Path(tmp)/'debug.jsonl','list'))
                self.assertEqual(diag['stop_reason'],expected)
                self.assertEqual(diag['budget_seconds'],budget)
                self.assertEqual(diag['partial'],expected=='keyword_time_budget')

    def run_case(self, sequence, pages=4, **kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'debug.jsonl'
            module=fake_module(sequence,**kwargs)
            original=module.NetworkJoblistCapture.wait_next_response
            result=sd.collect_search(module,{'keyword':'合成词','city':'101280600','pages':pages},str(Path(tmp)/'out.json'),sd.DebugLog(file,'list','合成词'))
            self.assertIs(module.NetworkJoblistCapture.wait_next_response,original)
            return result,file.read_text(encoding='utf-8')

    def test_single_timeout_does_not_poison_recovered_pages(self):
        (payload,error,diag),log=self.run_case([response(),None,response(more=False)])
        self.assertIsNone(error);self.assertEqual(len(payload['jobs']),2)
        self.assertEqual(diag['missing_responses'],1);self.assertTrue(diag['partial'])
        self.assertEqual(diag['stop_reason'],'explicit_end');self.assertEqual(diag['warnings'][0]['page'],2)
        self.assertIn('request_not_observed',log);self.assertNotIn('DO_NOT_LOG',log)

    def test_three_consecutive_timeouts_end_only_keyword(self):
        (payload,error,diag),log=self.run_case([response(),None,None,None],pages=20)
        self.assertIsNone(error);self.assertEqual(len(payload['jobs']),1)
        self.assertEqual(diag['pages_observed'],4);self.assertEqual(diag['stop_reason'],'consecutive_no_response')
        (payload,error,diag),_=self.run_case([None,None,None],pages=20)
        self.assertIsNone(payload);self.assertEqual(error,'no_search_response');self.assertTrue(diag['partial'])

    def test_explicit_empty_is_valid_not_timeout(self):
        (payload,error,diag),_=self.run_case([response(jobs=0,more=False)])
        self.assertIsNone(error);self.assertEqual(payload['jobs'],[]);self.assertFalse(diag['partial'])

    def test_login_verification_and_navigation_still_stop(self):
        for code,expected in [(1,'login_required'),(37,'verification_required')]:
            (_,error,diag),_=self.run_case([response(),response(code=code)])
            self.assertEqual(error,expected);self.assertEqual(diag['stop_reason'],expected)
        (_,error,_),_=self.run_case([response()],gate='verification_required')
        self.assertEqual(error,'verification_required')
        (_,error,_),_=self.run_case([response()],route='other')
        self.assertEqual(error,'search_page_changed')

    def test_connection_failure_persists_safe_stack(self):
        (_,error,_),log=self.run_case([response()],connection_failure=True)
        self.assertEqual(error,'browser_unavailable');self.assertIn('ConnectionError',log)
        self.assertIn('frames',log);self.assertNotIn('PRIVATE_URL',log)

    def test_network_and_body_evidence_excludes_secrets(self):
        (_,error,diag),log=self.run_case([{'invalid_body':True},response(more=False)])
        self.assertIsNone(error);self.assertEqual(diag['warnings'][0]['reason'],'http_error')
        self.assertIn('502',log);self.assertIn('response_body',log)
        for private in ['PRIVATE_SECRET','PRIVATE_COOKIE','PRIVATE_AUTH','private-request','securityId','headers']:
            self.assertNotIn(private,log)

    def test_response_reason_breakdown_and_safe_page(self):
        self.assertEqual(sd.missing_reason({},0),'request_not_observed')
        row={'status':200,'finished':False,'failed':False}
        self.assertEqual(sd.missing_reason({'a':row},0),'response_not_finished')
        row['finished']=True
        self.assertEqual(sd.missing_reason({'a':row},1),'response_body_unreadable')
        self.assertEqual(sd.missing_reason({'a':row},0),'response_not_consumed')
        row['failed']=True
        self.assertEqual(sd.missing_reason({'a':row},0),'request_failed')
        self.assertNotIn('PRIVATE',json.dumps(sd.safe_page({'url':'PRIVATE','text':'PRIVATE','headers':'PRIVATE'})))


if __name__=='__main__':
    unittest.main()
