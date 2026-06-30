// Normalized, store-agnostic data shapes that every provider maps into.
// Keep these stable — the CLI, formatters and skill all depend on them.

export type StoreId = 'allegro' | 'amazon' | 'ceneo';

export interface Price {
  /** Numeric amount in the store's currency, e.g. 1900 */
  amount: number | null;
  currency: string; // e.g. "PLN"
  /** Human string as the store shows it, e.g. "1 900,00 zł" */
  formatted: string;
}

/** A single product (a catalogue entry, possibly sold by many sellers). */
export interface Product {
  store: StoreId;
  productId: string; // store product id (Allegro: UUID)
  offerId: string | null; // the specific offer this view priced against, if any
  url: string;
  title: string;
  brand: string | null;
  gtin: string | null; // barcode / EAN
  image: string | null;
  price: Price | null;
  /** Long description / flattened spec text. */
  description: string | null;
  /** Structured spec parameters when available. */
  parameters: { name: string; value: string }[];
  rating: { value: number; count: number } | null;
}

/** A single user review / opinion of a product. */
export interface Review {
  id: string | null;
  author: string;
  rating: number | null; // normalized 1..5 when available
  text: string;
  pros: string;
  cons: string;
  images: string[];
  createdAt: string | null; // ISO
  helpfulCount?: number | null;
}

export interface ReviewsResult {
  store: StoreId;
  productId: string;
  rating: { value: number; count: number } | null;
  page: number;
  totalPages: number;
  totalCount: number;
  reviews: Review[];
}

/** One seller's offer for a product (offers view) or one listing tile (search). */
export interface Offer {
  store: StoreId;
  offerId: string;
  title: string;
  url: string;
  price: Price | null;
  /** Strikethrough / "was" price when discounted. */
  oldPrice: Price | null;
  seller: string | null;
  superSeller: boolean;
  freeDelivery: boolean | null;
  delivery: string | null; // human delivery summary / cost
  rating: { value: number; count: number } | null;
  soldCount: number | null;
  image: string | null;
  sellingMode: string | null; // buyNow | auction | advertisement
}

export interface ListingResult {
  store: StoreId;
  /** What produced this listing: a query, category url, or product offers. */
  kind: 'offers' | 'search' | 'category';
  query: string;
  totalCount: number | null;
  offers: Offer[];
}
