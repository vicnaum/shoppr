// The contract every store provider implements. The CLI dispatches purely
// through this interface, so adding a store = drop in a module + register it.

import type { ResolvedProxy } from '../config.js';
import type { ListingResult, Product, ReviewsResult, StoreId } from '../types.js';

export interface ProviderCtx {
  cookie?: string;
  proxy?: ResolvedProxy;
  debug?: boolean;
}

export interface ReviewOpts {
  page?: number;
  sort?: string;
  limit?: number;
}

export interface ListOpts {
  limit?: number;
  category?: string;
}

export interface Provider {
  id: StoreId;
  /** Valid `--sort` values for reviews (store-specific). */
  reviewSorts: readonly string[];
  fetchProduct(input: string, ctx: ProviderCtx): Promise<Product>;
  fetchReviews(input: string, opts: ReviewOpts, ctx: ProviderCtx): Promise<ReviewsResult>;
  fetchOffers(input: string, opts: ListOpts, ctx: ProviderCtx): Promise<ListingResult>;
  search(query: string, opts: ListOpts, ctx: ProviderCtx): Promise<ListingResult>;
  fetchCategory(input: string, opts: ListOpts, ctx: ProviderCtx): Promise<ListingResult>;
}
