/* FermTrend CORS proxy Worker
 *
 * Brewer's Friend's public REST API at api.brewersfriend.com does not
 * set Access-Control-Allow-Origin, so browsers cannot call it directly
 * (the preflight OPTIONS fails even from BF's own www.brewersfriend.com
 * origin -- their site uses cookie-authed backend calls, not REST from
 * the browser).  This Worker is a stateless pass-through that:
 *
 *   1. Answers the OPTIONS preflight with the CORS headers the browser
 *      needs (Authorization, Content-Type, GET/OPTIONS).
 *   2. For GET requests, rewrites the URL host to api.brewersfriend.com,
 *      forwards the Authorization header verbatim, and copies the
 *      response back with Access-Control-Allow-Origin bolted on.
 *
 * The Worker does not log, cache, or persist any credentials.  It has
 * no KV / D1 / R2 bindings, on purpose -- if it did, an operator could
 * accidentally end up storing user API keys.
 *
 * Free-tier budget: 100,000 requests/day.  A single FermTrend user's
 * typical daily usage (background refresh every 30 min + a few
 * dashboard opens) is under 1500 requests, so one Worker can safely
 * serve dozens of concurrent users.
 */

const BF_ORIGIN     = "https://api.brewersfriend.com";

// CHANGE ME after your first `wrangler deploy` to lock this Worker to
// your own GitHub Pages origin.  "*" is fine for local development.
const ALLOWED_ORIGIN = "https://keglevelmonitor.github.io";

// Preflight cache: browsers won't re-preflight for this many seconds.
const PREFLIGHT_MAX_AGE = 86400; // 24 h

function corsHeaders(req) {
  const reqOrigin = req.headers.get("Origin") || "";
  // If ALLOWED_ORIGIN is a wildcard, echo it back; otherwise reflect
  // only when it matches so a locked deploy actually enforces the lock.
  let allow;
  if (ALLOWED_ORIGIN === "*") {
    allow = "*";
  } else if (reqOrigin === ALLOWED_ORIGIN) {
    allow = ALLOWED_ORIGIN;
  } else {
    // Origin mismatch -- return the allowed origin anyway so the
    // browser surfaces a clean "origin blocked" error instead of a
    // confusing "response missing CORS headers".
    allow = ALLOWED_ORIGIN;
  }
  return {
    "Access-Control-Allow-Origin":  allow,
    // Both Authorization (Basic api:KEY) and X-API-Key are accepted by
    // BF -- allow both header styles so users can pick either.  The
    // browser preflight will list whichever the actual request sends.
    "Access-Control-Allow-Headers": "Authorization, X-API-Key, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age":       String(PREFLIGHT_MAX_AGE),
    "Vary": "Origin",
  };
}

function jsonError(status, message, req) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(req),
    },
  });
}

export default {
  async fetch(request) {
    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    // Only GET is proxied.  BF's read-only API is GET-only; anything
    // else is almost certainly abuse or misuse of this proxy.
    if (request.method !== "GET") {
      return jsonError(405, "Method not allowed", request);
    }

    // Rewrite host: keep path + query, swap origin to BF.
    const inUrl  = new URL(request.url);
    const bfUrl  = new URL(inUrl.pathname + inUrl.search, BF_ORIGIN);

    // Forward only the headers we actually need.  Do not leak the
    // browser's User-Agent or Cookie to BF, and do not send our own
    // Cloudflare CF-* headers.
    const fwdHeaders = new Headers();
    const auth = request.headers.get("Authorization");
    if (auth) fwdHeaders.set("Authorization", auth);
    const xkey = request.headers.get("X-API-Key");
    if (xkey) fwdHeaders.set("X-API-Key", xkey);
    fwdHeaders.set("Accept", request.headers.get("Accept") || "application/json");
    fwdHeaders.set("User-Agent", "FermTrend/1.0 (+https://github.com/keglevelmonitor/FermTrend)");

    let upstream;
    try {
      upstream = await fetch(bfUrl.toString(), {
        method:  "GET",
        headers: fwdHeaders,
        // No body on GET.
        // Do NOT enable Cloudflare's built-in caching; user data
        // should always reflect current BF state.
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } catch (err) {
      return jsonError(502, `Upstream fetch failed: ${err && err.message || err}`, request);
    }

    // Rebuild the response with CORS headers merged in.  Preserve
    // status, status text, and BF's Content-Type / Content-Length.
    const outHeaders = new Headers(upstream.headers);
    const cors = corsHeaders(request);
    for (const [k, v] of Object.entries(cors)) outHeaders.set(k, v);
    // Belt-and-suspenders: strip any BF-set cookies before they hit
    // the browser -- BF's API doesn't set any today, but if that
    // changes we don't want to accidentally session-bind the client.
    outHeaders.delete("Set-Cookie");

    return new Response(upstream.body, {
      status:     upstream.status,
      statusText: upstream.statusText,
      headers:    outHeaders,
    });
  },
};
