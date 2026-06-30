// Allegro provider — scrapes Allegro.pl's own JSON/HTML (no official API).
//
// Endpoints used (all reverse-engineered from the live site):
//  - Product detail:  GET allegro.pl/produkt/<slug|uuid>      (HTML; ld+json + opbox price)
//  - Reviews:         GET edge.allegro.pl/product-reviews      (clean public JSON, no cookie)
//  - Offers/sellers:  GET allegro.pl/oferty-produktu/<slug|uuid> (opbox JSON listing)
//  - Search:          GET allegro.pl/listing?string=<q>         (opbox JSON listing)
//  - Category:        GET allegro.pl/kategoria/<slug>           (opbox JSON listing)
//
// Product/offers/search/category sit behind DataDome and need a session cookie;
// reviews do not. Cookies come from the user's HAR via `shoppr auth`.

import type { ResolvedProxy } from '../config.js';
import { fetchText, fetchJson } from '../http.js';
import type { Offer, Price, Product, Review, ReviewsResult, ListingResult } from '../types.js';
import { parseAllegroTarget, type ParsedTarget } from '../utils/input-parser.js';
import type { Provider } from './provider.js';

const BASE = 'https://allegro.pl';
const EDGE = 'https://edge.allegro.pl';

export interface AllegroCtx {
  cookie?: string;
  proxy?: ResolvedProxy;
  debug?: boolean;
}

const REVIEW_SORTS = ['MINE_THEN_MOST_HELPFUL', 'MOST_HELPFUL', 'NEWEST', 'OLDEST', 'HIGHEST_SCORE', 'LOWEST_SCORE'] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

// ─── money helpers ──────────────────────────────────────────────────────────

const CURRENCY_SYMBOL: Record<string, string> = { 'zł': 'PLN', zl: 'PLN' };

/** Parse a Polish-formatted money string like "1 900,00 zł" → 1900.0 */
function parsePolishMoney(s: string): number | null {
  const cleaned = s
    .replace(/ /g, ' ')
    .replace(/[a-ząćęłńóśźż.]+$/i, '') // strip trailing "zł"
    .replace(/\s/g, '')
    .replace(',', '.')
    .trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function priceFromAmount(amount?: string | number | null, currency = 'PLN'): Price | null {
  if (amount === undefined || amount === null || amount === '') return null;
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount));
  if (!Number.isFinite(n)) return null;
  return { amount: n, currency, formatted: formatMoney(n, currency) };
}

function formatMoney(n: number, currency: string): string {
  const body = n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'PLN' ? `${body} zł` : `${body} ${currency}`;
}

const truthy = (v: unknown): boolean => v === true || v === 'True' || v === 'true';

// ─── PRODUCT DETAIL ─────────────────────────────────────────────────────────

/** Build a product page URL from a parsed target (uses slug if known, else uuid). */
function productUrl(t: ParsedTarget): string {
  if (t.url && /\/produkt\//.test(t.url.pathname)) return t.url.toString();
  const seg = t.slug ?? t.productId;
  if (!seg) throw new Error('Cannot build Allegro product URL: need a URL, slug, or product UUID.');
  return `${BASE}/produkt/${seg}`;
}

export async function fetchProduct(input: string, ctx: AllegroCtx): Promise<Product> {
  const t = parseAllegroTarget(input);
  const url = productUrl(t);
  const html = await fetchText(url, {
    store: 'allegro',
    cookie: ctx.cookie,
    proxy: ctx.proxy,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    headers: { Referer: `${BASE}/` },
    debug: ctx.debug,
  });

  const ld = extractLdProduct(html);
  const price = extractBuyboxPrice(html);
  const productId = t.productId ?? extractUuid(html) ?? '';
  const offerId = t.offerId ?? extractOfferIdFromLd(ld) ?? null;

  return {
    store: 'allegro',
    productId,
    offerId,
    url: ld?.url ?? url,
    title: ld?.name ?? extractTitle(html) ?? '',
    brand: ld?.brand ?? null,
    gtin: ld?.gtin ?? null,
    image: typeof ld?.image === 'string' ? ld.image : Array.isArray(ld?.image) ? ld.image[0] : null,
    price,
    description: ld?.description ?? null,
    parameters: extractParameters(html),
    rating: ld?.aggregateRating
      ? { value: Number(ld.aggregateRating.ratingValue), count: Number(ld.aggregateRating.ratingCount) }
      : null,
  };
}

function extractLdProduct(html: string): any | null {
  const blocks = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? [];
  for (const block of blocks) {
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

function extractOfferIdFromLd(ld: any | null): string | null {
  if (!ld) return null;
  if (ld.sku && /^\d+$/.test(String(ld.sku))) return String(ld.sku);
  const m = typeof ld.url === 'string' ? ld.url.match(/offerId=(\d+)/) : null;
  return m ? m[1] : null;
}

/** The buybox main price is the first `formattedPrice` in the rendered page. */
function extractBuyboxPrice(html: string): Price | null {
  const m = html.match(/"formattedPrice":"([^"]+)"/);
  if (!m) return null;
  const formatted = m[1].replace(/\\u00a0/g, ' ');
  const amount = parsePolishMoney(formatted);
  const currency = /zł/.test(formatted) ? 'PLN' : 'PLN';
  return { amount, currency, formatted };
}

function extractUuid(html: string): string | null {
  const m = html.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0].toLowerCase() : null;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title>([^<]*)<\/title>/);
  return m ? m[1].replace(/\s*•.*$/, '').trim() : null;
}

/** Extract structured spec parameters from the embedded opbox JSON. Each looks
 * like {"id","name":"Producent","values":[{"valueLabel":"Seagate",...}]}. We take
 * the first valueLabel per parameter (covers the vast majority of specs) and dedupe
 * by name. Far cleaner than splitting the flattened ld+json description. */
function extractParameters(html: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  const re = /"name":"([^"]+)","values":\[\{[^}]*?"valueLabel":"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const name = decodeJsonUnicode(m[1]).trim();
    const value = decodeJsonUnicode(m[2]).trim();
    const key = name.toLowerCase();
    if (!name || !value || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, value });
    if (out.length > 100) break;
  }
  return out;
}

/** Decode ó-style escapes that survive in raw HTML-embedded JSON strings. */
function decodeJsonUnicode(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/');
}

// ─── REVIEWS (clean public API, no cookie) ──────────────────────────────────

export async function fetchReviews(
  input: string,
  opts: { page?: number; sort?: ReviewSort; limit?: number },
  ctx: AllegroCtx,
): Promise<ReviewsResult> {
  const t = parseAllegroTarget(input);
  const productId = t.productId;
  if (!productId) {
    throw new Error('Allegro reviews need a product UUID (pass a /produkt/ URL or the bare UUID).');
  }
  const sort = opts.sort ?? 'MOST_HELPFUL';
  const limit = opts.limit ?? 0; // 0 = all pages

  const all: Review[] = [];
  let page = opts.page ?? 1;
  let totalPages = 1;
  let totalCount = 0;
  let rating: { value: number; count: number } | null = null;

  while (true) {
    const url = `${EDGE}/product-reviews?productId=${encodeURIComponent(productId)}&page=${page}&sortBy=${sort}`;
    const data = await fetchJson<any>(url, {
      store: 'allegro',
      cookie: ctx.cookie, // optional; reviews work without it
      proxy: ctx.proxy,
      accept: 'application/vnd.allegro.public.v2+json',
      headers: { 'Content-Type': 'application/vnd.allegro.public.v2+json', Referer: `${BASE}/` },
      debug: ctx.debug,
    });

    totalCount = data.count ?? totalCount;
    totalPages = data.pagination?.totalPages ?? totalPages;
    if (data.rating?.average != null) rating = { value: Number(data.rating.average), count: totalCount };

    for (const o of data.opinions ?? []) all.push(mapOpinion(o));

    if (limit && all.length >= limit) {
      all.length = limit;
      break;
    }
    if (opts.page) break; // single explicit page requested
    if (page >= totalPages) break;
    page += 1;
  }

  return {
    store: 'allegro',
    productId,
    rating,
    page: opts.page ?? 1,
    totalPages,
    totalCount,
    reviews: all,
  };
}

function mapOpinion(o: any): Review {
  return {
    id: o.id ?? null,
    author: o.author?.name ?? 'anonim',
    rating: o.rating?.label != null ? Number(o.rating.label) : null,
    text: o.opinion ?? '',
    pros: o.pros ?? '',
    cons: o.cons ?? '',
    images: Array.isArray(o.images) ? o.images.map((i: any) => i.url).filter(Boolean) : [],
    createdAt: o.createdAt ?? null,
    helpfulCount: o.helpful?.count ?? null,
  };
}

// ─── LISTINGS: offers / search / category ───────────────────────────────────

/** Find the offer-tile array inside any opbox listing JSON (key names vary). */
function extractElements(data: any): any[] {
  let best: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const els = node?.items?.elements;
    if (Array.isArray(els) && els.length) {
      const looksLikeOffers = els.some((e) => e && (e.sellingMode || (e.id && e.name && e.url)));
      if (looksLikeOffers && els.length > best.length) best = els;
    }
    for (const v of Object.values(node)) visit(v);
  };
  visit(data);
  return best;
}

function mapElement(e: any): Offer | null {
  if (!e || (!e.id && !e.name)) return null;
  const sm = e.sellingMode ?? {};
  const buy = sm.buyNow ?? sm.advertisement ?? sm.auction ?? {};
  const price = buy.price ? priceFromAmount(buy.price.amount, buy.price.currency) : null;

  // Strikethrough "old" price lives in badges.discount label parts.
  let oldPrice: Price | null = null;
  const discountLabels = e.badges?.discount?.labels ?? [];
  for (const lbl of discountLabels) {
    for (const part of lbl.labelParts ?? []) {
      if (part?.style?.textAttributes?.strikethrough && part.text) {
        oldPrice = { amount: parsePolishMoney(part.text), currency: 'PLN', formatted: part.text };
      }
    }
  }

  const seller = e.seller ?? {};
  const shipping = e.shipping ?? {};
  const rev = e.productReview?.rating;

  return {
    store: 'allegro',
    offerId: String(e.id ?? ''),
    title: e.name ?? '',
    url: e.url ?? '',
    price,
    oldPrice,
    seller: seller.login ?? seller.title ?? null,
    superSeller: truthy(seller.superSeller),
    freeDelivery: shipping.freeDelivery !== undefined ? truthy(shipping.freeDelivery) : null,
    delivery: shipping.lowest ? formatMoney(parseFloat(shipping.lowest.amount), shipping.lowest.currency ?? 'PLN') : null,
    rating: rev?.average != null ? { value: Number(rev.average), count: Number(rev.count ?? 0) } : null,
    soldCount: e.popularity != null ? Number(e.popularity) : buy.popularity != null ? Number(buy.popularity) : null,
    image: e.mainThumbnail ?? (Array.isArray(e.photos) && e.photos[0]?.url) ?? null,
    sellingMode: sm.buyNow ? 'buyNow' : sm.auction ? 'auction' : sm.advertisement ? 'advertisement' : null,
  };
}

async function fetchListingJson(url: string, ctx: AllegroCtx): Promise<any> {
  return fetchJson<any>(url, {
    store: 'allegro',
    cookie: ctx.cookie,
    proxy: ctx.proxy,
    accept: 'application/json',
    headers: { Referer: `${BASE}/` },
    debug: ctx.debug,
  });
}

export async function fetchOffers(input: string, opts: { limit?: number }, ctx: AllegroCtx): Promise<ListingResult> {
  const t = parseAllegroTarget(input);
  let url: string;
  if (t.url && /\/(produkt|oferty-produktu)\//.test(t.url.pathname)) {
    url = t.url.toString().replace('/produkt/', '/oferty-produktu/');
  } else {
    const seg = t.slug ?? t.productId;
    if (!seg) throw new Error('Allegro offers need a product URL, slug, or UUID.');
    url = `${BASE}/oferty-produktu/${seg}`;
  }
  const data = await fetchListingJson(url, ctx);
  return toListing(data, 'offers', input, opts.limit);
}

export async function search(query: string, opts: { limit?: number; category?: string }, ctx: AllegroCtx): Promise<ListingResult> {
  const params = new URLSearchParams({ string: query });
  if (opts.category) params.set('category_id', opts.category);
  const url = `${BASE}/listing?${params.toString()}`;
  const data = await fetchListingJson(url, ctx);
  return toListing(data, 'search', query, opts.limit);
}

export async function fetchCategory(input: string, opts: { limit?: number }, ctx: AllegroCtx): Promise<ListingResult> {
  const url = /^https?:\/\//.test(input) ? input : `${BASE}/kategoria/${input.replace(/^\/+/, '')}`;
  const data = await fetchListingJson(url, ctx);
  return toListing(data, 'category', input, opts.limit);
}

function toListing(data: any, kind: 'offers' | 'search' | 'category', query: string, limit?: number): ListingResult {
  const elements = extractElements(data);
  let offers = elements
    .map(mapElement)
    .filter((o): o is Offer => o !== null && o.title !== '' && (o.price !== null || o.sellingMode !== null));
  if (limit && offers.length > limit) offers = offers.slice(0, limit);
  return {
    store: 'allegro',
    kind,
    query,
    totalCount: elements.length || null,
    offers,
  };
}

export { REVIEW_SORTS };

export const provider: Provider = {
  id: 'allegro',
  reviewSorts: REVIEW_SORTS,
  fetchProduct,
  fetchReviews: (input, opts, ctx) => fetchReviews(input, opts as { sort?: ReviewSort; page?: number; limit?: number }, ctx),
  fetchOffers,
  search,
  fetchCategory,
};
