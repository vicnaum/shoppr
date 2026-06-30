# shoppr

Shopping data for AI agents — a CLI that fetches **product details, prices, reviews, seller offers, and search/category listings** from online stores by scraping their own JSON/HTML (no official API). **Allegro**, **Amazon (amazon.pl)**, and **Ceneo (ceneo.pl)** are implemented; the architecture is multi-store (more stores are pluggable providers). The store auto-detects from the URL. Ships a Claude/Cursor/Codex skill.

Built in the shape of [`reddx`](https://github.com/vicnaum/reddx) / `twx`: global `-p/--print`, per-command `-f/-o`, smart input parsing, and `json`/`md` formatters.

## Install the CLI (global)

```bash
git clone https://github.com/vicnaum/shoppr.git
cd shoppr && pnpm install && pnpm build && npm link
```

`npm link` puts `shoppr` on your `PATH`, so it runs from any directory — independent of the repo. Config (cookies, proxy) is global, in `~/.config/shoppr/.env`.

## Install the skill

Copy `skills/shoppr/` into your agent's skills directory:

```bash
# Claude Code
cp -r skills/shoppr ~/.claude/skills/shoppr
# Cursor
cp -r skills/shoppr ~/.cursor/skills/shoppr
# Codex
cp -r skills/shoppr ~/.codex/skills/shoppr
```

The skill handles setup checks, cookie/auth prompts, store/command selection, and output analysis automatically. Once installed, the agent responds to prompts like "what's the cheapest seller for this Allegro product", "compare prices for this on Ceneo", or "summarize the reviews for this Amazon ASIN".

## Auth / cookies

- **Reviews** work with no setup.
- **Product / offers / search / category** sit behind Allegro's **DataDome** bot wall and need a session cookie (the `datadome` cookie in particular). It also gives correct, region-specific delivery prices.

**Easiest (macOS): read it straight from Chrome** — no manual export, just have visited allegro.pl in the browser once:

```bash
shoppr auth --store allegro --from-chrome          # decrypts the local cookie store
shoppr auth --store allegro --from-chrome --browser brave --profile "Profile 1"
```

(May trigger a one-time macOS Keychain approval.) Or import a HAR / paste a cookie:

```bash
shoppr auth --store allegro --har allegro.pl.har   # DevTools → Network → "Save all as HAR"
shoppr auth --store allegro --cookie "datadome=...; QXLSESSID=..."
shoppr auth                                         # show current config
shoppr auth --proxy http://user:pass@host:port
```

Config lives in `~/.config/shoppr/.env`. The `datadome` cookie is the bot-wall gate (non-HttpOnly, ~1-year TTL). When a command reports a DataDome block, re-run `shoppr auth --store allegro --from-chrome` to refresh.

## Usage

```bash
shoppr -p product <url|uuid>            # title, price, brand, GTIN, specs, rating, description
shoppr -p reviews <url|uuid>            # opinions with rating, pros/cons, images (no cookie)
shoppr -p offers  <url|uuid>            # every seller's offer + price for one product
shoppr -p search  "<query>"            # search results
shoppr    category <url|slug>           # category feed

# common flags
-f, --format json|md|both   (default both)
-o, --output <dir>          (default ./output)
-s, --store  allegro|amazon|ceneo (auto-detected from URL; required for bare ASIN/UUID/id)
-l, --limit  <n>
-p, --print                 print instead of writing files
--debug                     verbose HTTP logging
# reviews only: --page <n>, --sort MOST_HELPFUL|NEWEST|OLDEST|HIGHEST_SCORE|LOWEST_SCORE
# search only:  --category <id>
```

### Examples

```bash
shoppr product "https://allegro.pl/produkt/...-5ccf08d3-ec72-4f3b-a1b6-cd8b8545a819" -f md -o /tmp/shoppr
shoppr reviews 5ccf08d3-ec72-4f3b-a1b6-cd8b8545a819 --limit 50 -f json -o /tmp/shoppr
shoppr offers  "https://allegro.pl/produkt/...uuid" -f md -p
shoppr search  "seagate exos 16tb" --limit 20 -f json -o /tmp/shoppr
```

## How it works

**Allegro** (returns clean JSON):

| Feature | Endpoint | Cookie |
|---|---|---|
| Reviews | `edge.allegro.pl/product-reviews` (clean JSON) | no |
| Product | `allegro.pl/produkt/<slug>` HTML → `ld+json` Product + opbox price/params | yes |
| Offers | `allegro.pl/oferty-produktu/<slug>` opbox listing (all sellers) | yes |
| Search / Category | `allegro.pl/listing?string=<q>` · `/kategoria/<slug>` opbox listing | yes |

**Amazon** (amazon.pl — HTML scraping, no clean JSON):

| Feature | Source | Cookie |
|---|---|---|
| Product | `/dp/<ASIN>` HTML (`#productTitle`, `.a-offscreen`, overview table, feature bullets) | no |
| Search / Category | `/s?k=<q>` result tiles | no |
| Reviews | embedded ~8 on the product page; full `/product-reviews/` pages | login for full set |
| Offers | all sellers via the AOD endpoint (`/gp/product/ajax/aodAjaxMain/…`), cheapest-first | no |

**Ceneo** (ceneo.pl — price-comparison engine, **no cookie needed**):

| Feature | Source |
|---|---|
| Product | `ceneo.pl/<id>` HTML → `ld+json` Product (rating + AggregateOffer low/high/count) + spec table |
| Offers | every shop's price from `data-Price`/`data-ShopUrl` rows, cheapest-first |
| Reviews | `ceneo.pl/<id>/opinie-<page>` `user-post` blocks (author, score, pros/cons, date) |
| Search / Category | `ceneo.pl/;szukaj-<q>` · category URL → `cat-prod-row` tiles |

Cookies are sanitized on save (tracking cookies like `s_sq`/`AMCV_*`/`_meta_*` are dropped — Amazon 400s on them). Adding a store = a new module in `src/providers/` implementing the `Provider` interface (`src/providers/provider.ts`), registered in `src/providers/index.ts`, plus host detection in `utils/input-parser.ts`. Normalized output types live in `src/types.ts`.

## License

MIT
