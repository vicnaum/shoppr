---
name: shoppr
description: "Fetch and analyze online-shopping data using the shoppr CLI tool, across stores (Allegro, Amazon, Ceneo). Use when the user wants to: (1) Check a product's price, description, brand, GTIN, or specs, (2) Read a product's reviews/opinions and rating, (3) Compare all sellers/offers (and prices) for one product, (4) Search a store or browse a category, (5) Research or price-track items on Allegro, Amazon, or Ceneo. Triggers on mentions of Allegro, allegro.pl, Amazon, amazon.pl, ASIN, Ceneo, ceneo.pl, product prices, price comparison, shopping, reviews/opinie, sellers/offers, /produkt/, /dp/ or /oferta/ URLs, or comparing online-store prices."
---

# shoppr — Shopping Data Extraction

Globally installed CLI that fetches product details, prices, reviews, seller offers, and search/category listings from online stores. Mirrors the `reddx`/`twx` interface (global `-p`, per-command `-f`/`-o`, smart input parsing, json/md formatters). **Multi-store** — the store **auto-detects from the URL host** (`-s/--store` to force it, required for bare ids like an ASIN or a UUID).

It scrapes each store's **own** JSON/HTML (no official API). Per-store cookie nuances:

| Store | Product | Search / Category | Reviews | Offers | Cookie |
|---|---|---|---|---|---|
| **allegro** | ✅ | ✅ | ✅ | ✅ all sellers | product/offers/search need the `datadome` cookie; reviews need none |
| **amazon** (amazon.pl) | ✅ | ✅ | ⚠️ top-N logged-out, full with login | ✅ all sellers | product/search/offers need none; full paginated reviews need a logged-in cookie |
| **ceneo** (ceneo.pl) | ✅ | ✅ | ✅ | ✅ **all shops** (cheapest-first) | none for anything |

Key facts:
- **Allegro** product/offers/search/category sit behind **DataDome** — they need a session **cookie** (the `datadome` cookie). Without it you get a clear "blocked by bot protection — refresh your cookie" error. The cookie also yields correct delivery prices. Allegro reviews need no login.
- **Amazon** is HTML-scraped (no clean JSON, brittler selectors) and can show a "Robot Check" captcha. Product + search + **offers** work logged-out. Offers uses the AOD ("all offers display") endpoint → **every seller** for a product, cheapest-first. Only ~8 reviews are embedded per product page when logged-out; the full `/product-reviews/` pages are login-gated, so deep reviews need `shoppr auth --store amazon --from-chrome`.
- **Ceneo** is a price-comparison engine and the best fit for "all sellers": **no cookie needed** for anything. Product pages carry an `ld+json` Product (rating + AggregateOffer low/high/count); `offers` lists **every shop, cheapest-first** (the headline product `price` is the lowest offer, i.e. "od"). HTML-scraped, so selectors can drift. Product ids are numeric; reviews + offers all work logged-out.
- Cookies are auto-sanitized on save (tracking cookies like `s_sq`/`AMCV_*`/`_meta_*` are dropped — they break Amazon and help nothing).

## Setup Check

```bash
shoppr auth          # shows config: which stores have a cookie, proxy status
```

If `shoppr` is not found, install it:

```bash
git clone https://github.com/vicnaum/shoppr.git
cd shoppr && pnpm install && pnpm build && npm link
```

### Configure a store cookie (one-time, refresh when it expires)

The cookie comes from the user's browser session. **Preferred: read it straight from Chrome** (macOS) — no manual export. The user just needs to have visited the store in Chrome (for Amazon, be *logged in* if you want full reviews):

```bash
shoppr auth --store allegro --from-chrome
shoppr auth --store amazon  --from-chrome
```

This reads and decrypts Chrome's cookie store (may trigger a one-time macOS Keychain approval prompt). Flags: `--browser chrome|brave|edge` (default chrome), `--profile "<name>"` (default `Default`, e.g. `"Profile 1"`). When an Allegro command later fails with a DataDome / bot-wall error, just re-run the same command to refresh.

Alternatives:

```bash
# From a HAR export (DevTools → Network → "Save all as HAR"):
shoppr auth --store allegro --har /path/to/allegro.pl.har
# Or paste a Cookie header directly:
shoppr auth --store allegro --cookie "datadome=...; QXLSESSID=..."
```

(Stored in `~/.config/shoppr/.env` as `ALLEGRO_COOKIE`.) The `datadome` cookie is the bot-wall gate; it's non-HttpOnly and lasts ~1 year, so refreshes are rare.

Optional proxy (shared across stores): `shoppr auth --proxy http://user:pass@host:port`.

## Running Commands

Use `-f json` for analysis tasks (structured data) and `-f md` for human-readable output. Use `-o /tmp/shoppr` (or another temp dir) to avoid polluting the project directory. Add **`-p`** before the command to print to stdout instead of writing files. Add `--debug` for verbose HTTP logging.

```bash
shoppr -p product <url> -f md
shoppr -p reviews <url> --limit 20 -f json
```

### Input formats

**Allegro:**
- **Product URL:** `https://allegro.pl/produkt/<slug>-<uuid>?offerId=<n>`
- **Bare product UUID:** `5ccf08d3-ec72-4f3b-a1b6-cd8b8545a819` (redirects resolve the slug)
- **Offers URL:** a `/oferty-produktu/<slug>` URL, or any product URL (auto-converted)
- **Category:** a `/kategoria/<slug>` URL or the bare slug

**Amazon:**
- **Product URL:** `https://www.amazon.pl/dp/<ASIN>` (also `/gp/product/<ASIN>`)
- **Bare ASIN:** `B0B7CKVCCV` — needs `-s amazon` (a 10-char ASIN can't be auto-detected)

**Ceneo:**
- **Product URL:** `https://www.ceneo.pl/<id>` (numeric, e.g. `110606242`; `/opinie` suffix is fine)
- **Bare id:** `110606242` — needs `-s ceneo`

Store auto-detects from any URL host. For **bare ids/queries** it defaults to `allegro`, so pass `-s amazon` / `-s ceneo` when using a bare ASIN/id or searching those stores.

### Fetch Product Details

```bash
shoppr product "https://allegro.pl/produkt/...-5ccf08d3-ec72-4f3b-a1b6-cd8b8545a819" -f json -o /tmp/shoppr
shoppr product 5ccf08d3-ec72-4f3b-a1b6-cd8b8545a819 -f md -o /tmp/shoppr
shoppr product "https://www.amazon.pl/dp/B0B7CKVCCV" -f md -o /tmp/shoppr   # amazon
```

Returns: title, price, brand, GTIN/EAN, image, aggregate rating, structured `parameters` (specs), and the full description. (Allegro needs its cookie; Amazon doesn't.)

```json
{"store":"allegro","productId":"...","offerId":"...","url":"...","title":"...","brand":"Seagate","gtin":"5704174046875","price":{"amount":1900,"currency":"PLN","formatted":"1900,00 zł"},"parameters":[{"name":"Pojemność dysku","value":"16TB"}],"rating":{"value":4.69,"count":98}}
```

### Fetch Reviews / Opinions

```bash
shoppr reviews <url|uuid> --limit 50 -f json -o /tmp/shoppr
shoppr reviews <url|uuid> --sort NEWEST --page 1 -f md -o /tmp/shoppr
```

Flags: `-l/--limit <n>` (0 = all pages, default 0), `--page <n>` (fetch only that page), `--sort` (store-specific). Each review has `rating` (1–5), `text`, `pros`, `cons`, `images`, `createdAt`.
- **Allegro** `--sort`: `MOST_HELPFUL` (default), `NEWEST`, `OLDEST`, `HIGHEST_SCORE`, `LOWEST_SCORE`, `MINE_THEN_MOST_HELPFUL`. No cookie required. Needs a product **UUID** (a `/produkt/` URL or bare UUID, not an offer id).
- **Amazon** (`-s amazon`) `--sort`: `helpful` (default), `recent`. Logged-out returns only the ~8 reviews embedded on the product page; for full paginated reviews run `shoppr auth --store amazon --from-chrome` while logged in. Takes a `/dp/<ASIN>` URL or bare ASIN.

### Fetch Offers / Sellers (price comparison)

```bash
shoppr offers <product-url|uuid> --limit 30 -f json -o /tmp/shoppr
```

**All three** return every seller's offer for one product (`price`, `seller`, `url`, …), cheapest-first. Allegro needs its cookie; **Ceneo** and **Amazon** need none (Amazon uses the AOD all-offers endpoint).

### Search / Category

```bash
shoppr search "seagate exos 16tb" --limit 20 -f json -o /tmp/shoppr            # allegro (default)
shoppr search "ssd 2tb nvme" -s amazon --limit 20 -f md -o /tmp/shoppr          # amazon
shoppr category "https://allegro.pl/kategoria/dyski-hdd-4476" --limit 40 -f json -o /tmp/shoppr
```

Both return a listing of offer tiles in the same shape as `offers`. (Allegro needs the cookie; Amazon search works logged-out.)

## Analysis Workflow

1. Fetch with `-f json` into `-o /tmp/shoppr`.
2. Read the JSON output file(s) to analyze prices/specs/reviews.
3. Present findings to the user (e.g. cheapest seller, rating summary, common complaints).

Output filenames: `<title>_product.json`, `<uuid>_reviews.json`, `<input>_offers.json`, `search_<query>.json`, `category_<slug>.json`.

## Error Handling

- **"blocked by bot protection (DataDome)"** (allegro): the cookie is missing/expired. Refresh with `shoppr auth --store allegro --from-chrome` (or a fresh HAR).
- **"blocked by bot protection" (amazon)**: Amazon served a Robot Check captcha (bad IP / too many requests). Retry later, slow down, or use a proxy.
- **"reviews need a product UUID/ASIN"**: pass the proper product URL or id (Allegro UUID, Amazon ASIN), not an offer id.
- **Amazon reviews look thin**: logged-out only ~8 are available — run `shoppr auth --store amazon --from-chrome` while logged in for the full set.
- **Empty results**: check the URL/slug/ASIN, broaden the query, or the product may have no reviews/offers.
- **Stores**: `allegro`, `amazon` (amazon.pl), and `ceneo` (ceneo.pl) are wired up. Amazon and Ceneo are HTML-scraped, so selectors can drift if they restyle. Ceneo needs no cookie at all.
