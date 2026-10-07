// Search-only aliases: never rewrite companies, identities, match inputs or reports.
export const normalizeSearch=value=>typeof value==='string'?value.normalize('NFKC').toLowerCase().replace(/\s+/gu,''):'';
const key=row=>JSON.stringify([row.dataset,row.id]);
function platformURL(value,kind){
 if(typeof value!=='string'||!value)return null;
 try{const u=new URL(value);return u.origin==='https://www.zhipin.com'&&!u.username&&!u.password&&new RegExp(`^/${kind}/[\\w~.-]+\\.html$`).test(u.pathname)?u.origin+u.pathname:null;}catch{return null;}
}
function evidence(job){
 if(['headhunter','agency','conflicting'].includes(job.hiring_party?.type))return {page:null,name:null};
 const i=job.company_identity;
 if(i?.state==='conflict')return {page:null,name:null};
 const pages=new Set([job.company_url,job.scraper_source?.list?.company_link,i?.company_url].map(u=>platformURL(u,'gongsi')).filter(Boolean));
 const page=pages.size===1?[...pages][0]:null;
 const bound=i?.source_kind==='job_detail'&&platformURL(i.source_url,'job_detail')!==null&&platformURL(i.source_url,'job_detail')===platformURL(job.url,'job_detail')
  ||i?.source_kind==='company_page'&&page!==null&&platformURL(i.source_url,'gongsi')===page;
 const name=i?.state==='platform_verified'&&bound&&typeof i.full_name==='string'&&i.full_name.trim()?i.full_name.trim():null;
 return {page,name};
}
export function buildJobSearchIndex(rows){
 const groups=new Map(),entries=[];
 for(const row of rows){
  const job=row.job,{page,name}=evidence(job),groupKey=page?JSON.stringify([row.dataset,page]):null;
  if(groupKey){let group=groups.get(groupKey);if(!group){group={names:new Map(),displays:new Set()};groups.set(groupKey,group);}
   if(name)group.names.set(normalizeSearch(name),name);if(job.company)group.displays.add(job.company);
  }
  entries.push({row,groupKey,name});
 }
 return new Map(entries.map(({row,groupKey,name})=>{
  const group=groups.get(groupKey),aliases=group?.names.size===1?[...group.names.values(),...group.displays]:[];
  return [key(row),[row.job.title,row.job.company,row.job.location,name,...aliases].map(normalizeSearch).filter(Boolean)];
 }));
}
export function matchesJobSearch(index,dataset,id,query){return !query||(index.get(JSON.stringify([dataset,id]))||[]).some(text=>text.includes(query));}
