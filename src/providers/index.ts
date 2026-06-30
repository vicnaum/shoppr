// Provider registry. Add a store here + a module and the CLI picks it up.
// Detection is by URL host (see utils/input-parser detectStore); the default
// store is used for bare ids/queries with no URL.

import type { StoreId } from '../types.js';
import type { Provider } from './provider.js';
import { provider as allegro } from './allegro.js';
import { provider as amazon } from './amazon.js';
import { provider as ceneo } from './ceneo.js';

const PROVIDERS: Record<StoreId, Provider> = {
  allegro,
  amazon,
  ceneo,
};

export const STORES: StoreId[] = Object.keys(PROVIDERS) as StoreId[];
export const DEFAULT_STORE: StoreId = 'allegro';

/** host_key suffixes used to pull a store's cookies out of the browser store. */
export const STORE_COOKIE_DOMAINS: Record<StoreId, string[]> = {
  allegro: ['allegro.pl', 'allegro.com'],
  amazon: ['amazon.pl', 'amazon.com', 'amazon.de'],
  ceneo: ['ceneo.pl'],
};

export function isStore(s: string): s is StoreId {
  return (STORES as string[]).includes(s);
}

export function getProvider(store: StoreId): Provider {
  return PROVIDERS[store];
}

export type { Provider } from './provider.js';
