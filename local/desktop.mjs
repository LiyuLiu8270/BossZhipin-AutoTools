// Developer convenience only. Users double-click the native Windows application.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const executable=fileURLToPath(new URL('../循序求职助手.exe',import.meta.url));
if(process.platform!=='win32'||!existsSync(executable)){
  console.error('桌面应用尚未构建；在 Windows 项目目录执行 npm.cmd run build:desktop。');process.exitCode=1;
}else{
  const child=spawn(executable,[],{detached:true,windowsHide:true,stdio:'ignore'});
  child.on('error',()=>{console.error('桌面应用启动失败，请检查文件位置。');process.exitCode=1;});child.unref();
}
