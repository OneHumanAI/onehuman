// SPDX-License-Identifier: BUSL-1.1
/**
 * Sign an agent-signature bundle with OneHuman's offline signatures key, and optionally publish it.
 *
 *   node scripts/sign-signatures.mjs internal/signatures/rules.json --note "Codex 1.3 overlay" [--min-engine 0.6.0] [--seq N]
 *   node scripts/sign-signatures.mjs internal/signatures/rules.json --note "…" --publish https://onehuman.ai
 *
 * The private key is ONEHUMAN_SIGNATURES_KEY (from the environment or .env) — base64url PKCS#8 Ed25519. It never
 * goes to the portal: the portal only stores bundles that verify against the public key the package ships.
 * The rules file holds detection details: keep it in internal/ (never pushed).
 */
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { thumbprint } from '../integrations/proof/verify.ts';
import { SIGNATURES_TYP, trustedSignatureKeys, validateRules, verifySignatureBundle } from '../integrations/signatures/common.ts';

const [file, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
if (!file) { console.error('usage: node scripts/sign-signatures.mjs <rules.json> --note "…" [--min-engine 0.6.0] [--seq N] [--publish https://onehuman.ai]'); process.exit(2); }
if (existsSync('.env') && !process.env.ONEHUMAN_SIGNATURES_KEY) process.loadEnvFile('.env');
const d = process.env.ONEHUMAN_SIGNATURES_KEY;
if (!d) { console.error('ONEHUMAN_SIGNATURES_KEY is not set (it lives in .env and the founders\' password manager).'); process.exit(2); }

const priv = createPrivateKey({ key: Buffer.from(d, 'base64url'), format: 'der', type: 'pkcs8' });
const x = createPublicKey(priv).export({ format: 'jwk' }).x;
if (!trustedSignatureKeys().some((k) => k.x === x)) { console.error('This key is not in trustedSignatureKeys() — installed engines would refuse the bundle. Add its public key first.'); process.exit(2); }

const rules = validateRules(JSON.parse(readFileSync(file, 'utf8')));
if (!rules) { console.error(`${file} does not match the rules schema (integrations/signatures/common.ts).`); process.exit(2); }
// seq: minutes since 1970 unless given — always higher than the last one
const payload = { v: 1, iss: 'onehuman-signatures', seq: Number(flag('--seq') ?? Math.floor(Date.now() / 60000)), issued: Date.now(), minEngine: flag('--min-engine') ?? '0.6.0', ...(flag('--note') ? { note: flag('--note') } : {}), rules };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const input = `${b64({ alg: 'EdDSA', typ: SIGNATURES_TYP, kid: thumbprint(x) })}.${b64(payload)}`;
const jws = `${input}.${sign(null, Buffer.from(input), priv).toString('base64url')}`;
const check = verifySignatureBundle(jws);
if (!check.ok) { console.error(`self-check failed: ${check.reason}`); process.exit(1); }
const counts = Object.entries(rules).map(([k, v]) => `${v.length} ${k}`).join(', ') || 'no additions';
console.error(`signed bundle seq ${payload.seq} (${counts})`);

const portal = flag('--publish');
if (!portal) { console.log(jws); process.exit(0); }
const r = await fetch(`${portal.replace(/\/$/, '')}/api/v1/signatures`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ envelope: jws }) });
console.error(`${portal} → ${r.status} ${await r.text()}`);
process.exit(r.status === 201 ? 0 : 1);
