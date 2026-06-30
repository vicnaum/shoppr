// Amazon (amazon.pl) provider — HTML scraping (Amazon serves no clean JSON API
// like Allegro's opbox, and embeds no ld+json Product on .pl). Selectors are the
// brittle part; they're grouped here so a layout change is a one-file fix.
//
// Cookie story: product + search work logged-out. Full paginated reviews are
// login-gated (the /product-reviews/ page 302s to sign-in), so deep reviews need
// `shoppr auth --store amazon --from-chrome`. Without it we return the handful of
// reviews Amazon embeds in the product page.

import { fetchText } from '../http.js';
import { BotWallError } from '../http.js';
import type { Offer, Price, Product, Review, ReviewsResult, ListingResult } from '../types.js';
import type { ListOpts, Provider, ProviderCtx, ReviewOpts } from './provider.js';

const BASE = 'https://www.amazon.pl';
const ASIN_RE = /[A-Z0-9]{10}/;
const REVIEW_SORTS = ['helpful', 'recent'] as const;

// ─── html + money helpers ───────────────────────────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&nbsp;| /g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parseAmazonMoney(s: string): number | null {
  const cleaned = decodeEntities(s)
    .replace(/[^\d.,]/g, '') // drop "zł", spaces, nbsp
    .replace(/\.(?=\d{3}\b)/g, '') // thousands dot
    .replace(/\s/g, '')
    .replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function priceFrom(formatted?: string | null): Price | null {
  if (!formatted) return null;
  const f = decodeEntities(formatted).trim();
  const amount = parseAmazonMoney(f);
  if (amount === null) return null;
  return { amount, currency: 'PLN', formatted: f };
}

function first(re: RegExp, html: string): string | null {
  const m = html.match(re);
  return m ? m[1] : null;
}

/** Amazon shows a captcha / "Robot Check" instead of content when it suspects a bot. */
function assertNotBlocked(html: string): void {
  if (/Robot Check|api-services-support@amazon|Wprowadź znaki|To discuss automated access/i.test(html) && html.length < 60_000) {
    throw new BotWallError('amazon');
  }
}

// ─── input parsing ──────────────────────────────────────────────────────────

export function parseAsin(input: string): string | null {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    const m = url.pathname.match(/\/(?:dp|gp\/product|product-reviews)\/([A-Z0-9]{10})/i);
    if (m) return m[1].toUpperCase();
  } catch {
    if (/^[A-Z0-9]{10}$/i.test(trimmed)) return trimmed.toUpperCase();
  }
  const any = trimmed.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return any ? any[1].toUpperCase() : null;
}

async function get(url: string, ctx: ProviderCtx): Promise<string> {
  const opts = {
    store: 'amazon',
    proxy: ctx.proxy,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    headers: { Referer: `${BASE}/`, 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' },
    debug: ctx.debug,
  };
  try {
    const html = await fetchText(url, { ...opts, cookie: ctx.cookie });
    assertNotBlocked(html);
    return html;
  } catch (err) {
    // Amazon 400s on some cookie jars (oversized / analytics cookies it dislikes).
    // Product/search don't need a cookie, so degrade gracefully rather than fail.
    if (ctx.cookie && err instanceof Error && /HTTP 400/.test(err.message)) {
      if (ctx.debug) console.error('  [amazon] 400 with cookie — retrying without it');
      const html = await fetchText(url, { ...opts, cookie: undefined });
      assertNotBlocked(html);
      return html;
    }
    throw err;
  }
}

// ─── PRODUCT ────────────────────────────────────────────────────────────────

export async function fetchProduct(input: string, ctx: ProviderCtx): Promise<Product> {
  const asin = parseAsin(input);
  if (!asin) throw new Error('Could not find an Amazon ASIN in the input (expected a /dp/<ASIN> URL or bare ASIN).');
  const url = `${BASE}/dp/${asin}?language=pl_PL`;
  const html = await get(url, ctx);

  const title = first(/id="productTitle"[^>]*>([^<]+)</, html);
  const priceStr =
    first(/id="corePrice_feature_div"[\s\S]{0,400}?class="a-offscreen">([^<]+)</, html) ??
    first(/class="a-offscreen">([^<]+)</, html);
  const params = parseOverview(html);
  const brand =
    params.find((p) => /^marka$/i.test(p.name))?.value ??
    cleanByline(first(/id="bylineInfo"[^>]*>([\s\S]*?)<\/a>/, html));
  const ratingVal = first(/id="acrPopover"[^>]*title="([\d,]+)/, html) ?? first(/([\d,]+)\s*(?:z 5|na 5) gwiazdek/, html);
  const ratingCnt = first(/id="acrCustomerReviewText"[^>]*>([^<]+)</, html);
  const image = first(/data-old-hires="([^"]+)"/, html) ?? first(/id="landingImage"[^>]*\ssrc="([^"]+)"/, html);

  return {
    store: 'amazon',
    productId: asin,
    offerId: asin,
    url: `${BASE}/dp/${asin}`,
    title: title ? decodeEntities(title).trim() : '',
    brand: brand || null,
    gtin: params.find((p) => /ean|gtin|kod/i.test(p.name))?.value ?? null,
    image: image ? decodeEntities(image) : null,
    price: priceFrom(priceStr),
    description: parseFeatureBullets(html),
    parameters: params,
    rating:
      ratingVal != null
        ? { value: Number(ratingVal.replace(',', '.')), count: ratingCnt ? Number(ratingCnt.replace(/[^\d]/g, '')) : 0 }
        : null,
  };
}

function cleanByline(s: string | null): string | null {
  if (!s) return null;
  const t = stripTags(s).replace(/^(odwiedź sklep|visit the|brand:|marka:)\s*/i, '').replace(/\s*store$/i, '');
  return t && t.length < 60 ? t : null;
}

/** The "Informacje o produkcie" overview table: rows of {label, value}. */
function parseOverview(html: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  const table = html.match(/id="productOverview_feature_div"[\s\S]*?<\/table>/);
  const scope = table ? table[0] : html;
  const re = /<td[^>]*>\s*<span[^>]*>([^<]+)<\/span>\s*<\/td>\s*<td[^>]*>\s*<span[^>]*>([^<]+)<\/span>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) {
    const name = decodeEntities(m[1]).trim();
    const value = decodeEntities(m[2]).trim();
    const key = name.toLowerCase();
    if (!name || !value || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, value });
    if (out.length > 60) break;
  }
  return out;
}

function parseFeatureBullets(html: string): string | null {
  const fb = html.match(/id="feature-bullets"[\s\S]*?<\/ul>/);
  if (!fb) return null;
  const items = [...fb[0].matchAll(/class="a-list-item[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
    .map((m) => stripTags(m[1]))
    .filter((t) => t && t.length > 2);
  return items.length ? items.map((i) => `• ${i}`).join('\n') : null;
}

// ─── REVIEWS ──────────────────────────────────────────────────────────────────

export async function fetchReviews(input: string, opts: ReviewOpts, ctx: ProviderCtx): Promise<ReviewsResult> {
  const asin = parseAsin(input);
  if (!asin) throw new Error('Could not find an Amazon ASIN in the input.');
  const sort = opts.sort === 'recent' ? 'recent' : 'helpful';
  const limit = opts.limit ?? 0;

  const reviews: Review[] = [];
  let usedFallback = false;

  // Full reviews need login; try the dedicated page first (works with a cookie).
  let page = opts.page ?? 1;
  for (;;) {
    const url = `${BASE}/product-reviews/${asin}/?reviewerType=all_reviews&sortBy=${sort}&pageNumber=${page}&language=pl_PL`;
    let html: string;
    try {
      html = await get(url, ctx);
    } catch {
      break;
    }
    const batch = parseReviewBlocks(html);
    if (!batch.length) break;
    reviews.push(...batch);
    if (limit && reviews.length >= limit) break;
    if (opts.page) break;
    page += 1;
    if (page > 50) break;
  }

  // Logged-out / gated: fall back to the few reviews embedded on the product page.
  if (!reviews.length) {
    usedFallback = true;
    const html = await get(`${BASE}/dp/${asin}?language=pl_PL`, ctx);
    reviews.push(...parseReviewBlocks(html));
  }

  if (limit && reviews.length > limit) reviews.length = limit;

  // Aggregate rating from the product page acr widget.
  const dp = usedFallback ? null : await get(`${BASE}/dp/${asin}?language=pl_PL`, ctx).catch(() => null);
  const ratingVal = dp && first(/id="acrPopover"[^>]*title="([\d,]+)/, dp);
  const ratingCnt = dp && first(/id="acrCustomerReviewText"[^>]*>([^<]+)</, dp);

  return {
    store: 'amazon',
    productId: asin,
    rating: ratingVal ? { value: Number(ratingVal.replace(',', '.')), count: ratingCnt ? Number(String(ratingCnt).replace(/[^\d]/g, '')) : 0 } : null,
    page: opts.page ?? 1,
    totalPages: 0,
    totalCount: reviews.length,
    reviews,
  };
}

/** Strip Amazon's a11y/toggle boilerplate that wraps embedded review text. */
function cleanReviewText(raw: string | null): string {
  if (!raw) return '';
  return stripTags(raw)
    .replace(/Brief content visible, double tap to read full content\.?/gi, '')
    .replace(/Full content visible, double tap to read brief content\.?/gi, '')
    .replace(/\s*(?:Czytaj więcej|Czytaj mniej|Read more|Read less)\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseReviewBlocks(html: string): Review[] {
  const out: Review[] = [];
  // The dedicated /product-reviews/ page and the product page embed reviews with
  // different data-hooks, so we accept both naming schemes.
  const blocks = html.split(/data-hook="review"|data-hook="cmps-review"/).slice(1);
  for (const b of blocks) {
    const author = first(/class="a-profile-name">([^<]+)</, b);
    const star = first(/([\d,]+)\s*(?:z|na|out of)\s*5\s*(?:gwiazdek|stars)/, b);
    const title =
      first(/data-hook="(?:review-title|reviewTitle)"[^>]*>(?:[\s\S]*?<span[^>]*>)?\s*([^<]{2,})/, b);
    const bodyRaw =
      first(/data-hook="(?:review-body|reviewText|reviewTextContainer)"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/, b) ??
      first(/data-hook="reviewText"[^>]*>([\s\S]*?)<\/span>\s*<\/div>/, b);
    const date = first(/data-hook="review-date"[^>]*>([^<]+)</, b);
    if (!author && !bodyRaw) continue;
    out.push({
      id: null,
      author: author ? decodeEntities(author).trim() : 'anonim',
      rating: star ? Number(star.replace(',', '.')) : null,
      text: cleanReviewText(bodyRaw),
      pros: '',
      cons: '',
      images: [],
      createdAt: date ? decodeEntities(date).trim() : null,
    });
    if (out.length > 100) break;
  }
  return out;
}

// ─── OFFERS (all sellers via the AOD "all offers display" endpoint) ───────────

export async function fetchOffers(input: string, opts: ListOpts, ctx: ProviderCtx): Promise<ListingResult> {
  const asin = parseAsin(input);
  if (!asin) throw new Error('Could not find an Amazon ASIN in the input.');

  // AOD ("all offers display") — the same fragment the "Inni sprzedawcy" panel
  // loads. `aodAjaxMain` is a PATH segment (not a query param). No cookie needed.
  const aodUrl = `${BASE}/gp/product/ajax/aodAjaxMain/ref=dp_aod_NEW_mbc?asin=${asin}&m=&qid=&smid=&sr=&pc=dp&language=pl_PL`;
  const title = await productTitle(asin, ctx).catch(() => '');
  let html = '';
  try {
    html = await get(aodUrl, ctx);
  } catch {
    html = '';
  }

  let offers = parseAodOffers(html, asin, title);

  // Fallback: single-seller products (no AOD) → the buybox offer from the dp page.
  if (!offers.length) {
    const dp = await get(`${BASE}/dp/${asin}?language=pl_PL`, ctx);
    const priceStr = first(/class="a-offscreen">([^<]+)</, dp);
    const seller = first(/id="sellerProfileTriggerId"[^>]*>([^<]+)</, dp) ?? 'Amazon';
    if (priceStr) {
      offers = [
        {
          store: 'amazon',
          offerId: asin,
          title: title || asin,
          url: `${BASE}/dp/${asin}`,
          price: priceFrom(priceStr),
          oldPrice: null,
          seller: decodeEntities(seller).trim(),
          superSeller: false,
          freeDelivery: null,
          delivery: null,
          rating: null,
          soldCount: null,
          image: first(/data-old-hires="([^"]+)"/, dp),
          sellingMode: 'buyNow',
        },
      ];
    }
  }

  if (opts.limit) offers = offers.slice(0, opts.limit);
  return { store: 'amazon', kind: 'offers', query: input, totalCount: offers.length, offers };
}

async function productTitle(asin: string, ctx: ProviderCtx): Promise<string> {
  const dp = await get(`${BASE}/dp/${asin}?language=pl_PL`, ctx);
  const t = first(/id="productTitle"[^>]*>([^<]+)</, dp);
  return t ? decodeEntities(t).trim() : '';
}

/** Parse the AOD fragment: a pinned (buybox) offer + each "other seller" block. */
function parseAodOffers(html: string, asin: string, title: string): Offer[] {
  if (!html) return [];
  const blocks = html.split(/<div id="aod-(?:pinned-)?offer"/).slice(1);
  const out: Offer[] = [];
  const seen = new Set<string>();
  for (const b of blocks) {
    const priceBlock = b.slice(0, b.indexOf('id="aod-offer-soldBy"') + 1 || 4000);
    const whole = first(/a-price-whole">([\d\s.]+)/, priceBlock);
    const frac = first(/a-price-fraction">(\d+)/, priceBlock);
    let amount: number | null = null;
    if (whole) {
      amount = parseFloat(`${whole.replace(/[^\d]/g, '')}.${frac ?? '0'}`);
      if (!Number.isFinite(amount)) amount = null;
    }
    // Scope seller lookup to the soldBy sub-block so we don't grab a toggle link
    // ("Pokaż mniej") elsewhere in the offer. A third-party seller's link carries
    // `seller=<id>`; the buybox/pinned offer has none → it's sold by Amazon.
    const soldBy = (b.match(/id="aod-offer-soldBy"[\s\S]{0,1200}/) ?? [''])[0];
    const sellerId = first(/seller=([A-Z0-9]{6,})/, soldBy);
    const seller = sellerId ? first(/<a[^>]*aria-label="([^".]+)/, soldBy) ?? sellerId : 'Amazon';
    const shipsFrom = first(/id="aod-offer-shipsFrom"[\s\S]*?a-col-right[\s\S]*?<span[^>]*>\s*([^<]+?)\s*</, b);
    if (amount === null) continue;
    const key = `${sellerId ?? seller ?? ''}:${amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      store: 'amazon',
      offerId: sellerId ?? `${asin}-${out.length}`,
      title: title || asin,
      url: sellerId ? `${BASE}/gp/aag/main?seller=${sellerId}&asin=${asin}` : `${BASE}/dp/${asin}`,
      price: { amount, currency: 'PLN', formatted: formatMoney(amount) },
      oldPrice: null,
      seller: seller ? decodeEntities(seller).trim() : null,
      superSeller: false,
      freeDelivery: null,
      delivery: shipsFrom ? `ships from ${decodeEntities(shipsFrom).trim()}` : null,
      rating: null,
      soldCount: null,
      image: null,
      sellingMode: 'buyNow',
    });
  }
  // Cheapest-first, like the other providers' offers.
  return out.sort((a, b) => (a.price?.amount ?? Infinity) - (b.price?.amount ?? Infinity));
}

function formatMoney(n: number): string {
  return `${n.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;
}

// ─── SEARCH / CATEGORY ────────────────────────────────────────────────────────

export async function search(query: string, opts: ListOpts, ctx: ProviderCtx): Promise<ListingResult> {
  const params = new URLSearchParams({ k: query, language: 'pl_PL' });
  if (opts.category) params.set('i', opts.category);
  const html = await get(`${BASE}/s?${params.toString()}`, ctx);
  return { store: 'amazon', kind: 'search', query, ...parseSearchTiles(html, opts.limit) };
}

export async function fetchCategory(input: string, opts: ListOpts, ctx: ProviderCtx): Promise<ListingResult> {
  const url = /^https?:\/\//.test(input) ? input : `${BASE}/${input.replace(/^\/+/, '')}`;
  const html = await get(url, ctx);
  return { store: 'amazon', kind: 'category', query: input, ...parseSearchTiles(html, opts.limit) };
}

function parseSearchTiles(html: string, limit?: number): { totalCount: number | null; offers: Offer[] } {
  const offers: Offer[] = [];
  const seen = new Set<string>();
  const blocks = html.split('data-asin="').slice(1);
  for (const b of blocks) {
    const asin = (b.match(/^([A-Z0-9]{10})"/) ?? [])[1];
    if (!asin || seen.has(asin)) continue;
    const title =
      first(/<h2[^>]*>[\s\S]*?<span[^>]*>([^<]{5,})<\/span>/, b) ?? first(/class="a-text-normal"[^>]*>([^<]{5,})</, b);
    const priceStr = first(/class="a-offscreen">([^<]+)</, b);
    if (!title || !priceStr) continue; // skip ad/empty tiles
    seen.add(asin);
    const ratingVal = first(/([\d,]+)\s*(?:z 5|na 5|out of)/, b);
    const ratingCnt = first(/aria-label="([\d\s. ]+)"[^>]*>\s*<span[^>]*class="[^"]*a-size-base/, b);
    offers.push({
      store: 'amazon',
      offerId: asin,
      title: decodeEntities(title).trim(),
      url: `${BASE}/dp/${asin}`,
      price: priceFrom(priceStr),
      oldPrice: null,
      seller: null,
      superSeller: false,
      freeDelivery: null,
      delivery: null,
      rating: ratingVal ? { value: Number(ratingVal.replace(',', '.')), count: ratingCnt ? Number(ratingCnt.replace(/[^\d]/g, '')) : 0 } : null,
      soldCount: null,
      image: first(/<img[^>]*class="s-image"[^>]*src="([^"]+)"/, b),
      sellingMode: 'buyNow',
    });
    if (limit && offers.length >= limit) break;
  }
  return { totalCount: offers.length || null, offers };
}

// ─── provider object ──────────────────────────────────────────────────────────

export const provider: Provider = {
  id: 'amazon',
  reviewSorts: REVIEW_SORTS,
  fetchProduct,
  fetchReviews,
  fetchOffers,
  search,
  fetchCategory,
};
