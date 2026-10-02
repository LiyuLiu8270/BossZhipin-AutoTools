import {existsSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const projectRoot=fileURLToPath(new URL('../',import.meta.url));
export const browserProfile=join(projectRoot,'local','data','edge-profile');
export function pythonPath({env=process.env,platform=process.platform,root=projectRoot}={}){
  const override=env.BOSS_TOOLS_PYTHON;
  const path=override||join(root,'.venv',platform==='win32'?'Scripts':'bin',platform==='win32'?'python.exe':'python');
  if(!isAbsolute(path)||!existsSync(path))throw new Error('python_runtime_unavailable: run npm run setup or set BOSS_TOOLS_PYTHON to an absolute Python executable path');
  return path;
}
