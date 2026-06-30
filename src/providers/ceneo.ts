// Ceneo (ceneo.pl) provider — a Polish price-comparison engine, so it's the best
// fit for shoppr's "all sellers + prices" use case. HTML scraping, but cleaner
// than Amazon: product pages carry an ld+json Product (name/brand/rating +
// AggregateOffer low/high/count) and each shop offer is a row with the price in
// `data-Price` / `data-ShopUrl` attributes. No cookie needed for anything.

import { fetchText } from '../http.js';
import type { Offer, Price, Product, Review, ReviewsResult, ListingResult } from '../types.js';
import type { ListOpts, Provider, ProviderCtx, ReviewOpts } from './provider.js';

const BASE = 'https://www.ceneo.pl';
const REVIEW_SORTS = ['the_most_useful', 'newest', 'oldest', 'highest_score', 'lowest_score'] as const;

// ─── helpers ──────────────────────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;| /g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function first(re: RegExp, html: string): string | null {
  const m = html.match(re);
  return m ? m[1] : null;
}

/** Ceneo prices come as "230.85" (offers) or "355,5900" (search tiles). */
function parseCeneoMoney(s: string | number | null | undefined): number | null {
  if (s === null || s === undefined || s === '') return null;
  const n = typeof s === 'number' ? s : parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function formatPLN(n: number): string {
  return `${n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
}

function price(n: number | null): Price | null {
  return n === null ? null : { amount: n, currency: 'PLN', formatted: formatPLN(n) };
}

async function get(url: string, ctx: ProviderCtx): Promise<string> {
  return fetchText(url, {
    store: 'ceneo',
    cookie: ctx.cookie,
    proxy: ctx.proxy,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    headers: { Referer: `${BASE}/`, 'Accept-Language': 'pl-PL,pl;q=0.9' },
    debug: ctx.debug,
  });
}

// ─── input parsing ──────────────────────────────────────────────────────────

/** Ceneo product ids are numeric. Accept a URL (…/<id>[;…|/opinie]) or a bare id. */
export function parseProductId(input: string): string | null {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const m = url.pathname.match(/\/(\d{4,})(?:[;/]|$)/);
    if (m) return m[1];
  } catch {
    if (/^\d{4,}$/.test(trimmed)) return trimmed;
  }
  const any = trimmed.match(/(?:^|\/)(\d{4,})(?:[;/]|$)/);
  return any ? any[1] : null;
}

function ldProduct(html: string): any | null {
  for (const block of html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? []) {
    const json = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    try {
      const d = JSON.parse(json);
      if (d['@type'] === 'Product') return d;
    } catch {
      /* skip */
    }
  }
  return null;
}

// ─── PRODUCT ────────────────────────────────────────────────────────────────

export async function fetchProduct(input: string, ctx: ProviderCtx): Promise<Product> {
  const id = parseProductId(input);
  if (!id) throw new Error('Could not find a Ceneo product id (expected a ceneo.pl/<id> URL or bare numeric id).');
  const html = await get(`${BASE}/${id}`, ctx);
  const ld = ldProduct(html);
  const agg = ld?.offers ?? {};
  const low = parseCeneoMoney(agg.lowPrice);

  return {
    store: 'ceneo',
    productId: id,
    offerId: null,
    url: `${BASE}/${id}`,
    title: ld?.name ? decodeEntities(ld.name).trim() : first(/<h1[^>]*>([^<]+)</, html)?.trim() ?? '',
    brand: ld?.brand?.name ?? (typeof ld?.brand === 'string' ? ld.brand : null),
    gtin: ld?.gtin13 ?? ld?.gtin ?? null,
    image: typeof ld?.image === 'string' ? ld.image : Array.isArray(ld?.image) ? ld.image[0] : null,
    // The headline price on Ceneo is the lowest offer ("od …").
    price: price(low),
    description: ld?.description ? stripTags(ld.description) : null,
    parameters: parseSpecs(html),
    rating: ld?.aggregateRating
      ? { value: Number(ld.aggregateRating.ratingValue), count: Number(ld.aggregateRating.ratingCount) }
      : null,
  };
}

/** Ceneo spec table: rows of <th/dt>label</…><td/dd>value</…>. Best-effort. */
function parseSpecs(html: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  const scope = (html.match(/id="productTechSpecs"[\s\S]*?<\/section>/) ?? [html])[0];
  const re =
    /__row__name"[^>]*>([\s\S]*?)<\/td>[\s\S]{0,120}?__row__value[^>]*>([\s\S]*?)<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    const name = stripTags(m[1]);
    const value = stripTags(m[2]);
    const key = name.toLowerCase();
    if (!name || !value || seen.has(key) || name.length > 60) continue;
    seen.add(key);
    out.push({ name, value });
    if (out.length > 80) break;
  }
  return out;
}

// ─── OFFERS (Ceneo's strength: every shop) ────────────────────────────────────

export async function fetchOffers(input: string, opts: ListOpts, ctx: ProviderCtx): Promise<ListingResult> {
  const id = parseProductId(input);
  if (!id) throw new Error('Could not find a Ceneo product id.');
  const html = await get(`${BASE}/${id}`, ctx);
  const ld = ldProduct(html);
  const productName = ld?.name ? decodeEntities(ld.name).trim() : '';

  const containers = html.split('js_product-offer"').slice(1);
  const attr = (c: string, a: string) => (c.match(new RegExp(`${a}="([^"]+)"`, 'i')) ?? [])[1] ?? null;

  let offers: Offer[] = containers
    .map((c): Offer | null => {
      const amount = parseCeneoMoney(attr(c, 'data-Price'));
      if (amount === null) return null;
      const shop = attr(c, 'data-ShopUrl') ?? attr(c, 'data-Shop');
      const offerId = attr(c, 'data-OfferId') ?? '';
      return {
        store: 'ceneo',
        offerId,
        title: productName || (shop ?? ''),
        url: offerId ? `${BASE}/Click/Offer/${offerId}` : `${BASE}/${id}`,
        price: price(amount),
        oldPrice: null,
        seller: shop,
        superSeller: false,
        freeDelivery: /data-freeDelivery="1"|data-freedelivery="1"/i.test(c) || null,
        delivery: parseCeneoMoney(attr(c, 'data-DeliveryCost')) !== null ? formatPLN(parseCeneoMoney(attr(c, 'data-DeliveryCost'))!) : null,
        rating: null,
        soldCount: null,
        image: null,
        sellingMode: 'buyNow',
      };
    })
    .filter((o): o is Offer => o !== null)
    // dedupe by shop+price (Ceneo repeats offers across page widgets)
    .filter((o, i, arr) => arr.findIndex((x) => x.seller === o.seller && x.price?.amount === o.price?.amount) === i)
    .sort((a, b) => (a.price?.amount ?? Infinity) - (b.price?.amount ?? Infinity));

  if (opts.limit) offers = offers.slice(0, opts.limit);
  return { store: 'ceneo', kind: 'offers', query: input, totalCount: offers.length, offers };
}

// ─── REVIEWS ──────────────────────────────────────────────────────────────────

export async function fetchReviews(input: string, opts: ReviewOpts, ctx: ProviderCtx): Promise<ReviewsResult> {
  const id = parseProductId(input);
  if (!id) throw new Error('Could not find a Ceneo product id.');
  const limit = opts.limit ?? 0;
  const reviews: Review[] = [];
  let rating: { value: number; count: number } | null = null;
  let page = opts.page ?? 1;

  for (;;) {
    const sort = opts.sort ?? 'the_most_useful';
    const html = await get(`${BASE}/${id}/opinie-${page}?sort=${sort}`, ctx);
    if (!rating) {
      const ld = ldProduct(html);
      if (ld?.aggregateRating)
        rating = { value: Number(ld.aggregateRating.ratingValue), count: Number(ld.aggregateRating.ratingCount) };
    }
    const batch = parseReviews(html);
    if (!batch.length) break;
    reviews.push(...batch);
    if (limit && reviews.length >= limit) break;
    if (opts.page) break;
    page += 1;
    if (page > 50) break;
  }
  if (limit && reviews.length > limit) reviews.length = limit;

  return {
    store: 'ceneo',
    productId: id,
    rating,
    page: opts.page ?? 1,
    totalPages: 0,
    totalCount: rating?.count ?? reviews.length,
    reviews,
  };
}

function parseReviews(html: string): Review[] {
  const out: Review[] = [];
  const blocks = html.split(/class="user-post(?:\s+js_product-review)?[ "]/).slice(1);
  for (const b of blocks) {
    const author = first(/user-post__author-name[^>]*>([^<]+)</, b);
    const scoreStr = first(/user-post__score-count[^>]*>([0-9.,]+)/, b);
    const date = first(/<time[^>]*datetime="([^"]+)"/, b);
    const textRaw = first(/user-post__text[^>]*>([\s\S]*?)<\/div>/, b);
    const pros = first(/Zalety<\/[^>]+>\s*<div[^>]*>([\s\S]*?)<\/div>/i, b);
    const cons = first(/Wady<\/[^>]+>\s*<div[^>]*>([\s\S]*?)<\/div>/i, b);
    // Skip the comment-form / section-heading blocks that share the user-post class.
    if (!author) continue;
    out.push({
      id: null,
      author: author ? decodeEntities(author).trim() : 'anonim',
      rating: scoreStr ? Number(scoreStr.replace(',', '.')) : null,
      text: textRaw ? stripTags(textRaw) : '',
      pros: pros ? stripTags(pros) : '',
      cons: cons ? stripTags(cons) : '',
      images: [],
      createdAt: date ?? null,
    });
    if (out.length > 200) break;
  }
  return out;
}

// ─── SEARCH / CATEGORY ────────────────────────────────────────────────────────

export async function search(query: string, opts: ListOpts, ctx: ProviderCtx): Promise<ListingResult> {
  // Ceneo expects spaces as "+" in the ;szukaj- segment (browser behaviour).
  const q = encodeURIComponent(query.trim()).replace(/%20/g, '+');
  const html = await get(`${BASE}/;szukaj-${q}`, ctx);
  return { store: 'ceneo', kind: 'search', query, ...parseTiles(html, opts.limit) };
}

export async function fetchCategory(input: string, opts: ListOpts, ctx: ProviderCtx): Promise<ListingResult> {
  const url = /^https?:\/\//.test(input) ? input : `${BASE}/${input.replace(/^\/+/, '')}`;
  const html = await get(url, ctx);
  return { store: 'ceneo', kind: 'category', query: input, ...parseTiles(html, opts.limit) };
}

/** Search-tile price: prefer the `data-price` attr, else combine value/penny spans. */
function tilePrice(t: string): number | null {
  const dp = t.match(/data-price="([^"]+)"/);
  if (dp) return parseCeneoMoney(dp[1]);
  const vp = t.match(/class="value">([^<]+)<\/span>\s*<span class="penny">([^<]+)/);
  if (vp) return parseCeneoMoney(vp[1].replace(/\s/g, '') + vp[2]);
  return null;
}

function parseTiles(html: string, limit?: number): { totalCount: number | null; offers: Offer[] } {
  const offers: Offer[] = [];
  const seen = new Set<string>();
  // Each product is a `cat-prod-row` container (it holds several data-pid nodes, so
  // splitting on data-pid would scatter name/price across segments).
  const tiles = html.split(/<div\s+class="cat-prod-row\b/).slice(1);
  for (const t of tiles) {
    const pid = (t.match(/data-pid="(\d+)"/) ?? [])[1];
    if (!pid || seen.has(pid)) continue;
    // First `<a title="…">` is the product name; the next is the "Opinie o …" link.
    const name = first(/<a[^>]*\btitle="([^"]{4,})"/, t);
    const amount = tilePrice(t);
    if (!name) continue;
    seen.add(pid);
    const ratingVal = first(/data-productrating="([^"]+)"/, t) ?? first(/product-score[^>]*>\s*([\d,]+)/, t);
    offers.push({
      store: 'ceneo',
      offerId: pid,
      title: decodeEntities(name).trim(),
      url: `${BASE}/${pid}`,
      price: price(amount),
      oldPrice: null,
      seller: null,
      superSeller: false,
      freeDelivery: null,
      delivery: null,
      rating: ratingVal ? { value: Number(ratingVal.replace(',', '.')), count: 0 } : null,
      soldCount: null,
      image: first(/<img[^>]*class="[^"]*cat-prod-row__foto[^"]*"[^>]*\bsrc="([^"]+)"/, t) ?? first(/data-original="([^"]+)"/, t),
      sellingMode: 'comparison',
    });
    if (limit && offers.length >= limit) break;
  }
  return { totalCount: offers.length || null, offers };
}

// ─── provider object ──────────────────────────────────────────────────────────

export const provider: Provider = {
  id: 'ceneo',
  reviewSorts: REVIEW_SORTS,
  fetchProduct,
  fetchReviews,
  fetchOffers,
  search,
  fetchCategory,
};
