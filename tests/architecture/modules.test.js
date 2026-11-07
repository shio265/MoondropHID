import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as sdk from '../../src/index.js';

test('the public entry keeps the same five SDK exports', () => {
  assert.deepEqual(Object.keys(sdk).sort(), [
    'HidError', 'createClient', 'getSupportedDevices', 'isSupported', 'setDebugLogger'
  ]);
});

test('the complete source graph is acyclic and uses browser-resolvable relative modules', async () => {
  const root = new URL('../../src/', import.meta.url);
  const paths = [...new Bun.Glob('**/*.js').scanSync({ cwd: fileURLToPath(root), onlyFiles: true })];
  const files = new Set(paths.map(path => new URL(path.replaceAll('\\', '/'), root).href));
  const graph = new Map();
  const transpiler = new Bun.Transpiler({ loader: 'js', target: 'browser' });

  for (const url of files) {
    const imports = transpiler.scanImports(await readFile(new URL(url), 'utf8'));
    const dependencies = imports.map(entry => {
      assert.equal(entry.kind, 'import-statement', `Unexpected import kind in ${url}`);
      assert.match(entry.path, /^\.{1,2}\//, `Bare imports break the GitHub CDN entry: ${entry.path}`);
      assert.ok(entry.path.endsWith('.js'), `Explicit file extensions are required: ${entry.path}`);
      const dependency = new URL(entry.path, url).href;
      assert.ok(files.has(dependency), `Missing source module: ${dependency}`);
      return dependency;
    });
    graph.set(url, dependencies);
  }

  const visited = new Set();
  const active = new Set();
  function visit(url) {
    assert.ok(!active.has(url), `Circular source dependency: ${url}`);
    if (visited.has(url)) return;
    active.add(url);
    for (const dependency of graph.get(url)) visit(dependency);
    active.delete(url);
    visited.add(url);
  }
  visit(new URL('index.js', root).href);
  assert.deepEqual([...visited].sort(), [...files].sort(), 'No abandoned implementation modules should remain');
});
