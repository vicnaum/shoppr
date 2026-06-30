// Clean a Cookie header before we store/replay it. Browser cookie jars include
// analytics/tracking cookies that are useless for scraping and can actively break
// requests — Amazon, for instance, returns HTTP 400 when sent its Adobe/AWS
// analytics cookies (s_sq, AMCV_*, aws-vid, …). We also drop any cookie whose
// value contains header-unsafe control characters. Applied to every cookie source
// (HAR import, --cookie, --from-chrome) so the saved header is always valid.

const TRACKING_DENYLIST = [
  /^s_/i, // Adobe SiteCatalyst (s_sq, s_cc, s_pers, s_vnum, …)
  /^AMCVS?_/i, // Adobe Marketing Cloud
  /^aws-(vid|priv|account|target)/i, // AWS analytics
  /^csm-hit$/i, // Amazon client-side metrics
  /^_ga(_|$)/i, // Google Analytics
  /^_gid$/i,
  /^_gcl_/i,
  /^_fbp$/i,
  /^_tt?p$/i,
  /^_pin_/i,
  /^_uet[sv]id$/i,
  /^_clck$/i,
  /^_clsk$/i,
  /^_scid$/i,
  /^__gads$/i,
  /^_meta_/i, // ad-network sync blobs (seen on Allegro)
];

function isTracking(name: string): boolean {
  return TRACKING_DENYLIST.some((re) => re.test(name));
}

/** Cookie value is unsafe in a header if it has control chars or structural delimiters. */
function hasUnsafeChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f]/.test(value);
}

export interface SanitizeResult {
  cookie: string;
  kept: string[];
  dropped: string[];
}

/** Drop tracking + malformed cookies; keep auth/session cookies. */
export function sanitizeCookieHeader(cookie: string): SanitizeResult {
  const kept: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const part of cookie.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1);
    if (!name || seen.has(name)) continue;
    if (isTracking(name) || hasUnsafeChars(value)) {
      dropped.push(name);
      continue;
    }
    seen.add(name);
    kept.push(`${name}=${value}`);
  }
  return { cookie: kept.join('; '), kept: [...seen], dropped };
}
