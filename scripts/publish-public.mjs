#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
/**
 * Copy the engine side of this repository (onehuman-admin, private) to the public one (OneHumanAI/onehuman).
 *
 * The public repository holds what people install and run: the engine, the browser SDK, the adapters, the CLI, the
 * packages, their tests and docs. The website, the portal, the demos, ops and research tooling stay here.
 * PUBLIC below is the only list of what goes out; anything not on it never leaves this repository.
 *
 *   node scripts/publish-public.mjs            show what would change in the public repository
 *   node scripts/publish-public.mjs --push     commit it there (message: this repository's last commit) and push
 *
 * Only committed files are published (git ls-files at HEAD), never the working tree's extras. package.json, its lockfile
 * and .gitignore are written for the public repository rather than copied.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export const PUBLIC_REMOTE = 'https://github.com/OneHumanAI/onehuman.git';

/** Paths published as they are: a folder (trailing /) or a file. */
export const PUBLIC = [
  '.github/', 'AGENTS.md', 'CLA.md', 'CONTRIBUTING.md', 'LICENSE', 'LICENSE-APACHE', 'LICENSE-BSL', 'NOTICE', 'QUICKSTART.md', 'README.md', 'SECURITY.md',
  'docs/readme/', 'examples/', 'integrations/', 'packages/', 'sdk/',
  'server/anchor.ts', 'server/assess.ts', 'server/audit.ts', 'server/doc-ids.ts', 'server/bus.ts', 'server/connection.ts', 'server/db.ts', 'server/engine.ts', 'server/http.ts',
  'server/kinematics-model.json', 'server/kinematics-model.ts', 'server/kinematics.ts', 'server/license.ts', 'server/policy.ts', 'server/proof.ts', 'server/public.ts',
  'server/routes/access.ts', 'server/routes/session.ts', 'server/routes/webauthn.ts', 'server/signals.ts', 'server/signatures.ts', 'server/sql.ts',
  'server/tokens.ts', 'server/web-bot-auth.ts', 'server/webauthn.ts',
  'scripts/build-package.mjs', 'scripts/release.mjs', 'scripts/with-sidecar.mjs',
  'tests/approval-binding.test.ts', 'tests/assess.test.ts', 'tests/audit-chain.test.ts', 'tests/cli-init.test.ts', 'tests/connection.test.ts', 'tests/express-fail-open.test.ts',
  'tests/express-middleware.test.ts', 'tests/identity-passkeys.test.ts', 'tests/fixtures-ios-safari-taps.json', 'tests/fixtures-phones-human.json', 'tests/kinematics-model.test.ts',
  'tests/kinematics.test.ts', 'tests/licence-line.test.ts', 'tests/policy.test.ts', 'tests/proof-rotation-anchor.test.ts', 'tests/proof.test.ts',
  'tests/report-inspect.test.ts', 'tests/rows.ts', 'tests/sidecar.test.ts', 'tests/soft-authenticator.ts', 'tests/strict-policy.ts', 'tests/tokens-audit.test.ts',
  'tests/web-bot-auth.test.ts', 'tests/webauthn.test.ts',
  'tsconfig.json', 'tsconfig.build.json',
];

/** The public repository's .gitignore: build output and local files only. */
export const PUBLIC_GITIGNORE = `node_modules/
*.db
*.db-wal
*.db-shm
.DS_Store
.env
.env.*
onehuman.policy.draft.json
memory
memory-shm
memory-wal
packages/onehumanai/dist/
packages/onehumanai/sdk/
packages/onehumanai/QUICKSTART.md
packages/onehumanai/LICENSE-APACHE
packages/onehumanai/LICENSE-BSL
__pycache__/
*.pyc
packages/python/build/
packages/python/dist/
packages/python/*.egg-info/
packages/dotnet/**/bin/
packages/dotnet/**/obj/
packages/java/target/
`;

/** package.json goes out without the website's scripts and tooling. */
export function publicPackageJson(text) {
  const pkg = JSON.parse(text);
  pkg.name = 'onehumanai-repo';
  pkg.description = 'OneHuman: the engine, browser SDK, adapters and CLI behind npm i onehumanai';
  pkg.scripts = {
    test: pkg.scripts.test,
    typecheck: pkg.scripts.typecheck,
    check: pkg.scripts.check,
    example: pkg.scripts.example,
    'build:package': pkg.scripts['build:package'],
    release: pkg.scripts.release,
  };
  for (const d of ['vercel', 'ghost-cursor', 'firebase']) delete pkg.devDependencies?.[d];
  // the website's storage and sign-in (Firestore, Google auth, Vercel OIDC) are not part of the engine
  for (const d of ['@google-cloud/firestore', 'google-auth-library', '@vercel/oidc']) delete pkg.dependencies?.[d];
  return JSON.stringify(pkg, null, 2) + '\n';
}

const inPublic = (f) => PUBLIC.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const push = process.argv.includes('--push');
  const git = (args, cwd = '.') => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const head = git(['rev-parse', '--short', 'HEAD']).trim();
  const files = git(['ls-files']).split('\n').filter(Boolean).filter(inPublic);

  const dir = join(tmpdir(), 'onehumanai-public');
  if (!existsSync(join(dir, '.git'))) { rmSync(dir, { recursive: true, force: true }); git(['clone', '--quiet', PUBLIC_REMOTE, dir]); }
  git(['fetch', '--quiet', 'origin'], dir); git(['reset', '--quiet', '--hard', 'origin/main'], dir);
  for (const e of readdirSync(dir)) if (e !== '.git') rmSync(join(dir, e), { recursive: true, force: true });
  for (const f of files) { mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(f, join(dir, f)); }
  writeFileSync(join(dir, 'package.json'), publicPackageJson(readFileSync('package.json', 'utf8')));
  writeFileSync(join(dir, '.gitignore'), PUBLIC_GITIGNORE);
  // the lockfile is resolved from the public package.json, so none of this repository's site tooling rides along
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore' });

  git(['add', '-A'], dir);
  const stat = git(['diff', '--cached', '--stat'], dir).trim();
  if (!stat) { console.log('public repository is up to date'); process.exit(0); }
  console.log(stat);
  if (!push) { console.log(`\n(dry run) node scripts/publish-public.mjs --push to commit and push, in ${dir}`); process.exit(0); }
  const subject = git(['log', '-1', '--format=%s']).trim();
  const author = git(['log', '-1', '--format=%an <%ae>']).trim();
  git(['commit', '--quiet', '--author', author, '-m', subject, '-m', `From onehuman-admin ${head}.`], dir);
  git(['push', '--quiet', 'origin', 'HEAD:main'], dir);
  console.log(`pushed to ${PUBLIC_REMOTE}`);
}
