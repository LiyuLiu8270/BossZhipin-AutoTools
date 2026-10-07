import {spawn} from 'node:child_process';
import {isAbsolute,join} from 'node:path';

// Ask the normal Windows shell to open the GUI application. Do not change job
// objects, sandbox policy, privileges, auto-start registration or model settings.
export function launchDesktop(executable,{spawnProcess=spawn,windows=process.env.WINDIR||'C:\\Windows'}={}){
 if(!isAbsolute(executable)||!executable.toLowerCase().endsWith('.exe'))throw Error('absolute_desktop_executable_required');
 const child=spawnProcess(join(windows,'explorer.exe'),[executable],{windowsHide:true,detached:true,stdio:'ignore'});
 child.unref();return child;
}
