// Developer convenience only. Users double-click the native Windows application.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {launchDesktop} from './desktop-launch.mjs';
const executable=fileURLToPath(new URL('../循序求职助手.exe',import.meta.url));
if(process.platform!=='win32'||!existsSync(executable)){
  console.error('桌面应用尚未构建；在 Windows 项目目录执行 npm.cmd run build:desktop。');process.exitCode=1;
}else{
  const child=launchDesktop(executable);
  child.on('error',()=>{console.error('Windows外壳启动失败，请在资源管理器中双击循序求职助手.exe。');process.exitCode=1;});
}
