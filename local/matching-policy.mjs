import {createHash} from 'node:crypto';

export const MATCHER_VERSION='codex-match-v4-assessment';
export const GREETER_VERSION='greeting-v2-semantic';
export const POLICY_LIMITS={matchingSkill:20000,greetingStyle:4000};
export const GREETING_PRESETS=[
  {id:'concise',name:'简洁直接',text:'用简洁直接的中文，约60–100字。先说明关注的岗位，再用一项最相关的真实经历说明匹配点，最后表达沟通意愿。少用形容词，不复述整份简历，不堆砌技术名词。'},
  {id:'evidence',name:'专业成果',text:'用专业、务实的中文，约100–180字。围绕JD的核心问题，选择一至两项有简历依据的经历，说明本人职责及实际交付成果；只有简历明确记载时才使用数字。不把参与写成主导，以简短沟通邀请结尾。'},
  {id:'natural',name:'自然真诚',text:'用自然真诚、像本人沟通的中文，约80–150字。以“您好”开头，用日常表达连接岗位需求与一项真实经历，说明为何想进一步了解。避免模板腔、夸张自评和过度客套，不编造对公司或产品的了解。'},
  {id:'discussion',name:'交流探讨',text:'用平等交流的中文，约100–180字。先结合JD指出自己关注的业务问题，再关联有证据的经验，最后提出一个简短、与岗位相关且JD尚未回答的问题。不假装已经了解公司内部问题，不提供未经验证的结论。'}
];

export function normalizePolicy(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(POLICY_LIMITS,k)))throw new Error('invalid_matching_policy');
  const result={};
  for(const [key,max] of Object.entries(POLICY_LIMITS)){
    const text=value[key]??'';
    if(typeof text!=='string'||text.length>max||Object.hasOwn(value,key)&&value[key]===null)throw new Error('invalid_matching_policy');
    result[key]=text.replace(/\r\n?/g,'\n').trim();
  }
  return result;
}

export function profileFingerprint(profile,policy={}){
  const normalized=normalizePolicy(policy),parts=[MATCHER_VERSION,profile];
  if(normalized.matchingSkill)parts.push({version:'matching-policy-v2',matchingSkill:normalized.matchingSkill});
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
export function greetingFingerprint(policy={}){return createHash('sha256').update(JSON.stringify([GREETER_VERSION,normalizePolicy(policy).greetingStyle])).digest('hex');}
