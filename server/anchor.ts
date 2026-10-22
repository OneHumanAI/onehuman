// SPDX-License-Identifier: BUSL-1.1
/**
 * Chain anchoring with RFC 3161 timestamps. The audit chain proves order and integrity, but its keys and clock are the
 * deployment's own: whoever holds the secret could rebuild a chain. An anchor sends the chain head's hash (only the
 * hash, nothing else) to an independent timestamp authority and keeps its signed answer, so anyone can show later
 * that this exact chain existed at that time. Verify with OpenSSL: `openssl ts -verify -in <seq>.tsr -data
 * <seq>.head.txt -CAfile <tsa-ca.pem>` (files from `npx onehumanai anchors --out <dir>`).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Store } from './db.ts';

const len = (n: number) => (n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const int = (b: Buffer) => tlv(0x02, b[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const SHA256_ALG = seq(Buffer.from('0609608648016503040201', 'hex'), Buffer.from('0500', 'hex'));

/** The message imprint of a chain head: SHA-256 of the head hash as written in the chain (e.g. "v2:…"). */
export const headDigest = (hash: string) => createHash('sha256').update(hash, 'utf8').digest();

/** A DER TimeStampReq: version 1, SHA-256 imprint, a nonce, and the TSA's certificate requested in the answer. */
export function timestampRequest(digest: Buffer, nonce: Buffer = randomBytes(8)): Buffer {
  return seq(int(Buffer.from([1])), seq(SHA256_ALG, tlv(0x04, digest)), int(nonce), tlv(0x01, Buffer.from([0xff])));
}

/** Read one DER element at `at`: its tag, the start of its body and the end. */
function element(b: Buffer, at: number): { tag: number; body: number; end: number } {
  const tag = b[at]!;
  let n = b[at + 1]!, body = at + 2;
  if (n & 0x80) { const k = n & 0x7f; n = 0; for (let i = 0; i < k; i++) n = (n << 8) | b[at + 2 + i]!; body = at + 2 + k; }
  return { tag, body, end: body + n };
}

/** The PKIStatus of a TimeStampResp (0 granted, 1 granted with modifications, 2+ refused), or null if unreadable. */
export function timestampStatus(resp: Buffer): number | null {
  try {
    const outer = element(resp, 0); if (outer.tag !== 0x30) return null;
    const info = element(resp, outer.body); if (info.tag !== 0x30) return null;
    const status = element(resp, info.body); if (status.tag !== 0x02) return null;
    let v = 0; for (let i = status.body; i < status.end; i++) v = (v << 8) | resp[i]!;
    return v;
  } catch { return null; }
}

export type AnchorResult = { room: string; seq: number; ok: boolean; error?: string };

/** Anchor every chain head that moved since its last anchor. Failures are reported, never thrown: anchoring is extra. */
export async function anchorChains(store: Store, opts: { tsa: string; fetchImpl?: typeof fetch; now?: number; timeoutMs?: number }): Promise<AnchorResult[]> {
  const f = opts.fetchImpl ?? fetch;
  const out: AnchorResult[] = [];
  for (const h of await store.chainHeads()) {
    const last = await store.lastAnchor(h.room);
    if (last && last.seq >= h.seq) continue;
    const req = timestampRequest(headDigest(h.hash));
    try {
      const r = await f(opts.tsa, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: new Uint8Array(req), signal: AbortSignal.timeout(opts.timeoutMs ?? 10000) });
      if (!r.ok) { out.push({ room: h.room, seq: h.seq, ok: false, error: `TSA answered ${r.status}` }); continue; }
      const resp = Buffer.from(await r.arrayBuffer());
      const status = timestampStatus(resp);
      if (status !== 0 && status !== 1) { out.push({ room: h.room, seq: h.seq, ok: false, error: `TSA refused (status ${status})` }); continue; }
      await store.addAnchor({ room: h.room, seq: h.seq, hash: h.hash, tsa: opts.tsa, request: req.toString('base64'), response: resp.toString('base64'), created: opts.now ?? Date.now() });
      out.push({ room: h.room, seq: h.seq, ok: true });
    } catch (e) {
      out.push({ room: h.room, seq: h.seq, ok: false, error: String((e as Error).message ?? e) });
    }
  }
  return out;
}
