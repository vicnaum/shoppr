// Smart input parsing: turn whatever the user pastes (a full URL, a bare product
// UUID, an offer id, a slug) into a normalized target a provider can act on.
// Also detects which store a URL belongs to.

import type { StoreId } from '../types.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface ParsedTarget {
  store: StoreId | null;
  /** product UUID for Allegro, when determinable */
  productId: string | null;
  /** numeric offer id, when present (?offerId= or /oferta/) */
  offerId: string | null;
  /** the full product/offer slug (path after /produkt/ or /oferty-produktu/) */
  slug: string | null;
  /** original input echoed back */
  raw: string;
  /** if the input was a full URL, its parsed form */
  url: URL | null;
}

/** Detect the store from a URL host. Returns null if unknown. */
export function detectStore(input: string): StoreId | null {
  const host = safeHost(input);
  if (!host) return null;
  if (host.endsWith('allegro.pl') || host.endsWith('allegro.com')) return 'allegro';
  if (/(^|\.)amazon\.(pl|com|de|co\.uk|fr|it|es)$/.test(host)) return 'amazon';
  if (host.endsWith('ceneo.pl')) return 'ceneo';
  return null;
}

function safeHost(input: string): string | null {
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Parse an Allegro product/offer input. Accepts:
 *  - https://allegro.pl/produkt/<slug>-<uuid>?offerId=123
 *  - https://allegro.pl/oferty-produktu/<slug>-<uuid>
 *  - https://allegro.pl/oferta/<slug>-<numericOfferId>
 *  - a bare product UUID
 *  - a bare numeric offer id
 */
export function parseAllegroTarget(input: string): ParsedTarget {
  const out: ParsedTarget = {
    store: 'allegro',
    productId: null,
    offerId: null,
    slug: null,
    raw: input,
    url: null,
  };

  const trimmed = input.trim();
  let url: URL | null = null;
  try {
    url = new URL(trimmed);
  } catch {
    // Not a URL — maybe a bare id.
    const uuid = trimmed.match(UUID_RE);
    if (uuid) {
      out.productId = uuid[0].toLowerCase();
      return out;
    }
    if (/^\d{6,}$/.test(trimmed)) {
      out.offerId = trimmed;
      return out;
    }
    // Fall through: treat as a slug.
    out.slug = trimmed.replace(/^\/+/, '');
    return out;
  }

  out.url = url;
  const uuid = url.pathname.match(UUID_RE);
  if (uuid) out.productId = uuid[0].toLowerCase();

  const qOffer = url.searchParams.get('offerId');
  if (qOffer && /^\d+$/.test(qOffer)) out.offerId = qOffer;

  // /produkt/<slug> or /oferty-produktu/<slug>
  const m = url.pathname.match(/\/(?:produkt|oferty-produktu)\/([^/?#]+)/);
  if (m) out.slug = m[1];

  // /oferta/<slug>-<numericId> — the slug here names the offer, not the product,
  // so it must not be reused as a /produkt/ or /oferty-produktu/ segment.
  const off = url.pathname.match(/\/oferta\/(?:.*-)?(\d{6,})$/);
  if (off) out.offerId = off[1];

  return out;
}
