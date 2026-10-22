#!/usr/bin/env node
// Start a real sidecar (strict test rules, temporary storage), run a command with ONEHUMAN_SIDECAR_URL set, stop it.
//   node scripts/with-sidecar.mjs -- dotnet run --project packages/dotnet/tests/Smoke
// Used by the C# and Java adapter tests; the exit code is the command's.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const cmd = process.argv.slice(process.argv.indexOf('--') + 1);
const ACT = ['verified', 'strong', 'control', 'behavioral'];
const rule = (resource, onAgent, onArtifact, onUnknown) => ({ resource, title: resource, onAgent, onArtifact, onUnknown, onHumanLike: 'allow', actOn: ACT, minScore: 65 });
const dir = mkdtempSync(join(tmpdir(), 'oh-sidecar-'));
writeFileSync(join(dir, 'onehuman.policy.json'), JSON.stringify({ version: 'adapter-test', enforcement: 'enforce', rules: [rule('balance.read', 'block', 'mask', 'allow'), rule('profile.read', 'mask', 'allow', 'allow')] }));
writeFileSync(join(dir, '.env'), `ONEHUMAN_SECRET=${'s'.repeat(48)}\n`);
const port = await new Promise((ok) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
const url = `http://127.0.0.1:${port}`;
const side = spawn(process.execPath, [join(import.meta.dirname, '..', 'integrations', 'cli', 'index.ts'), 'sidecar', '--dir', dir, '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ONEHUMAN_NO_UPDATE_CHECK: '1' } });
for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/v1/health`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
const run = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, ONEHUMAN_SIDECAR_URL: url } });
const code = await new Promise((ok) => run.on('exit', (c) => ok(c ?? 1)));
side.kill(); rmSync(dir, { recursive: true, force: true });
process.exit(code);
