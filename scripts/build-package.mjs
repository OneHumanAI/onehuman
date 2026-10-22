// SPDX-License-Identifier: BUSL-1.1
/**
 * Build the one publishable package, packages/onehumanai (`npm i onehumanai`):
 *
 *   dist/engine.js             BUSL-1.1    the engine: detection, policy, audit, proofs (server/public.ts, one ESM bundle)
 *   dist/kinematics-model.json BUSL-1.1
 *   dist/express.js            Apache-2.0  the Express/Connect middleware — imports ./engine.js, contains none of it
 *   dist/cli.js                Apache-2.0  npx onehumanai init · inspect · report · scan · verify · verify-proof · secret
 *   sdk/onehuman.js            Apache-2.0  the browser SDK, served by the middleware at /onehuman/sdk.js
 *   dist/types/**              .d.ts of the middleware and the engine's public surface
 *
 * The line between the two licences is enforced here, not by convention: the open bundles may reach server/
 * only through server/public.ts (→ ./engine.js), and no engine code may end up inside them.
 */
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const PKG = 'packages/onehumanai';
const ROOT = resolve('.');
const SERVER = join(ROOT, 'server') + '/';
const PUBLIC = join(ROOT, 'server', 'public.ts');

for (const d of [`${PKG}/dist`, `${PKG}/sdk`]) { rmSync(d, { recursive: true, force: true }); mkdirSync(d, { recursive: true }); }
const pkg = JSON.parse(readFileSync(`${PKG}/package.json`, 'utf8'));
const version = pkg.version;

// ---------------------------------------------------------------- the engine (BUSL-1.1)
await build({
  entryPoints: ['server/public.ts'],
  outfile: `${PKG}/dist/engine.js`,
  bundle: true, platform: 'node', format: 'esm', target: 'node22', sourcemap: true, legalComments: 'none',
  external: ['@libsql/client', '@libsql/client/*', 'node:*'],
  define: { __ONEHUMAN_ENGINE_VERSION__: JSON.stringify(version) },
  banner: { js: `// onehumanai ${version} engine — BUSL-1.1 (see LICENSE-BSL) — https://onehuman.ai` },
});
if (existsSync('server/kinematics-model.json')) cpSync('server/kinematics-model.json', `${PKG}/dist/kinematics-model.json`);

// ---------------------------------------------------------------- the open code (Apache-2.0)
/** Route the engine's public surface to ./engine.js; refuse any other way into server/. */
const licenceLine = {
  name: 'licence-line',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (!args.path.startsWith('.') || !args.resolveDir) return undefined;
      const target = resolve(args.resolveDir, args.path);
      if (target === PUBLIC) return { path: './engine.js', external: true };
      if (target.startsWith(SERVER)) throw new Error(`licence line: ${args.importer} imports ${args.path} — the open code may reach the engine only through server/public.ts`);
      return undefined;
    });
  },
};
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', plugins: [licenceLine] };
await build({
  ...common,
  entryPoints: ['integrations/express/index.ts'],
  outfile: `${PKG}/dist/express.js`,
  sourcemap: true,
  external: ['@libsql/client', '@libsql/client/*', 'express', 'node:*'],
  define: { __ONEHUMAN_VERSION__: JSON.stringify(version) },
  banner: { js: `// onehumanai ${version} — Apache-2.0 (see LICENSE-APACHE) — https://onehuman.ai` },
});
await build({
  ...common,
  entryPoints: ['integrations/cli/index.ts'],
  outfile: `${PKG}/dist/cli.js`,
  external: ['@libsql/client', '@libsql/client/*', 'express', 'node:*'],
  define: { __ONEHUMAN_VERSION__: JSON.stringify(version) },
  banner: { js: '#!/usr/bin/env node' },
});
// Belt and braces: no engine module may appear in the open bundles.
for (const f of ['express.js', 'cli.js']) {
  const code = readFileSync(`${PKG}/dist/${f}`, 'utf8');
  for (const marker of ['class OneHuman', 'function assess(', 'function judgeClick(', 'function proverFromSecret(']) {
    if (code.includes(marker)) throw new Error(`licence line: ${f} contains engine code (${marker})`);
  }
}

// ---------------------------------------------------------------- types, SDK, texts
execSync('npx tsc -p tsconfig.build.json', { stdio: 'inherit' });
// the SDK carries the package version too (visible as OneHuman.version in the browser)
const sdk = readFileSync('sdk/onehuman.js', 'utf8').replace(/version: 'sdk-v\d+'/, `version: 'sdk-v4+${version}'`);
writeFileSync(`${PKG}/sdk/onehuman.js`, sdk);
cpSync('QUICKSTART.md', `${PKG}/QUICKSTART.md`);   // the one-screen version for people; README is the agent protocol
cpSync('LICENSE-APACHE', `${PKG}/LICENSE-APACHE`);
cpSync('LICENSE-BSL', `${PKG}/LICENSE-BSL`);
console.log(`built ${PKG} v${version} (engine BUSL-1.1, middleware/SDK/CLI Apache-2.0)`);
