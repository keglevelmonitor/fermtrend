/* Brewer's Friend REST client (browser-side).
 *
 * Talks to the Cloudflare Worker deployed from worker/index.js, which
 * proxies to https://api.brewersfriend.com/v1 and adds CORS response
 * headers.  Never call api.brewersfriend.com directly -- BF's API
 * does not set Access-Control-Allow-Origin so browsers reject it.
 *
 * The API key lives in localStorage and is sent in the X-API-Key
 * header on every request.  It never touches persistent storage on
 * the Worker; the Worker forwards the header verbatim to BF.
 *
 * Ports of the Pico-side functions in src/brewersfriend.py:
 *   list_sessions           -> listSessions
 *   fetch_current           -> fetchCurrent
 *   _fetch_window           -> fetchReadingsWindow  (paginated)
 *   _reading_temp_f         -> readingTempF
 */

/* ---------------------------------------------------------------------------
 * REPLACE ME after your first `wrangler deploy` in worker/.
 * Wrangler prints a URL like:
 *   https://fermtrend-proxy.<your-subdomain>.workers.dev
 * ------------------------------------------------------------------------- */
export const WORKER_URL = "https://fermtrend-proxy.keglevelmonitor.workers.dev";

const API_PATH_PREFIX = "/v1";     // BF's REST version prefix

/* ---------------------------------------------------------------------------
 * API-key storage.  localStorage on this device only.  No sync, no
 * backup, no cross-device magic -- users who want it on their phone
 * enter it on the phone.
 * ------------------------------------------------------------------------- */

const LS_KEY = "fermtrend.bf_api_key";

export function setApiKey(key) {
  if (typeof key !== "string") return;
  const trimmed = key.trim();
  if (trimmed) localStorage.setItem(LS_KEY, trimmed);
  else         localStorage.removeItem(LS_KEY);
}

export function getApiKey() {
  return localStorage.getItem(LS_KEY) || "";
}

export function hasApiKey() {
  return !!getApiKey();
}

export function clearApiKey() {
  localStorage.removeItem(LS_KEY);
}

/* ---------------------------------------------------------------------------
 * HTTP helpers
 * ------------------------------------------------------------------------- */

function workerUrlFor(path) {
  if (!WORKER_URL || WORKER_URL === "REPLACE_ME_WITH_YOUR_WORKER_URL") {
    throw new Error(
      "FermTrend: WORKER_URL is not configured.  Deploy the Cloudflare "
      + "Worker in worker/ and paste its URL into bf-client.js."
    );
  }
  const p = path.startsWith("/") ? path : "/" + path;
  return WORKER_URL.replace(/\/+$/, "") + API_PATH_PREFIX + p;
}

async function bfGet(path, { signal, timeoutMs = 20000 } = {}) {
  const key = getApiKey();
  if (!key) throw new Error("No API key set.  Enter one on the Settings tab.");

  // Compose the abort signal.  If the caller already has one we combine
  // both -- caller can still cancel, and we still time out.
  const timeoutCtl = new AbortController();
  const timer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
  const combinedSignal = signal
    ? anySignal([signal, timeoutCtl.signal])
    : timeoutCtl.signal;

  let resp;
  try {
    resp = await fetch(workerUrlFor(path), {
      method:  "GET",
      headers: {
        "X-API-Key": key,
        "Accept":    "application/json",
      },
      signal: combinedSignal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw new Error(signal && signal.aborted
        ? "Request cancelled"
        : `Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw new Error(`Network error: ${err.message || err}`);
  }
  clearTimeout(timer);

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Brewer's Friend rejected the API key (HTTP ${resp.status}).`);
  }
  if (resp.status === 429) {
    throw new Error("Brewer's Friend rate limit hit (HTTP 429).  Wait a minute and retry.");
  }
  if (!resp.ok) {
    let bodyPeek = "";
    try { bodyPeek = (await resp.text()).slice(0, 200); } catch (_) {}
    throw new Error(`HTTP ${resp.status}: ${bodyPeek || resp.statusText}`);
  }

  try {
    return await resp.json();
  } catch (err) {
    throw new Error(`Response was not JSON: ${err.message || err}`);
  }
}

// Combine multiple AbortSignals into one -- native browser API missing
// from Safari as of writing, so we polyfill.
function anySignal(signals) {
  const ctl = new AbortController();
  const onAbort = () => {
    ctl.abort();
    for (const s of signals) s.removeEventListener("abort", onAbort);
  };
  for (const s of signals) {
    if (s.aborted) { ctl.abort(); break; }
    s.addEventListener("abort", onAbort);
  }
  return ctl.signal;
}

/* ---------------------------------------------------------------------------
 * Field parsers -- match src/brewersfriend.py so results are identical.
 * ------------------------------------------------------------------------- */

function toFloat(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Convert BF's per-reading temp to Fahrenheit, honoring temp_unit.
// Mirror of _reading_temp_f in src/brewersfriend.py.  Fallback for
// missing temp_unit: values > 45 are assumed to already be F (45 C
// would be 113 F, well above any fermentation).
export function readingTempF(r) {
  const tv = toFloat(r && r.temp);
  if (tv === null) return null;
  const unit = String((r && r.temp_unit) || "").trim().toUpperCase();
  if (unit === "F") return tv;
  if (unit === "C") return tv * 9 / 5 + 32;
  return tv > 45 ? tv : tv * 9 / 5 + 32;
}

/* ---------------------------------------------------------------------------
 * Public API
 * ------------------------------------------------------------------------- */

/**
 * List the user's recent brew sessions.
 * Returns: [{ id, title, created_at, og }, ...]  (newest first per BF)
 */
export async function listSessions({ limit = 10 } = {}) {
  const data = await bfGet(`/brewsessions?limit=${limit}`);
  const raw  = Array.isArray(data && data.brewsessions) ? data.brewsessions : [];
  return raw.map(s => ({
    id:         String(s.id ?? ""),
    title:      s.recipe_title || s.name || "",
    created_at: s.created_at || "",
    updated_at: s.updated_at || "",
    og:         toFloat(s.current_stats && s.current_stats.og),
  })).filter(s => s.id);
}

/**
 * Fetch the session summary + last reading.
 * Returns: { sg, og, temp_f, ts, og_ts, title, updated_at }
 * Any field may be null / empty if BF didn't supply it.
 */
export async function fetchCurrent(sessionId) {
  if (!sessionId) return {};
  const data = await bfGet(`/brewsessions/${encodeURIComponent(sessionId)}`);
  const sess = data && Array.isArray(data.brewsessions) && data.brewsessions[0];
  if (!sess) return {};

  const current = sess.current_stats || {};
  const og      = toFloat(current.og);
  const og_ts   = sess.created_at || "";
  const title   = sess.recipe_title || "";
  const upd     = sess.updated_at || "";

  // BF stores the last reading blob JSON-encoded inside device_reading.
  let dr = sess.device_reading;
  if (typeof dr === "string") {
    try { dr = JSON.parse(dr); } catch (_) { dr = {}; }
  }
  const last = (dr && typeof dr === "object" && dr.last_reading) || {};
  const sg     = toFloat(last.gravity);
  const temp_f = readingTempF(last);
  const ts     = sess.device_updated_at || "";

  return { sg, og, temp_f, ts, og_ts, title, updated_at: upd };
}

/**
 * Fetch fermentation readings for a session, paginated.  Concatenates
 * pages until BF returns a short page.  Optional `onProgress({page,
 * total})` callback for UI feedback during long fetches.
 *
 * Filters:
 *   fromDate  "YYYY-MM-DD" inclusive.  Falls back to session start.
 *   toDate    "YYYY-MM-DD" inclusive.  Falls back to unbounded.
 *
 * Returns Array<{ t: ISOString, sg: number, tf: number|null }>
 * sorted chronologically (oldest -> newest).  Rows without a numeric
 * gravity are dropped, matching the Pico's ring buffer contract.
 */
export async function fetchReadingsWindow(sessionId, {
  fromDate = null,
  toDate   = null,
  pageSize = 100,   // browsers don't have the Pico's 50-row heap constraint
  maxPages = 40,
  onProgress = null,
  signal   = null,
} = {}) {
  if (!sessionId) return [];

  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const skip = (page - 1) * pageSize;
    const parts = [`skip=${skip}`, `limit=${pageSize}`];
    if (fromDate) parts.push(`from=${encodeURIComponent(fromDate)}`);
    if (toDate)   parts.push(`to=${encodeURIComponent(toDate)}`);
    const path = `/fermentation/${encodeURIComponent(sessionId)}?${parts.join("&")}`;

    const data = await bfGet(path, { signal });
    const raw  = Array.isArray(data && data.readings) ? data.readings : [];

    for (const r of raw) {
      const sg = toFloat(r.gravity);
      if (sg === null) continue;
      out.push({
        t:  r.created_at || "",
        sg,
        tf: readingTempF(r),
      });
    }

    if (typeof onProgress === "function") {
      try { onProgress({ page, total: out.length, gotPage: raw.length }); }
      catch (_) {}
    }

    // Short page terminates the loop -- there are no more readings in
    // this window.
    if (raw.length < pageSize) break;
  }

  // BF returns oldest-first inside a page and pages are walked skip-
  // ascending, so `out` is already chronological.  Sort defensively in
  // case a future BF change breaks that assumption.
  out.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return out;
}

/**
 * Compute the ISO date "N days before anchorIso".  Anchor uses noon
 * UTC to avoid DST edge cases.  Returns "YYYY-MM-DD" or null on parse
 * failure.
 */
export function isoDateMinusDays(anchorIso, days) {
  if (typeof anchorIso !== "string" || anchorIso.length < 10) return null;
  const y = parseInt(anchorIso.slice(0, 4), 10);
  const m = parseInt(anchorIso.slice(5, 7), 10);
  const d = parseInt(anchorIso.slice(8, 10), 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const utc = Date.UTC(y, m - 1, d, 12, 0, 0) - days * 86400 * 1000;
  const dt  = new Date(utc);
  const pad = n => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * "Today" as YYYY-MM-DD in UTC.
 */
export function todayIsoDate() {
  const d = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
