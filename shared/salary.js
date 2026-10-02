// Conservative display-time parsing only; never rewrite original salary text.
const bands={under10:[0,10000], '10-15':[10000,15000], '15-20':[15000,20000], '20-30':[20000,30000], '30-50':[30000,50000], '50plus':[50000,Infinity]};
export function monthlySalary(value){
  if(typeof value!=='string')return null;
  const text=value.normalize('NFKC').trim().replace(/\s+/g,'');
  const m=text.match(/^(\d+(?:\.\d+)?)([kK万千元]?)(?:[-–—~至](\d+(?:\.\d+)?)([kK万千元]?))?(?:元)?(?:\/月|每月)?(?:[·•*x×](?:\d+)薪)?$/);
  if(!m)return null;
  const unit=m[4]||m[2];if(!unit)return null;
  const scale=u=>/[kK千]/.test(u)?1000:u==='万'?10000:1;
  const min=Number(m[1])*scale(m[2]||unit),max=m[3]?Number(m[3])*scale(m[4]||unit):min;
  return min>0&&max>=min?{min,max}:null;
}
export function salaryMatches(value,filter=''){
  if(!filter)return true;
  const salary=monthlySalary(value);
  if(filter==='unknown')return !salary;
  const band=bands[filter];
  if(!band)return false;
  return !!salary&&salary.max>=band[0]&&salary.min<band[1];
}
