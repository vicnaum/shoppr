// Output formatters: every result type renders to JSON (for analysis) and
// Markdown (for humans). Mirrors the reddx/twx formatter split.

import type { ListingResult, Offer, Product, ReviewsResult } from './types.js';

export function toJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function priceStr(p: { formatted: string } | null): string {
  return p?.formatted ?? '—';
}

// ─── Product ────────────────────────────────────────────────────────────────

export function productToMarkdown(p: Product): string {
  const lines: string[] = [];
  lines.push(`# ${p.title || '(no title)'}`);
  lines.push('');
  const meta: string[] = [];
  if (p.price) meta.push(`**Price:** ${priceStr(p.price)}`);
  if (p.rating) meta.push(`**Rating:** ${p.rating.value} ★ (${p.rating.count})`);
  if (p.brand) meta.push(`**Brand:** ${p.brand}`);
  if (p.gtin) meta.push(`**GTIN:** ${p.gtin}`);
  if (meta.length) lines.push(meta.join('  ·  '));
  lines.push('');
  lines.push(`- Store: ${p.store}`);
  lines.push(`- Product ID: ${p.productId || '—'}`);
  if (p.offerId) lines.push(`- Offer ID: ${p.offerId}`);
  lines.push(`- URL: ${p.url}`);
  if (p.image) lines.push(`- Image: ${p.image}`);
  if (p.parameters.length) {
    lines.push('');
    lines.push('## Parameters');
    for (const param of p.parameters) lines.push(`- **${param.name}:** ${param.value}`);
  }
  if (p.description) {
    lines.push('');
    lines.push('## Description');
    lines.push(p.description);
  }
  return lines.join('\n') + '\n';
}

// ─── Reviews ──────────────────────────────────────────────────────────────────

export function reviewsToMarkdown(r: ReviewsResult): string {
  const lines: string[] = [];
  const head = r.rating ? ` — ${r.rating.value} ★ (${r.rating.count})` : '';
  lines.push(`# Reviews: ${r.productId}${head}`);
  lines.push('');
  lines.push(`${r.reviews.length} of ${r.totalCount} opinion(s), ${r.totalPages} page(s).`);
  lines.push('');
  for (const rev of r.reviews) {
    const stars = rev.rating != null ? '★'.repeat(rev.rating) + '☆'.repeat(Math.max(0, 5 - rev.rating)) : '';
    // ISO dates → just the day; store-specific strings (e.g. Amazon's "Zrecenzowano…") → as-is.
    const date = rev.createdAt ? (/^\d{4}-\d{2}-\d{2}/.test(rev.createdAt) ? rev.createdAt.slice(0, 10) : rev.createdAt) : '';
    lines.push(`### ${stars} ${rev.author}${date ? ` · ${date}` : ''}`);
    if (rev.text) lines.push(rev.text);
    if (rev.pros) lines.push(`**+** ${rev.pros}`);
    if (rev.cons) lines.push(`**−** ${rev.cons}`);
    if (rev.images.length) lines.push(`_${rev.images.length} image(s)_`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// ─── Listing (offers / search / category) ─────────────────────────────────────

export function listingToMarkdown(l: ListingResult): string {
  const lines: string[] = [];
  const title =
    l.kind === 'offers' ? `Offers for ${l.query}` : l.kind === 'search' ? `Search: ${l.query}` : `Category: ${l.query}`;
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`${l.offers.length} result(s).`);
  lines.push('');
  lines.push('| Price | Old | Seller | Rating | Delivery | Title |');
  lines.push('|---|---|---|---|---|---|');
  for (const o of l.offers) lines.push(offerRow(o));
  lines.push('');
  lines.push('## Links');
  for (const o of l.offers) lines.push(`- [${truncate(o.title, 70)}](${o.url}) — ${priceStr(o.price)}`);
  return lines.join('\n') + '\n';
}

function offerRow(o: Offer): string {
  const seller = `${o.seller ?? '—'}${o.superSeller ? ' ⭐' : ''}`;
  const rating = o.rating ? `${o.rating.value} (${o.rating.count})` : '—';
  const delivery = o.freeDelivery ? 'free' : o.delivery ?? '—';
  return `| ${priceStr(o.price)} | ${o.oldPrice ? priceStr(o.oldPrice) : ''} | ${seller} | ${rating} | ${delivery} | ${truncate(o.title, 60)} |`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
