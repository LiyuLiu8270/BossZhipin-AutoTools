// Explicit opt-in only: public company name, configured model and external sources.
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {researchCompanyNative as researchCompany} from '../local/company-research-native.mjs';
if(!process.argv.includes('--live'))throw Error('pass --live to permit a real model/search request');
const company=process.argv.find(v=>v.startsWith('--company='))?.slice(10);if(!company)throw Error('pass --company=full-name');
const proofDir=new URL('../local/data/research-browser-proof/',import.meta.url);mkdirSync(proofDir,{recursive:true});
const cwd=mkdtempSync(join(fileURLToPath(proofDir),'run-'));
const report=await researchCompany({company},{cwd,timeoutMs:600000,onTrace:event=>console.log(JSON.stringify({progress:event}))}).catch(e=>{console.log(JSON.stringify({error:e.message}));process.exit(1);});
writeFileSync(join(cwd,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({reportPath:join(cwd,'report.json')}));
console.log(JSON.stringify({method:report.research_method,modelCalls:report.model_calls,trace:report.tool_trace,status:report.status,characters:report.markdown.length,sources:report.sources.map(s=>s.url),warnings:report.warnings}));
