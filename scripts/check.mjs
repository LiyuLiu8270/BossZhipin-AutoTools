import {readdirSync, readFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {VERSION} from '../shared/core.js';

assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version, VERSION);
assert.match(readFileSync(new URL('../desktop/TrayApp.cs',import.meta.url),'utf8'), new RegExp(`AssemblyVersion\\("${VERSION.replaceAll('.', '\\.')}\\.0"\\)`));
assert.equal(existsSync(new URL('../extension/manifest.json', import.meta.url)), false, 'Browser extension has been retired');
for (const directory of ['shared', 'local', 'local/web', 'scripts', 'tests']) {
  for (const name of readdirSync(new URL(`../${directory}/`, import.meta.url)).filter(n => /\.(mjs|js|py)$/.test(n))) {
    const path = new URL(`../${directory}/${name}`, import.meta.url);
    const source = readFileSync(path, 'utf8');
    if (directory !== 'tests' && directory !== 'scripts') {
      assert.doesNotMatch(source, /(?:\.\.\/)+extension\//, `Retired dependency in ${directory}/${name}`);
      assert.doesNotMatch(source, /\bchrome\.(?:runtime|storage|tabs|scripting|debugger|permissions)\b/, `Browser extension API in ${directory}/${name}`);
    }
    if (name.endsWith('.py')) continue;
    const r = spawnSync(process.execPath, ['--check', fileURLToPath(path)], {encoding: 'utf8'});
    if (r.status !== 0) { console.error(r.stderr || r.error); process.exit(1); }
  }
}
console.log('Shared modules, service, web and tests checked; extension dependency guard passed:', VERSION);
