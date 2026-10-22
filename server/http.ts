// SPDX-License-Identifier: BUSL-1.1
/** Minimal helpers over node:http. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

export type Req = IncomingMessage;
export type Res = ServerResponse;

export function url(req: Req): URL {
  const host = req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || 'http';
  return new URL(req.url ?? '/', `${proto}://${host}`);
}

/** Adapter so the signature verifier can read Node headers. */
export function headerGetter(req: Req) {
  return {
    get(name: string): string | null {
      const v = req.headers[name.toLowerCase()];
      if (v === undefined) return null;
      return Array.isArray(v) ? v.join(', ') : v;
    },
  };
}

export function json(res: Res, status: number, body: unknown, extra: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(data);
}

export async function readJson(req: Req, maxBytes = 16000): Promise<unknown | undefined> {
  // Behind Express/Koa a body parser may already have consumed the stream: use its result.
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) return parsed;
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) return undefined;
    chunks.push(chunk as Buffer);
  }
  if (!size) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

export function cookies(req: Req): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Same-origin check for state-changing requests. */
export function sameOrigin(req: Req): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === url(req).origin;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export async function serveStatic(res: Res, root: string, path: string, extraHeaders: Record<string, string> = {}): Promise<boolean> {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, safe);
  if (!file.startsWith(root)) return false;
  try {
    const s = await stat(file);
    if (!s.isFile()) return false;
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
