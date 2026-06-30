// Central config module for shoppr CLI.
//
// shoppr scrapes online stores' own JSON/HTML endpoints (no official API by
// default). Two kinds of secrets matter, both optional and resolved the same way:
//
//   1. Per-store session cookies — needed to get past bot walls (e.g. Allegro's
//      DataDome) and to see correct, region-specific delivery prices. Stored as
//      <STORE>_COOKIE, e.g. ALLEGRO_COOKIE="datadome=...; QXLSESSID=...".
//      Reviews work without cookies; product/offers/search usually need them.
//   2. An optional HTTP/residential proxy (PROXY_*), shared across stores.
//
// Resolution order for every value (first hit wins):
//   1. Environment variables (incl. a local .env loaded by dotenv at startup)
//   2. Ancestor .env files (cwd upward)
//   3. ~/.config/shoppr/.env (global config)
//
// Pattern mirrors the reddx/reviewr toolkits.

import { homedir } from 'os';
import { join, resolve, dirname } from 'path';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';

const CONFIG_DIR = join(homedir(), '.config', 'shoppr');
const CONFIG_FILE = join(CONFIG_DIR, '.env');

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

// ─── .env helpers ───────────────────────────────────────────────────────────

/** Simple key=value .env parser. Returns {} if the file doesn't exist. */
function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const vars: Record<string, string> = {};
  for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) vars[key] = value;
  }
  return vars;
}

function ancestorEnvPaths(startDir: string = process.cwd()): string[] {
  const paths: string[] = [];
  let dir = resolve(startDir);
  while (true) {
    paths.push(join(dir, '.env'));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [...new Set(paths)];
}

/** All config sources, highest priority first. */
function envSources(): Record<string, string>[] {
  return [
    process.env as Record<string, string>,
    ...ancestorEnvPaths().map(loadEnvFile),
    loadEnvFile(CONFIG_FILE),
  ];
}

/** First non-empty value for `key` across all sources, or undefined. */
function resolveVar(key: string): string | undefined {
  for (const vars of envSources()) {
    if (vars[key]) return vars[key];
  }
  return undefined;
}

/** Merge key=value updates into ~/.config/shoppr/.env, preserving other keys. */
async function mergeGlobalConfig(updates: Record<string, string>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  const current = loadEnvFile(CONFIG_FILE);
  const merged = { ...current, ...updates };
  const content =
    Object.entries(merged)
      .map(([k, v]) => `${k}=${quoteIfNeeded(v)}`)
      .join('\n') + '\n';
  await writeFile(CONFIG_FILE, content, 'utf-8');
}

function quoteIfNeeded(v: string): string {
  // Cookie strings contain spaces and `;` — wrap them so re-parsing is safe.
  return /[\s;#"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

// ─── Per-store cookies ──────────────────────────────────────────────────────

function cookieKey(store: string): string {
  return `${store.toUpperCase()}_COOKIE`;
}

/** Resolve the saved Cookie header for a store, or undefined. */
export function resolveCookie(store: string): string | undefined {
  return resolveVar(cookieKey(store));
}

/** Persist a store's Cookie header to ~/.config/shoppr/.env (preserving others). */
export async function saveCookie(store: string, cookie: string): Promise<void> {
  await mergeGlobalConfig({ [cookieKey(store)]: cookie.trim() });
}

// ─── Proxy (shared across stores) ───────────────────────────────────────────

export interface ProxyConfig {
  protocol: 'http' | 'https';
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ResolvedProxy {
  useProxy: boolean;
  proxyUrl: string | null;
  proxyConfig: ProxyConfig | null;
  source: 'cli' | 'env' | 'local-env' | 'global-config' | 'none';
}

/** Parse a proxy URL like http://user:pass@host:port into components. */
export function parseProxyUrl(url: string): ProxyConfig {
  const withScheme = /^[a-z]+:\/\//i.test(url) ? url : `http://${url}`;
  try {
    const parsed = new URL(withScheme);
    return {
      protocol: parsed.protocol === 'https:' ? 'https' : 'http',
      host: parsed.hostname,
      port: parseInt(parsed.port) || 0,
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  } catch {
    throw new Error(`Invalid proxy URL: ${url}`);
  }
}

function toProxyUrl(c: ProxyConfig): string {
  const auth = c.username ? `${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@` : '';
  return `${c.protocol}://${auth}${c.host}:${c.port}`;
}

function configFromVars(vars: Record<string, string>): ProxyConfig | null {
  if (!vars.PROXY_HOST) return null;
  if (vars.USE_PROXY === 'false') return null;
  return {
    protocol: vars.PROXY_PROTOCOL === 'https' ? 'https' : 'http',
    host: vars.PROXY_HOST,
    port: parseInt(vars.PROXY_PORT || '0'),
    username: vars.PROXY_USERNAME || '',
    password: vars.PROXY_PASSWORD || '',
  };
}

/** Persist proxy config to ~/.config/shoppr/.env (preserving cookies). */
export async function saveProxy(proxyUrl: string): Promise<void> {
  const config = parseProxyUrl(proxyUrl);
  await mergeGlobalConfig({
    USE_PROXY: 'true',
    PROXY_PROTOCOL: config.protocol,
    PROXY_HOST: config.host,
    PROXY_PORT: String(config.port),
    PROXY_USERNAME: config.username,
    PROXY_PASSWORD: config.password,
  });
}

/**
 * Resolve the proxy to use.
 * @param cliProxyUrl value of --proxy flag (if any)
 * @param opts.noProxy force a direct connection
 */
export function resolveProxy(cliProxyUrl?: string, opts: { noProxy?: boolean } = {}): ResolvedProxy {
  if (opts.noProxy) {
    return { useProxy: false, proxyUrl: null, proxyConfig: null, source: 'none' };
  }
  if (cliProxyUrl) {
    const config = parseProxyUrl(cliProxyUrl);
    return { useProxy: true, proxyUrl: toProxyUrl(config), proxyConfig: config, source: 'cli' };
  }
  const envConfig = configFromVars(process.env as Record<string, string>);
  if (envConfig) {
    return { useProxy: true, proxyUrl: toProxyUrl(envConfig), proxyConfig: envConfig, source: 'env' };
  }
  for (const envPath of ancestorEnvPaths()) {
    const config = configFromVars(loadEnvFile(envPath));
    if (config) {
      return { useProxy: true, proxyUrl: toProxyUrl(config), proxyConfig: config, source: 'local-env' };
    }
  }
  const globalConfig = configFromVars(loadEnvFile(CONFIG_FILE));
  if (globalConfig) {
    return { useProxy: true, proxyUrl: toProxyUrl(globalConfig), proxyConfig: globalConfig, source: 'global-config' };
  }
  return { useProxy: false, proxyUrl: null, proxyConfig: null, source: 'none' };
}
