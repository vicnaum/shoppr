// Thin HTTP layer for shoppr: undici fetch with a realistic desktop User-Agent,
// optional per-store session cookies, optional residential proxy, retries with
// backoff, and detection of bot-wall (DataDome) responses so we can surface a
// helpful "refresh your cookie" error instead of a cryptic 403.

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { ResolvedProxy } from './config.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export class BotWallError extends Error {
  constructor(public store: string) {
    super(
      `${store}: blocked by bot protection (DataDome). Your session cookie is missing or expired.\n` +
        `Fix: re-export a HAR while logged in / browsing ${store} and run:\n` +
        `  shoppr auth --store ${store} --har <file.har>\n` +
        `(or pass a fresh Cookie header with --cookie "...").`,
    );
    this.name = 'BotWallError';
  }
}

export interface FetchOptions {
  store: string;
  cookie?: string;
  proxy?: ResolvedProxy;
  accept?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  debug?: boolean;
}

function makeDispatcher(proxy?: ResolvedProxy): Dispatcher | undefined {
  if (!proxy?.useProxy || !proxy.proxyConfig) return undefined;
  const c = proxy.proxyConfig;
  const token = c.username
    ? `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}`
    : undefined;
  return new ProxyAgent({ uri: `${c.protocol}://${c.host}:${c.port}`, token });
}

/** Heuristic: DataDome / "enable JS" interstitial returned in place of content. */
function looksLikeBotWall(status: number, body: string): boolean {
  if (status === 403 || status === 401) {
    return /datadome|enable JS|var dd\s*=|captcha-delivery/i.test(body) || body.length < 4000;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Raw text fetch with retries + bot-wall detection. */
export async function fetchText(url: string, opts: FetchOptions): Promise<string> {
  const dispatcher = makeDispatcher(opts.proxy);
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {
        'User-Agent': USER_AGENT,
        Accept: opts.accept ?? 'application/json, text/plain, */*',
        'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
        ...opts.headers,
      };
      if (opts.cookie) headers.Cookie = opts.cookie;

      if (opts.debug) {
        const px = opts.proxy?.useProxy ? `proxy:${opts.proxy.proxyConfig?.host}` : 'direct';
        console.error(`  [http] GET ${url} | ${px} | cookie:${opts.cookie ? 'yes' : 'no'}`);
      }

      const res = await undiciFetch(url, { dispatcher, signal: ac.signal, headers });
      const body = await res.text();

      if (looksLikeBotWall(res.status, body)) throw new BotWallError(opts.store);

      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status} for ${url}: ${body.slice(0, 200)}`);
      }
      return body;
    } catch (err) {
      lastErr = err;
      // Don't retry a bot wall — the cookie won't fix itself.
      if (err instanceof BotWallError) throw err;
      if (attempt < retries) await sleep(500 * Math.pow(2, attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** JSON fetch (throws if the body isn't valid JSON). */
export async function fetchJson<T = any>(url: string, opts: FetchOptions): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${url} but got non-JSON (len ${text.length}).`);
  }
}
