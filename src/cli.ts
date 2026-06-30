#!/usr/bin/env node

// CLI entry point for shoppr — multi-store shopping data extraction.
// Mirrors the reddx/twx interface: global -p/--print, per-command -f/-o,
// smart input parsing, json/md formatters, and an `auth` subcommand that stores
// per-store session cookies (+ optional proxy) in ~/.config/shoppr/.env.

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import {
  getConfigPath,
  resolveCookie,
  saveCookie,
  resolveProxy,
  saveProxy,
  type ResolvedProxy,
} from './config.js';
import { DEFAULT_STORE, STORES, STORE_COOKIE_DOMAINS, getProvider, isStore } from './providers/index.js';
import { readChromeCookies } from './cookies/chrome.js';
import { sanitizeCookieHeader } from './cookies/sanitize.js';
import { detectStore } from './utils/input-parser.js';
import { ensureDir, sanitizeForFilename } from './utils/index.js';
import { toJson, productToMarkdown, reviewsToMarkdown, listingToMarkdown } from './formatters.js';
import type { StoreId } from './types.js';
import { BotWallError } from './http.js';

const toInt = (v: string): number => parseInt(v, 10);

const program = new Command();

program
  .name('shoppr')
  .description('Shopping data extraction (product details, prices, reviews, offers, search) — Allegro first')
  .version('0.1.0')
  .option('--proxy <url>', 'Proxy URL http://user:pass@host:port (saved when used with `auth`)')
  .option('--no-proxy', 'Force a direct connection (ignore configured proxy)')
  .option('-p, --print', 'Print output to terminal instead of writing files')
  .option('--debug', 'Verbose HTTP logging to stderr');

// ─── helpers ──────────────────────────────────────────────────────────────────

function resolveStore(input: string, override?: string): StoreId {
  if (override) {
    if (!isStore(override)) {
      throw new Error(`Unknown store "${override}". Known: ${STORES.join(', ')}.`);
    }
    return override;
  }
  return detectStore(input) ?? DEFAULT_STORE;
}

function makeCtx(store: StoreId): { cookie?: string; proxy: ResolvedProxy; debug: boolean } {
  const g = program.opts();
  const noProxy = g.proxy === false;
  const cliProxy = typeof g.proxy === 'string' ? g.proxy : undefined;
  const proxy = resolveProxy(cliProxy, { noProxy });
  const cookie = resolveCookie(store);
  if (g.debug) {
    console.error(
      chalk.dim(`  [ctx] store=${store} cookie=${cookie ? 'yes' : 'no'} proxy=${proxy.useProxy ? proxy.source : 'direct'}`),
    );
  }
  return { cookie, proxy, debug: !!g.debug };
}

async function writeOutput(
  opts: { format: string; output: string },
  baseName: string,
  content: { json: string; md: string },
): Promise<void> {
  const fmt = opts.format;
  if (program.opts().print) {
    console.log();
    console.log(fmt === 'json' ? content.json : content.md);
    return;
  }
  await ensureDir(opts.output);
  const base = join(opts.output, baseName);
  if (fmt === 'json' || fmt === 'both') await writeFile(`${base}.json`, content.json);
  if (fmt === 'md' || fmt === 'both') await writeFile(`${base}.md`, content.md);
  console.log(`  Output: ${opts.output}/`);
}

function fail(err: unknown): never {
  if (err instanceof BotWallError) {
    console.error(chalk.red('\n' + err.message));
  } else {
    console.error(chalk.red(`\nError: ${err instanceof Error ? err.message : String(err)}`));
  }
  process.exit(1);
}

const outputOpts = (cmd: Command): Command =>
  cmd
    .option('-f, --format <fmt>', 'Output format: json | md | both', 'both')
    .option('-o, --output <dir>', 'Output directory', './output')
    .option('-s, --store <store>', `Store (${STORES.join(', ')}); auto-detected from URL if omitted`);

// ─── product ──────────────────────────────────────────────────────────────────

outputOpts(
  program
    .command('product <input>')
    .description('Fetch product details: title, price, brand, rating, description, specs')
    .option('-l, --limit <n>', 'Ignored for product (kept for symmetry)', toInt),
).action(async (input: string, opts: any) => {
  const store = resolveStore(input, opts.store);
  const ctx = makeCtx(store);
  const spinner = ora(`Fetching product from ${store}…`).start();
  try {
    const product = await getProvider(store).fetchProduct(input, ctx);
    spinner.succeed(`Product: ${product.title || product.productId}`);
    await writeOutput(opts, `${sanitizeForFilename(product.title || product.productId)}_product`, {
      json: toJson(product),
      md: productToMarkdown(product),
    });
  } catch (err) {
    spinner.fail('Failed');
    fail(err);
  }
});

// ─── reviews ──────────────────────────────────────────────────────────────────

outputOpts(
  program
    .command('reviews <input>')
    .description('Fetch product reviews/opinions (Allegro: no cookie needed)')
    .option('-l, --limit <n>', 'Max reviews (0 = all)', toInt, 0)
    .option('--page <n>', 'Fetch only this single page', toInt)
    .option('--sort <mode>', 'Sort (store-specific; allegro: MOST_HELPFUL|NEWEST|…, amazon: helpful|recent)'),
).action(async (input: string, opts: any) => {
  const store = resolveStore(input, opts.store);
  const ctx = makeCtx(store);
  const spinner = ora(`Fetching reviews from ${store}…`).start();
  try {
    const result = await getProvider(store).fetchReviews(input, { limit: opts.limit, page: opts.page, sort: opts.sort }, ctx);
    spinner.succeed(`${result.reviews.length} review(s) of ${result.totalCount}`);
    await writeOutput(opts, `${sanitizeForFilename(result.productId)}_reviews`, {
      json: toJson(result),
      md: reviewsToMarkdown(result),
    });
  } catch (err) {
    spinner.fail('Failed');
    fail(err);
  }
});

// ─── offers ───────────────────────────────────────────────────────────────────

outputOpts(
  program
    .command('offers <input>')
    .description('Fetch all sellers/offers (with prices) for one product')
    .option('-l, --limit <n>', 'Max offers (0 = all)', toInt, 0),
).action(async (input: string, opts: any) => {
  const store = resolveStore(input, opts.store);
  const ctx = makeCtx(store);
  const spinner = ora(`Fetching offers from ${store}…`).start();
  try {
    const result = await getProvider(store).fetchOffers(input, { limit: opts.limit || undefined }, ctx);
    spinner.succeed(`${result.offers.length} offer(s)`);
    await writeOutput(opts, `${sanitizeForFilename(input)}_offers`, {
      json: toJson(result),
      md: listingToMarkdown(result),
    });
  } catch (err) {
    spinner.fail('Failed');
    fail(err);
  }
});

// ─── search ───────────────────────────────────────────────────────────────────

outputOpts(
  program
    .command('search <query>')
    .description('Search the store for products/offers')
    .option('-l, --limit <n>', 'Max results (0 = all on page)', toInt, 0)
    .option('--category <id>', 'Restrict to a category id'),
).action(async (query: string, opts: any) => {
  const store = resolveStore('', opts.store);
  const ctx = makeCtx(store);
  const spinner = ora(`Searching ${store} for "${query}"…`).start();
  try {
    const result = await getProvider(store).search(query, { limit: opts.limit || undefined, category: opts.category }, ctx);
    spinner.succeed(`${result.offers.length} result(s)`);
    await writeOutput(opts, `search_${sanitizeForFilename(query)}`, {
      json: toJson(result),
      md: listingToMarkdown(result),
    });
  } catch (err) {
    spinner.fail('Failed');
    fail(err);
  }
});

// ─── category ─────────────────────────────────────────────────────────────────

outputOpts(
  program
    .command('category <input>')
    .description('Fetch a category feed (pass a /kategoria/ URL or slug)')
    .option('-l, --limit <n>', 'Max results (0 = all on page)', toInt, 0),
).action(async (input: string, opts: any) => {
  const store = resolveStore(input, opts.store);
  const ctx = makeCtx(store);
  const spinner = ora(`Fetching category from ${store}…`).start();
  try {
    const result = await getProvider(store).fetchCategory(input, { limit: opts.limit || undefined }, ctx);
    spinner.succeed(`${result.offers.length} result(s)`);
    await writeOutput(opts, `category_${sanitizeForFilename(input)}`, {
      json: toJson(result),
      md: listingToMarkdown(result),
    });
  } catch (err) {
    spinner.fail('Failed');
    fail(err);
  }
});

// ─── auth ─────────────────────────────────────────────────────────────────────

program
  .command('auth')
  .description('Configure per-store cookies (from HAR or string) and/or a proxy')
  .option('-s, --store <store>', `Store to set a cookie for (${STORES.join(', ')})`)
  .option('--har <file>', 'Extract the store cookie from a HAR file')
  .option('--from-chrome', 'Read & decrypt the store cookie from the local browser cookie store (macOS)')
  .option('--browser <name>', 'Browser for --from-chrome: chrome | brave | edge', 'chrome')
  .option('--profile <name>', 'Browser profile for --from-chrome (default: Default)')
  .option('--cookie <string>', 'Set the Cookie header directly')
  .option('--proxy <url>', 'Save a proxy URL http://user:pass@host:port')
  .action(async (opts: any) => {
    const g = program.opts();
    let didSomething = false;

    if (opts.proxy || (typeof g.proxy === 'string' && g.proxy)) {
      const url = opts.proxy || g.proxy;
      await saveProxy(url);
      console.log(chalk.green(`✓ Proxy saved.`));
      didSomething = true;
    }

    if (opts.har || opts.cookie || opts.fromChrome) {
      const store = opts.store;
      if (!store || !isStore(store)) {
        return fail(new Error(`--store is required for cookies. Known: ${STORES.join(', ')}.`));
      }
      let cookie = opts.cookie as string | undefined;
      if (opts.har) {
        cookie = await extractCookieFromHar(opts.har, store);
        if (!cookie) return fail(new Error(`No cookie for ${store} found in ${opts.har}.`));
      }
      if (opts.fromChrome) {
        const res = readChromeCookies({
          domains: STORE_COOKIE_DOMAINS[store],
          browser: opts.browser,
          profile: opts.profile,
        });
        if (!res.count) {
          return fail(
            new Error(
              `No ${store} cookies found in ${opts.browser} profile "${res.profile}". ` +
                `Browse ${store} in that browser/profile first, or pass --profile "<name>".`,
            ),
          );
        }
        cookie = res.cookie;
      }
      const { cookie: clean, kept, dropped } = sanitizeCookieHeader(cookie!);
      if (!kept.length) return fail(new Error(`No usable cookies for ${store} after filtering.`));
      await saveCookie(store, clean);
      // Mention the store's bot-wall gate cookie so users know it made it in.
      const gate = store === 'allegro' ? 'datadome' : null;
      const gateNote = gate ? `, incl. ${kept.includes(gate) ? `${gate} ✓` : `no ${gate} ✗`}` : '';
      const dropNote = dropped.length ? ` (dropped ${dropped.length} tracking/invalid)` : '';
      console.log(chalk.green(`✓ Cookie saved for ${store} (${kept.length} cookies${gateNote})${dropNote}.`));
      didSomething = true;
    }

    // Default / status view.
    console.log();
    console.log(chalk.bold('shoppr config:'), getConfigPath());
    for (const s of STORES) {
      const c = resolveCookie(s);
      console.log(`  ${s}: cookie ${c ? chalk.green('set') : chalk.yellow('—')}`);
    }
    const proxy = resolveProxy(undefined, {});
    console.log(`  proxy: ${proxy.useProxy ? chalk.green(`${proxy.proxyConfig?.host} (${proxy.source})`) : chalk.yellow('none')}`);
    if (!didSomething) {
      console.log();
      console.log(chalk.dim('Set a cookie:  shoppr auth --store allegro --har allegro.pl.har'));
      console.log(chalk.dim('Set a proxy:   shoppr auth --proxy http://user:pass@host:port'));
    }
  });

/** Pull the most complete Cookie header for a store's host out of a HAR file. */
async function extractCookieFromHar(file: string, store: StoreId): Promise<string | undefined> {
  const har = JSON.parse(await readFile(file, 'utf-8'));
  const domains = STORE_COOKIE_DOMAINS[store];
  let best: string | undefined;
  for (const entry of har?.log?.entries ?? []) {
    let host = '';
    try {
      host = new URL(entry.request.url).hostname;
    } catch {
      continue;
    }
    if (!domains.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    const cookieHeader = (entry.request.headers ?? []).find((h: any) => h.name.toLowerCase() === 'cookie');
    if (cookieHeader?.value && (!best || cookieHeader.value.length > best.length)) {
      best = cookieHeader.value;
    }
  }
  return best;
}

program.parseAsync(process.argv).catch(fail);
