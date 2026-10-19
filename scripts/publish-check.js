import { readFile } from 'node:fs/promises';

export function checkPublish(manifest, env = process.env) {
  const match = /^@([a-z0-9-]+)\/moondrop-hid$/.exec(manifest.name ?? '');
  if (!match || match[1] === 'your-github-owner') throw new Error('Run bun run configure -- owner/repository before publishing.');
  if (manifest.publishConfig?.registry !== 'https://npm.pkg.github.com') throw new Error('Publishing is restricted to GitHub Packages.');
  const registry = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (registry && new URL(registry).origin !== 'https://npm.pkg.github.com') {
    throw new Error('Use bun publish --registry=https://npm.pkg.github.com, not npmjs.org.');
  }
  const repo = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\.git$/.exec(manifest.repository?.url ?? '');
  if (!repo || repo[1].toLowerCase() !== match[1]) throw new Error('Repository owner must match the package scope.');
  if (env.GITHUB_REPOSITORY && `${repo[1]}/${repo[2]}`.toLowerCase() !== env.GITHUB_REPOSITORY.toLowerCase()) {
    throw new Error('The package must be linked to the repository running this workflow.');
  }
  if (env.RELEASE_TAG && env.RELEASE_TAG !== `v${manifest.version}`) throw new Error('Release tag must match package.json version.');
}

if (import.meta.main) {
  checkPublish(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')));
  console.log('Publish target validated: GitHub Packages only.');
}
