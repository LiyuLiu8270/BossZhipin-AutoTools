import test from 'node:test';
import assert from 'node:assert/strict';
import {researchURL,publicAddress,ResearchBrowser,accessChallenge} from '../local/research-browser.mjs';
import {readFileSync} from 'node:fs';
test('公开浏览器拒绝内网、文件、BOSS登录域，DNS也必须全是公网',async()=>{
 for(const url of ['file:///C:/Users/test/resume.docx','http://127.0.0.1:17321','http://192.168.1.2','http://localhost','https://foo.local','https://foo.internal','https://www.zhipin.com/web/geek/chat','https://zhipin.com.','https://foo.zhipin.com','https://u:p@example.com','http://2130706433','http://[::1]'])assert.equal(researchURL(url),null,url);
 assert.equal(researchURL('https://www.bing.com/search?q=test'),'https://www.bing.com/search?q=test');
 await assert.rejects(publicAddress('example.com',{resolve:async()=>[{address:'127.0.0.1'}]}),/blocked/);
 await assert.rejects(publicAddress('example.com',{resolve:async()=>[{address:'8.8.8.8'},{address:'10.0.0.1'}]}),/blocked/);
 assert.equal(await publicAddress('example.com',{resolve:async()=>[{address:'8.8.8.8'}]}),'8.8.8.8');
});
test('验证页不计为有效网页，正文仅提及验证码不误判',()=>{
 for(const page of [{url:'https://qcaptcha.so.com/?ret=x',title:'360搜索'},{url:'https://www.sogou.com/antispider/?m=1',title:'搜狗搜索'},{url:'https://wappass.baidu.com/static/captcha/tuxing_v2.html',title:'百度安全验证'}])assert.equal(accessChallenge(page),true);
 assert.equal(accessChallenge({url:'https://example.com/product',title:'安全产品',text:'支持验证码功能'}),false);
});
test('非法URL在启动浏览器前拒绝；使用独立临时profile及固定公网代理',async()=>{
 const b=new ResearchBrowser();b.start=async()=>{throw Error('must_not_start');};await assert.rejects(b.open('http://127.0.0.1'),/url_blocked/);await b.close();
 const code=readFileSync(new URL('../local/research-browser.mjs',import.meta.url),'utf8');assert.match(code,/mkdtempSync/);assert.match(code,/proxy-bypass-list=<-loopback>/);assert.doesNotMatch(code,/19222|user-data-dir.*profilePath/);assert.match(code,/behavior:'deny'/);
 const mcp=readFileSync(new URL('../local/research-browser-mcp.mjs',import.meta.url),'utf8');assert.doesNotMatch(mcp,/browser_evaluate|browser_click|browser_type/);
});
