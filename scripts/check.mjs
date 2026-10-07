import {readdirSync, readFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {VERSION} from '../shared/core.js';

assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version, VERSION);
assert.ok(existsSync(new URL(`../docs/releases/${VERSION}.md`,import.meta.url)), 'Current release notes are required');
assert.ok(readFileSync(new URL('../CHANGELOG.md',import.meta.url),'utf8').includes(`## ${VERSION} —`), 'Current version must be in CHANGELOG');
assert.ok(readFileSync(new URL('../README.md',import.meta.url),'utf8').includes(`**${VERSION}**`), 'README must name the current version');
if(process.env.GITHUB_REF?.startsWith('refs/tags/'))assert.equal(process.env.GITHUB_REF,`refs/tags/v${VERSION}`,'Release tag must match package version');
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
