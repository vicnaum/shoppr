// Read a store's session cookies straight from the local Chrome cookie store and
// decrypt them — so `shoppr auth --from-chrome` can refresh cookies without a
// manual HAR export. macOS only for now (Linux/Windows differ in key storage).
//
// macOS scheme: cookies live in an SQLite DB; `encrypted_value` is prefixed
// `v10` and is AES-128-CBC encrypted. The key is PBKDF2-HMAC-SHA1(password,
// salt="saltysalt", iterations=1003, len=16) where `password` comes from the
// Keychain entry "Chrome Safe Storage". Recent Chrome (v24+) also prepends a
// 32-byte SHA-256(host_key) to the plaintext, which we strip.

import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, createDecipheriv } from 'node:crypto';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// node:sqlite is experimental; silence just its warning for clean CLI output.
const origEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: any, ...rest: any[]) => {
  const msg = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/SQLite is an experimental feature/i.test(msg)) return;
  return (origEmit as any)(warning, ...rest);
}) as typeof process.emitWarning;

export interface ChromeCookieResult {
  cookie: string;
  count: number;
  names: string[];
  profile: string;
}

const CHROME_DIR = (browser: string) => {
  const base = join(homedir(), 'Library', 'Application Support');
  switch (browser) {
    case 'chrome':
      return join(base, 'Google', 'Chrome');
    case 'brave':
      return join(base, 'BraveSoftware', 'Brave-Browser');
    case 'edge':
      return join(base, 'Microsoft Edge');
    default:
      return join(base, 'Google', 'Chrome');
  }
};

const KEYCHAIN_SERVICE: Record<string, string> = {
  chrome: 'Chrome Safe Storage',
  brave: 'Brave Safe Storage',
  edge: 'Microsoft Edge Safe Storage',
};

export interface ReadChromeOpts {
  /** host_key suffixes to match, e.g. ['allegro.pl', 'allegro.com'] */
  domains: string[];
  profile?: string; // default "Default"
  browser?: string; // chrome | brave | edge
}

export function readChromeCookies(opts: ReadChromeOpts): ChromeCookieResult {
  if (process.platform !== 'darwin') {
    throw new Error(
      `--from-chrome currently supports macOS only (found ${process.platform}). Use --har or --cookie instead.`,
    );
  }
  const browser = opts.browser ?? 'chrome';
  const profile = opts.profile ?? 'Default';
  const dbPath = join(CHROME_DIR(browser), profile, 'Cookies');
  if (!existsSync(dbPath)) {
    throw new Error(
      `Cookie store not found: ${dbPath}\n` +
        `Check the browser/profile (--profile "<name>"), e.g. "Default", "Profile 1".`,
    );
  }

  const password = getKeychainPassword(KEYCHAIN_SERVICE[browser] ?? 'Chrome Safe Storage');
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const iv = Buffer.alloc(16, ' ');

  // Copy the DB (+ WAL/SHM) so we can read it while the browser holds a lock.
  const stamp = `${process.pid}-${profile.replace(/\W+/g, '_')}`;
  const tmp = join(tmpdir(), `shoppr-cookies-${stamp}.sqlite`);
  copyFileSync(dbPath, tmp);
  for (const ext of ['-wal', '-shm']) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, tmp + ext);

  try {
    // Required lazily (it's a Node experimental built-in); typed loosely so the
    // build doesn't depend on @types/node shipping the node:sqlite definitions.
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: any };
    const db = new DatabaseSync(tmp, { readOnly: true });
    const where = opts.domains.map(() => `host_key LIKE ?`).join(' OR ');
    const params = opts.domains.map((d) => `%${d}`);
    const rows = db
      .prepare(`SELECT host_key, name, encrypted_value FROM cookies WHERE ${where}`)
      .all(...params) as Array<{ host_key: string; name: string; encrypted_value: Uint8Array }>;
    db.close();

    // Last-writer-wins per name (dedupe across host variants like allegro.pl / .allegro.pl).
    const byName = new Map<string, string>();
    for (const r of rows) {
      const value = decryptValue(Buffer.from(r.encrypted_value), key, iv);
      if (value) byName.set(r.name, value);
    }
    const names = [...byName.keys()];
    const cookie = names.map((n) => `${n}=${byName.get(n)}`).join('; ');
    return { cookie, count: names.length, names, profile };
  } finally {
    for (const ext of ['', '-wal', '-shm']) {
      try {
        rmSync(tmp + ext, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

function getKeychainPassword(service: string): string {
  try {
    return execFileSync('security', ['find-generic-password', '-ws', service]).toString().trim();
  } catch {
    throw new Error(
      `Couldn't read "${service}" from the macOS Keychain. ` +
        `Approve the access prompt if shown, or run:\n  security find-generic-password -ws "${service}"`,
    );
  }
}

function decryptValue(buf: Buffer, key: Buffer, iv: Buffer): string {
  if (!buf || buf.length === 0) return '';
  const prefix = buf.subarray(0, 3).toString('latin1');
  if (prefix !== 'v10' && prefix !== 'v11') return buf.toString('utf8'); // not encrypted

  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  let out = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);

  // Strip PKCS#7 padding.
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);

  // Chrome v24+ prepends 32-byte SHA-256(host_key). Prefer the stripped value
  // when it yields clean printable ASCII; otherwise fall back.
  const allPrintable = (b: Buffer) => b.every((c) => c >= 0x20 && c < 0x7f);
  if (out.length > 32) {
    const stripped = out.subarray(32);
    if (allPrintable(stripped)) return stripped.toString('utf8');
  }
  if (allPrintable(out)) return out.toString('utf8');
  return out.subarray(32).toString('utf8');
}
