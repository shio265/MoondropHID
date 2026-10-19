import { readFile, writeFile } from 'node:fs/promises';

export async function configure(repository, root = new URL('../', import.meta.url)) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repository ?? '')) {
    throw new Error('Provide GitHub owner/repository: bun run configure -- owner/MoondropHID');
  }
  const [owner, repo] = repository.split('/');
  if (owner.toLowerCase() === 'your-github-owner') throw new Error('Replace the placeholder GitHub owner.');
  const name = `@${owner.toLowerCase()}/moondrop-hid`;
  const manifestUrl = new URL('package.json', root);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const oldScope = /^@([^/]+)\//.exec(manifest.name ?? '')?.[1];
  manifest.name = name;
  manifest.repository = { type: 'git', url: `https://github.com/${owner}/${repo}.git` };
  manifest.publishConfig = { ...manifest.publishConfig, registry: 'https://npm.pkg.github.com' };
  await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
  const npmrcUrl = new URL('.npmrc', root);
  let npmrc = '';
  try { npmrc = await readFile(npmrcUrl, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const lines = npmrc.split(/\r?\n/).filter(line => {
    const scope = /^\s*@([^:]+):registry\s*=/.exec(line)?.[1];
    return !scope || (scope !== oldScope && scope !== owner.toLowerCase());
  });
  while (lines.at(-1) === '') lines.pop();
  lines.push(`@${owner.toLowerCase()}:registry=https://npm.pkg.github.com`);
  await writeFile(npmrcUrl, lines.join('\n') + '\n');
  try {
    const lockUrl = new URL('bun.lock', root);
    const lock = Bun.JSONC.parse(await readFile(lockUrl, 'utf8'));
    if (lock.workspaces?.['']) lock.workspaces[''].name = name;
    await writeFile(lockUrl, JSON.stringify(lock, null, 2) + '\n');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return name;
}

if (import.meta.main) {
  console.log(`GitHub Packages name: ${await configure(process.argv[2] ?? process.env.GITHUB_REPOSITORY)}`);
}
