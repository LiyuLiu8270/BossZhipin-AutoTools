export const RESUME_PROFILE_VERSION='resume-fulltext-v1';
// Privacy masking only, never summarization or selection of experience.
export function privateText(value){return String(value).replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[邮箱已隐藏]').replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g,'[手机号已隐藏]');}
export function resumeProfile(document){
  if(!document)return {mode:'resume_missing',source:'尚未导入Word简历',facts:{}};
  const facts=Object.fromEntries(document.blocks.map(b=>[b.id,privateText(b.text)]));
  if(!Object.keys(facts).length)throw new Error('resume_required');
  return {mode:'resume_fulltext',version:RESUME_PROFILE_VERSION,source:document.filename,resume_id:document.id,resume_sha256:document.sha256,
    facts,parsing_warnings:document.warnings||[],note:'facts为按原文顺序编号的全部简历段落与表格，仅遮蔽手机号和邮箱，不含人工或模型摘要。'};
}
