// SPDX-License-Identifier: Apache-2.0
/**
 * `npx onehumanai proof-keys` — the public keys that verify this deployment's decision proofs, from the secret in the
 * environment or .env (and ONEHUMAN_PROOF_EPOCH / ONEHUMAN_RETIRED_PROOF_KEYS). Run it BEFORE changing ONEHUMAN_SECRET
 * and keep the output in ONEHUMAN_RETIRED_PROOF_KEYS: proofs signed with the old secret then still verify.
 */
import { resolve } from 'node:path';
import { proverFromSecret } from '../../server/public.ts';
import { loadEnv } from './sidecar.ts';

export function runProofKeys(o: { flag: (n: string) => string | undefined }) {
  loadEnv(resolve(o.flag('--dir') ?? process.cwd(), '.env'));
  const secret = process.env.ONEHUMAN_SECRET ?? '';
  if (secret.length < 32) { console.error('ONEHUMAN_SECRET is missing or shorter than 32 characters (environment or .env).'); process.exit(2); }
  const epoch = Math.max(0, Math.floor(Number(process.env.ONEHUMAN_PROOF_EPOCH) || 0));
  const keys = Array.from({ length: epoch + 1 }, (_, i) => proverFromSecret(Buffer.from(secret, 'utf8'), epoch - i).jwk);
  let retired: unknown[] = [];
  try { const v = JSON.parse(process.env.ONEHUMAN_RETIRED_PROOF_KEYS ?? '[]'); retired = Array.isArray(v) ? v : v?.keys ?? []; } catch { /* ignored, as the engine does */ }
  const all = [...keys, ...retired].filter((k, i, a) => a.findIndex((x) => (x as { x?: string }).x === (k as { x?: string }).x) === i);
  console.log(JSON.stringify(all));
  console.error(`\n${all.length} key(s); signing with epoch ${epoch} (kid ${keys[0]!.kid}).\nBefore you change ONEHUMAN_SECRET, save the line above as ONEHUMAN_RETIRED_PROOF_KEYS so older proofs keep verifying.`);
}
