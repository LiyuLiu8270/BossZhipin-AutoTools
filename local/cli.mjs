import {mkdirSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {IntakeStore, IntakeScanner} from './intake.mjs';

const [command = 'help', ...args] = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--db', '--file', '--dir'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('参数格式错误：--db/--file/--dir 后需填写路径');
  options[args[i].slice(2)] = args[i + 1];
}
if (!['import', 'scan', 'watch', 'stats'].includes(command)) {
  console.log('用法：node local/cli.mjs import --file <JSON> | scan --dir <目录> | watch --dir <目录> | stats；可用 --db 指定本地SQLite。');
  process.exit(command === 'help' ? 0 : 1);
}
if (command === 'import' && !options.file) throw new Error('import需要--file');
const database = resolve(options.db || fileURLToPath(new URL('./data/jobs.sqlite', import.meta.url)));
mkdirSync(dirname(database), {recursive: true});
const store = new IntakeStore(database), output = value => console.log(JSON.stringify(value));
try {
  if (command === 'import') output(store.importFile(options.file));
  if (['scan', 'watch'].includes(command)) {
    const scanner = new IntakeScanner(store, resolve(options.dir || join(homedir(), 'Downloads')));
    if (command === 'scan') for (const result of scanner.scan({stable: false})) output(result);
    else {
      output({status: 'watching', folder: scanner.folder, database, notice: '仅本地接收已导出JSON；每5秒检查，Ctrl+C停止，不运行模型、不投递。关闭此进程后停止接收。'});
      let stopped = false;
      const stop = () => { stopped = true; };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      while (!stopped) {
        for (const result of scanner.scan()) output(result);
        if (!stopped) await new Promise(r => setTimeout(r, 5000));
      }
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
    }
  }
  output({database, datasets: store.stats()});
} finally { store.close(); }
