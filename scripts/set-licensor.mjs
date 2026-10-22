// SPDX-License-Identifier: BUSL-1.1
/**
 * Change the copyright holder / Licensor everywhere it is named — run once the company exists and the
 * copyright has been assigned to it (a signed assignment comes first; this only updates the text).
 *
 *   node scripts/set-licensor.mjs "OneHuman MMC"
 *   node scripts/set-licensor.mjs "OneHuman MMC" --dry-run
 *
 * Touches only licence-bearing files: LICENSE, LICENSE-BSL, NOTICE, the package's LICENSE/NOTICE, and the
 * copyright line in the READMEs. It never edits LICENSE-APACHE (the Apache text names no holder).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const [to, flag] = process.argv.slice(2);
if (!to || to.startsWith('--')) { console.error('usage: node scripts/set-licensor.mjs "<new holder>" [--dry-run]'); process.exit(2); }
const current = /Licensor:\s+(.+)/.exec(readFileSync('LICENSE-BSL', 'utf8'))?.[1]?.trim();
if (!current) { console.error('LICENSE-BSL has no Licensor line'); process.exit(1); }
if (current === to) { console.log(`Licensor is already "${to}".`); process.exit(0); }

const files = ['LICENSE', 'LICENSE-BSL', 'NOTICE', 'packages/onehumanai/LICENSE', 'packages/onehumanai/NOTICE', 'README.md', 'packages/onehumanai/README.md', 'packages/onehumanai/AGENTS.md'];
let changed = 0;
for (const f of files) {
  if (!existsSync(f)) continue;
  const s = readFileSync(f, 'utf8');
  const t = s.split(current).join(to);
  if (t !== s) { changed++; console.log(`  ${f}`); if (flag !== '--dry-run') writeFileSync(f, t); }
}
console.log(`${flag === '--dry-run' ? '(dry run) would change' : 'changed'} ${changed} file(s): "${current}" → "${to}". Release a new version for it to reach npm.`);
