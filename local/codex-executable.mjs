import {accessSync,constants,readdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join} from 'node:path';

// Resolve afresh: desktop updates replace versioned directories while this
// service may remain alive. No shell, auth-file reads or global PATH changes.
export function resolveCodexExecutable({binary,env=process.env,platform=process.platform,userHome=homedir()}={}) {
  const windows=platform==='win32';
  const usable=path=>{
    try{return isAbsolute(path)&&(!windows||/\.exe$/i.test(path))&&statSync(path).isFile()&&(accessSync(path,windows?constants.F_OK:constants.X_OK),true);}catch{return false;}
  };
  const pathEntry=Object.keys(env).find(key=>key.toLowerCase()==='path');
  const directories=(env[pathEntry]||'').split(windows?';':':').map(p=>p.replace(/^"(.*)"$/,'$1')).filter(isAbsolute);
  const findOnPath=name=>{
    if(/[\\/]/.test(name))return null;
    const filename=windows&&!/\.exe$/i.test(name)?name+'.exe':name;
    for(const directory of directories){const path=join(directory,filename);if(usable(path))return path;}
    return null;
  };
  const override=binary??env.CODEX_BINARY;
  if(override){
    const path=isAbsolute(override)?(usable(override)?override:null):findOnPath(override);
    if(path)return {path,source:'override'};
    throw new Error('codex_binary_unavailable');
  }
  const onPath=findOnPath('codex');
  if(onPath)return {path:onPath,source:'path'};
  if(windows){
    const root=join(env.LOCALAPPDATA||join(userHome,'AppData','Local'),'OpenAI','Codex','bin');
    let versions=[];
    try{versions=readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&!entry.isSymbolicLink()).flatMap(entry=>{
      const path=join(root,entry.name,'codex.exe');
      if(!usable(path))return [];
      return [{path,modified:statSync(path).mtimeMs}];
    });}catch{/* An absent/incomplete desktop installation is not a fatal scan error. */}
    versions.sort((a,b)=>b.modified-a.modified||a.path.localeCompare(b.path));
    if(versions.length)return {path:versions[0].path,source:'desktop_install'};
  }
  throw new Error('codex_binary_unavailable');
}

export function codexRuntimeStatus(options){
  try{const {source}=resolveCodexExecutable(options);return {available:true,source};}
  catch{return {available:false,error:'codex_binary_unavailable'};}
}
