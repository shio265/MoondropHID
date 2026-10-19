import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configure } from '../scripts/configure.js';
import { checkPublish } from '../scripts/publish-check.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

function bun(args, cwd = root, env = {}) {
  const result = Bun.spawnSync([process.execPath, ...args], {
    cwd, env: { ...process.env, ...env }
  });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString();
}

test('publish checks reject npmjs.org, placeholder scopes, wrong owners and wrong release tags', () => {
  const configured = { ...manifest, name: '@test-owner/moondrop-hid',
    repository: { type: 'git', url: 'https://github.com/test-owner/Dac.git' } };
  assert.doesNotThrow(() => checkPublish(configured, {}));
  assert.throws(() => checkPublish({ ...configured, name: '@your-github-owner/moondrop-hid' }, {}));
  assert.throws(() => checkPublish({ ...configured, publishConfig: { registry: 'https://registry.npmjs.org' } }, {}));
  assert.throws(() => checkPublish(configured, { npm_config_registry: 'https://registry.npmjs.org/' }));
  assert.throws(() => checkPublish(configured, { NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/' }));
  assert.throws(() => checkPublish(configured, { RELEASE_TAG: 'v9.0.0' }));
  assert.throws(() => checkPublish(configured, { GITHUB_REPOSITORY: 'other-owner/Dac' }));
  assert.doesNotThrow(() => checkPublish(configured, { RELEASE_TAG: `v${manifest.version}`,
    GITHUB_REPOSITORY: 'test-owner/Dac', npm_config_registry: 'https://npm.pkg.github.com/' }));
});

test('publish dry-run resolves scoped GitHub authentication without uploading', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'opencode-moondrop-publish-'));
  const env = { NPM_CONFIG_TOKEN: 'dry-run-placeholder-not-a-real-token' };
  try {
    await writeFile(join(temp, 'package.json'), JSON.stringify({ ...manifest,
      scripts: { prepublishOnly: manifest.scripts.prepublishOnly } }));
    await mkdir(join(temp, 'scripts'));
    await writeFile(join(temp, 'scripts/publish-check.js'),
      await readFile(new URL('../scripts/publish-check.js', import.meta.url), 'utf8'));
    await writeFile(join(temp, '.npmrc'),
      `@${manifest.name.split('/')[0].slice(1)}:registry=https://npm.pkg.github.com\n` +
      '//npm.pkg.github.com/:_authToken=${NPM_CONFIG_TOKEN}\n');
    const output = bun(['publish', '--dry-run', '--registry=https://npm.pkg.github.com'], temp, env);
    assert.match(output, /Registry: https:\/\/npm\.pkg\.github\.com\/?/);
    const rejected = Bun.spawnSync([process.execPath, 'publish', '--dry-run'], {
      cwd: temp,
      env: { ...process.env, ...env, npm_config_registry: 'https://registry.npmjs.org/' }
    });
    assert.notEqual(rejected.exitCode, 0);
    assert.match(rejected.stderr.toString(), /not npmjs\.org/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('GitHub configuration lowercases scope, links repository, updates lock and preserves unrelated npm config', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'opencode-moondrop-config-'));
  try {
    const url = pathToFileURL(temp + sep);
    await writeFile(join(temp, 'package.json'), JSON.stringify(manifest));
    const originalLockText = await readFile(new URL('../bun.lock', import.meta.url), 'utf8');
    const originalLock = Bun.JSONC.parse(originalLockText);
    await writeFile(join(temp, 'bun.lock'), originalLockText);
    const previousScope = manifest.name.split('/')[0];
    await writeFile(join(temp, '.npmrc'), '@another:registry=https://example.invalid\n' +
      `${previousScope}:registry=https://npm.pkg.github.com\n# keep this comment\n`);
    assert.equal(await configure('Test-Owner/Dac', url), '@test-owner/moondrop-hid');
    const updated = JSON.parse(await readFile(join(temp, 'package.json'), 'utf8'));
    assert.equal(updated.repository.url, 'https://github.com/Test-Owner/Dac.git');
    assert.equal(updated.publishConfig.registry, 'https://npm.pkg.github.com');
    const npmrc = await readFile(join(temp, '.npmrc'), 'utf8');
    assert.ok(npmrc.includes('@another:registry=https://example.invalid'));
    assert.ok(npmrc.includes('# keep this comment'));
    if (previousScope !== '@test-owner') assert.ok(!npmrc.includes(`${previousScope}:`));
    assert.equal(npmrc.split('\n').filter(line => line.startsWith('@test-owner:registry=')).length, 1);
    const lock = Bun.JSONC.parse(await readFile(join(temp, 'bun.lock'), 'utf8'));
    assert.equal(lock.workspaces[''].name, updated.name);
    assert.deepEqual(lock.packages, originalLock.packages);
    bun(['install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts'], temp);
    await assert.rejects(configure('not a repository', url));
    await assert.rejects(configure('your-github-owner/Dac', url));
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('packed package installs locally, exposes ESM/types, and excludes development files', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'opencode-moondrop-package-'));
  try {
    const tarball = join(temp, 'package.tgz');
    bun(['pm', 'pack', '--filename', tarball]);
    const packed = Bun.file(tarball);
    const entries = await new Bun.Archive(await packed.bytes()).files();
    const files = [...entries.keys()].map(path => path.replace(/^package\//, ''));
    for (const path of files) {
      assert.ok(path.startsWith('dist/') || ['package.json', 'README.md', 'THIRD_PARTY_NOTICES.md'].includes(path), path);
      assert.ok(!path.includes('node_modules') && !path.startsWith('tests/'));
    }
    assert.ok(files.includes('dist/index.js'));
    assert.ok(files.includes('dist/index.d.ts'));
    assert.ok(!files.some(path => path.startsWith('dist/internal/')), 'Bunup should bundle the internal modules');
    assert.ok(packed.size < 256 * 1024 * 1024);
    await writeFile(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    bun(['add', '--ignore-scripts', '--no-save', tarball], temp);
    const script = `const sdk=await import(${JSON.stringify(manifest.name)});
      if(sdk.getSupportedDevices().length!==21) throw Error('Missing registry');
      if(typeof sdk.createClient!=='function') throw Error('Missing SDK');
      if(sdk.isSupported()) throw Error('Unexpected WebHID in Bun');
      const {fakeDevice}=await import(${JSON.stringify(new URL('./smoke.js', import.meta.url).href)});
      const raw=fakeDevice('MOONRIVER 3');
      const client=sdk.createClient({hid:{async requestDevice(){return [raw]},async getDevices(){return [raw]}}});
      await client.connect();
      if((await client.readConfig()).filters.length!==8) throw Error('Bundled read failed');
      await client.writeConfig({filters:[{type:'PK',freq:1000,gain:-3,q:1}]});
      await client.disconnect();
      if(raw.reports.length!==27||raw.opened) throw Error('Bundled write/disconnect failed');
      try {await import(${JSON.stringify(manifest.name + '/internal/protocols.js')}); throw Error('Unexpected private export');}
      catch(e){if(!['ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(e.code)) throw e;}`;
    bun(['-e', script], temp);
    await writeFile(join(temp, 'consumer.ts'), `import {createClient, type EqConfigInput} from ${JSON.stringify(manifest.name)};
      const client=createClient();
      const config: EqConfigInput={filters:[{type:'PK',freq:1000,gain:-3,q:1}]};
      void client.writeConfig(config);
      // @ts-expect-error gainMode is boolean, not a string.
      void client.writeSetting('gainMode','high');`);
    const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
    bun([tsc, '--module', 'NodeNext', '--target', 'ES2022',
      '--strict', '--noEmit', '--lib', 'ES2022,DOM', 'consumer.ts'], temp);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
