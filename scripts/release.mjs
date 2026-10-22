// SPDX-License-Identifier: BUSL-1.1
/**
 * Release of the `onehumanai` npm package, in npm's staged flow.
 *
 *   npm run release -- current          # stage the version in package.json as it is
 *   npm run release -- patch            # 0.7.3 → 0.7.4, then stage it
 *   npm run release -- 1.0.0            # exact version
 *   npm run release -- patch --dry-run  # everything except staging/commit/tag
 *   npm run release -- done             # after `npm stage approve`: wait until npm serves it, then commit + tag
 *
 * Why staged: with two-factor sign-in through the browser, a plain `npm publish` sends the version once without the
 * second factor (npm keeps it, staged), then again after the browser step, and npm refuses the second copy (409
 * "previously staged version"); the version number is then used up. `npm stage publish` needs no second factor, and
 * `npm stage approve <id>` asks for it once.
 *
 * Steps: typecheck+tests → bump → build (the build enforces the licence line) → npm stage publish → you approve →
 * `npm run release -- done` commits package.json + CHANGELOG.md and tags onehumanai-vX.Y.Z.
 * Requires `npm login` as an owner of `onehumanai`.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const bump = args.find((a) => !a.startsWith('--')) ?? 'patch';
const run = (cmd, opts = {}) => { console.log(`\n$ ${cmd}`); return execSync(cmd, { stdio: 'inherit', ...opts }); };
const PKG = 'packages/onehumanai';
const read = () => JSON.parse(readFileSync(`${PKG}/package.json`, 'utf8'));
const live = (v) => fetch(`https://registry.npmjs.org/onehumanai/${v}`, { headers: { 'cache-control': 'no-cache' } }).then((r) => r.ok, () => false);

if (bump === 'done') {
  const version = read().version;
  let ok = false;
  for (let i = 0; i < 24 && !ok; i++) { ok = await live(version); if (!ok) await new Promise((r) => setTimeout(r, 5000)); }
  if (!ok) { console.error(`\nonehumanai@${version} is not on npm yet. Approve it first: npm stage list onehumanai, then npm stage approve <id>.`); process.exit(1); }
  // the version may already be committed (prepared before the release): then there is nothing to commit, only the tag
  try { run(`git add ${PKG}/package.json ${PKG}/CHANGELOG.md`); if (execSync('git diff --cached --name-only').toString().trim()) run(`git commit -m "release: onehumanai@${version}"`); }
  catch { console.warn('git commit failed: commit package.json and CHANGELOG.md by hand.'); }
  try { run(`git tag onehumanai-v${version}`); } catch { console.warn(`git tag failed: tag it by hand, git tag onehumanai-v${version}`); }
  console.log(`\n✓ onehumanai@${version} is live: https://www.npmjs.com/package/onehumanai`);
  process.exit(0);
}

if (!dry) {
  try { execSync('npm whoami', { stdio: 'pipe' }); } catch { console.error('\nNot logged in to npm: run `npm login`, then `npm run release` again.'); process.exit(1); }
}
run('npm run check');

// the package reports to https://onehuman.ai by default: never publish while that address does not answer as the portal
if (!dry && !args.includes('--skip-portal-check')) {
  const ok = await fetch('https://onehuman.ai/api/v1/policy-keys', { signal: AbortSignal.timeout(10_000) }).then((r) => r.ok, () => false);
  if (!ok) { console.error('\nhttps://onehuman.ai does not answer as the portal. Check the domain, then run `npm run release` again.'); process.exit(1); }
}

const current = read().version;
if (bump !== 'current') run(`npm version ${bump} --no-git-tag-version`, { cwd: PKG });
const version = read().version;
console.log(`\nversion ${current} → ${version}`);
if (!dry && await live(version)) { console.error(`\nonehumanai@${version} is already on npm. Release the next version: npm run release -- patch`); process.exit(1); }

run('node scripts/build-package.mjs');
if (dry) { run('npm publish --access public --dry-run', { cwd: PKG }); console.log(`\n(dry run) onehumanai@${version} is ready; nothing was staged.`); process.exit(0); }
try { run('npm stage publish --access public', { cwd: PKG }); }
catch {
  console.error(`\nnpm did not stage ${version}. If it says the version was published or staged before, that number is used up: npm run release -- patch`);
  process.exit(1);
}
console.log(`\nStaged onehumanai@${version}. Two steps left:
  1. npm stage list onehumanai            (shows the stage id)
  2. npm stage approve <id>               (npm asks for your second factor once)
Then: npm run release -- done           (waits until npm serves it, commits and tags)`);
