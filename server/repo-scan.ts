// SPDX-License-Identifier: BUSL-1.1
/**
 * Scan a public GitHub repository without running any of it. The repository's source is downloaded from GitHub's own
 * archive host, only source-code files are written to a private temporary folder (names checked, sizes capped), the
 * scanner reads them as text, and the folder is removed. Nothing from the repository is ever executed or installed.
 */
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { scan, type ScanResult } from '../integrations/cli/scan.ts';
import { findingCounts, topFindings, type Finding } from '../integrations/cli/findings.ts';

export type ScanErrorCode = 'bad_repo' | 'not_found' | 'too_large' | 'unavailable' | 'empty';
export class ScanError extends Error {
  readonly code: ScanErrorCode;
  constructor(code: ScanErrorCode, message: string) { super(message); this.code = code; }
}

export const LIMITS = {
  /** compressed archive we are willing to download */
  archiveBytes: 40 * 1024 * 1024,
  /** source text we keep */
  keptBytes: 60 * 1024 * 1024,
  files: 12_000,
  fileBytes: 600_000,
  ms: 40_000,
};

const SOURCE = /\.(?:m?[jt]sx?|cjs|mts|html|vue|svelte|ejs|hbs|pug|njk)$/i;
const SKIP = /(?:^|\/)(?:node_modules|\.git|dist|build|\.next|out|coverage|\.turbo|\.cache|vendor|\.vercel|__tests__|tests?|e2e|fixtures?|docs?|examples?|\.github)(?:\/|$)/i;

/** "https://github.com/owner/name", "github.com/owner/name/tree/main", or "owner/name" */
export function parseRepo(input: string): { owner: string; name: string } {
  const s = String(input ?? '').trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(?:\/.*)?$/i) ?? s.match(/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/);
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') throw new ScanError('bad_repo', 'Paste the link of a public GitHub repository, like https://github.com/owner/name.');
  return { owner: m[1]!, name: m[2]! };
}

/**
 * Walk a gzip'd tar stream. `want(path, size)` decides, before anything is read into memory, whether a regular file is
 * kept; `onFile(path, data)` receives the kept ones. Symlinks, hard links and devices are never followed.
 */
export async function readTarGz(body: AsyncIterable<Uint8Array>, want: (path: string, size: number) => boolean, onFile: (path: string, data: Buffer) => void, o: { archiveBytes: number; deadline: number }): Promise<void> {
  const gunzip = createGunzip();
  let compressed = 0;
  const source = Readable.from((async function* () {
    for await (const chunk of body) {
      compressed += chunk.length;
      if (compressed > o.archiveBytes) throw new ScanError('too_large', 'This repository is too large to scan here. Run `npx onehumanai scan` in it yourself.');
      yield chunk;
    }
  })());
  source.on('error', (e) => gunzip.destroy(e));
  source.pipe(gunzip);

  const it = (gunzip as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  let buf: Buffer = Buffer.alloc(0);
  const fill = async (n: number): Promise<boolean> => {
    while (buf.length < n) {
      if (Date.now() > o.deadline) throw new ScanError('unavailable', 'The scan took too long. Try a smaller repository.');
      const r = await it.next();
      if (r.done) return false;
      buf = buf.length ? Buffer.concat([buf, r.value]) : r.value;
    }
    return true;
  };
  const skip = async (n: number) => {
    while (n > 0) {
      if (!buf.length && !(await fill(1))) return;
      const d = Math.min(n, buf.length); buf = buf.subarray(d); n -= d;
    }
  };

  let longName: string | null = null, paxPath: string | null = null;
  try {
    while (await fill(512)) {
      const h = buf.subarray(0, 512);
      if (h.every((b) => b === 0)) { buf = buf.subarray(512); continue; }
      const field = (a: number, n: number) => h.subarray(a, a + n).toString('utf8').replace(/\0[\s\S]*$/, '');
      const size = parseInt(field(124, 12).trim() || '0', 8);
      const type = String.fromCharCode(h[156] || 48);
      let name = field(0, 100);
      const prefix = field(345, 155);
      if (prefix) name = `${prefix}/${name}`;
      if (!Number.isFinite(size) || size < 0) throw new ScanError('unavailable', 'The archive could not be read.');
      buf = buf.subarray(512);
      const padding = (512 - (size % 512)) % 512;
      if (type === 'L' || type === 'x' || type === 'g') {
        // long names and pax headers are small: read them whole
        if (size > 65_536 || !(await fill(size + padding))) throw new ScanError('unavailable', 'The archive could not be read.');
        const text = buf.subarray(0, size).toString('utf8');
        if (type === 'L') longName = text.replace(/\0[\s\S]*$/, '');
        else if (type === 'x') paxPath = text.match(/(?:^|\n)\d+ path=([^\n]*)/)?.[1] ?? null;
        buf = buf.subarray(size + padding);
        continue;
      }
      if (longName) { name = longName; longName = null; }
      if (paxPath) { name = paxPath; paxPath = null; }
      const regular = type === '0' || type === '\0';
      if (regular && size > 0 && want(name, size)) {
        if (!(await fill(size + padding))) throw new ScanError('unavailable', 'The archive could not be read.');
        onFile(name, Buffer.from(buf.subarray(0, size)));
        buf = buf.subarray(size + padding);
      } else await skip(size + padding);
    }
  } finally { gunzip.destroy(); source.destroy(); }
}

export type RepoScan = {
  repo: string;
  filesScanned: number;
  frameworks: string[];
  routes: number;
  counts: Record<string, number>;
  findings: Finding[];
};

export async function scanRepo(input: string, o: { fetch?: typeof fetch; limits?: Partial<typeof LIMITS> } = {}): Promise<RepoScan> {
  const { owner, name } = parseRepo(input);
  const lim = { ...LIMITS, ...o.limits };
  const f = o.fetch ?? fetch;
  const deadline = Date.now() + lim.ms;
  let res: Response;
  try {
    // GitHub's archive host only: the host is fixed here, the visitor chooses just owner and name (validated above)
    res = await f(`https://codeload.github.com/${owner}/${name}/tar.gz/HEAD`, { headers: { 'User-Agent': 'onehuman-scan' }, signal: AbortSignal.timeout(lim.ms), redirect: 'follow' });
  } catch { throw new ScanError('unavailable', 'GitHub did not answer. Try again in a minute.'); }
  if (res.status === 404 || res.status === 403 || res.status === 401) throw new ScanError('not_found', 'That repository is private or does not exist. Only public repositories can be scanned.');
  if (!res.ok || !res.body) throw new ScanError('unavailable', 'GitHub did not give the repository. Try again in a minute.');
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > lim.archiveBytes) throw new ScanError('too_large', 'This repository is too large to scan here. Run `npx onehumanai scan` in it yourself.');

  const dir = await mkdtemp(join(tmpdir(), 'oh-repo-'));
  const writes: Promise<unknown>[] = [];
  let kept = 0, files = 0;
  const tooLarge = () => new ScanError('too_large', 'This repository is too large to scan here. Run `npx onehumanai scan` in it yourself.');
  try {
    await readTarGz(res.body as unknown as AsyncIterable<Uint8Array>,
      (path, size) => {
        const rel = path.split('/').slice(1).join('/');   // the archive's own top folder is dropped
        return !!rel && !rel.includes('\0') && SOURCE.test(rel) && !SKIP.test(rel) && size <= lim.fileBytes;
      },
      (path, data) => {
        const clean = normalize(path.split('/').slice(1).join('/'));
        if (clean.startsWith('..') || clean.startsWith(sep) || clean.split(sep).includes('..')) return;
        if (++files > lim.files || (kept += data.length) > lim.keptBytes) throw tooLarge();
        const target = join(dir, clean);
        if (!target.startsWith(dir + sep)) return;
        writes.push(mkdir(dirname(target), { recursive: true }).then(() => writeFile(target, data)));
      }, { archiveBytes: lim.archiveBytes, deadline });
    await Promise.all(writes);
    if (!files) throw new ScanError('empty', 'No JavaScript or TypeScript source was found in this repository.');
    const result: ScanResult = scan(dir);
    return {
      repo: `${owner}/${name}`,
      filesScanned: result.filesScanned,
      frameworks: result.frameworks,
      routes: result.routes.length,
      counts: findingCounts(result),
      findings: topFindings(result, 5),
    };
  } finally {
    await Promise.allSettled(writes);
    await rm(dir, { recursive: true, force: true });
  }
}
