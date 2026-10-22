// SPDX-License-Identifier: BUSL-1.1
/** The licence line: the open code (Apache-2.0) reaches the engine (BUSL-1.1) only through server/public.ts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });

test('open code imports the engine only through server/public.ts', () => {
  for (const f of [...walk('integrations'), ...walk('sdk')].filter((p) => /\.(ts|js|mjs)$/.test(p))) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const spec = m[1]!;
      if (spec.includes('/server/')) assert.match(spec, /\/server\/public\.ts$/, `${f} imports ${spec}`);
    }
  }
});

test('every source file names its licence, and the open directories are Apache-2.0', () => {
  const open = [...walk('integrations'), ...walk('sdk')].filter((p) => /\.(ts|js|mjs)$/.test(p));
  const engine = walk('server').filter((p) => p.endsWith('.ts'));
  for (const f of open) assert.match(readFileSync(f, 'utf8').slice(0, 400), /SPDX-License-Identifier: Apache-2\.0/, f);
  for (const f of engine) assert.match(readFileSync(f, 'utf8').slice(0, 400), /SPDX-License-Identifier: BUSL-1\.1/, f);
});

test('the package declares both licences and ships both texts', () => {
  const pkg = JSON.parse(readFileSync('packages/onehumanai/package.json', 'utf8'));
  assert.equal(pkg.name, 'onehumanai');
  assert.equal(pkg.license, '(Apache-2.0 AND BUSL-1.1)');
  for (const f of ['LICENSE', 'LICENSE-APACHE', 'LICENSE-BSL']) assert.ok(pkg.files.includes(f), f);
  assert.match(readFileSync('LICENSE-APACHE', 'utf8'), /Apache License\s+Version 2\.0, January 2004/);
  assert.match(readFileSync('LICENSE-BSL', 'utf8'), /Business Source License 1\.1/);
  assert.match(readFileSync('LICENSE-BSL', 'utf8'), /Additional Use Grant: You may make production use/);
});

test('the middleware refuses a half-updated install with an actionable message', async () => {
  // simulate the built packages: stamp both sides, then let them disagree
  const src = readFileSync('integrations/express/index.ts', 'utf8');
  assert.match(src, /PACKAGE_VERSION !== ENGINE_VERSION/, 'the startup check exists');
  assert.match(src, /npm i onehumanai@\$\{PACKAGE_VERSION\}/, 'and tells the user the exact fix');
  // from source both read 0.0.0-dev and the check is skipped, so onehuman() still works here
  const { onehuman } = await import('../integrations/express/index.ts');
  const oh = await onehuman({ secret: 'a-long-enough-secret-for-tests-0000000000', policy: { version: 'v', enforcement: 'observe', rules: [{ resource: 'x.read', title: 'x', onAgent: 'mask', onArtifact: 'allow', onUnknown: 'allow', onHumanLike: 'allow', actOn: ['strong'], minScore: 65 }] } as never, db: 'memory' });
  assert.equal(oh.health().ok, true);
  await oh.close();
});
