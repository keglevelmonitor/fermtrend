/* IndexedDB wrapper for FermTrend.
 *
 * Three logical stores:
 *   readings     key: sessionId  value: { readings: [...], cachedAt: msEpoch }
 *   sessions     key: sessionId  value: { title, og, updated_at, cachedAt }
 *   kv           key: string     value: any (settings, lastSessionId, ...)
 *
 * All access is async.  Callers should treat any single call as
 * potentially failing (private browsing mode disables IndexedDB) and
 * fall back to an in-memory-only mode where re-fetching from BF is the
 * only source of truth.  The app.js caller does exactly that.
 */

const DB_NAME    = "fermtrend";
const DB_VERSION = 1;

const STORE_READINGS = "readings";
const STORE_SESSIONS = "sessions";
const STORE_KV       = "kv";

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(new Error(`IndexedDB unavailable: ${err.message || err}`));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_READINGS)) db.createObjectStore(STORE_READINGS);
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS);
      if (!db.objectStoreNames.contains(STORE_KV))       db.createObjectStore(STORE_KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error || new Error("IndexedDB open failed"));
    req.onblocked = () => reject(new Error("IndexedDB open blocked by an older tab"));
  });
  return _dbPromise;
}

function tx(store, mode = "readonly") {
  return openDb().then(db => {
    const t = db.transaction(store, mode);
    return t.objectStore(store);
  });
}

function reqPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error || new Error("IndexedDB request failed"));
  });
}

/* ---------------------------------------------------------------------------
 * Readings (ring buffer per session)
 * ------------------------------------------------------------------------- */

export async function getReadings(sessionId) {
  if (!sessionId) return null;
  const s = await tx(STORE_READINGS, "readonly");
  const rec = await reqPromise(s.get(sessionId));
  return rec && Array.isArray(rec.readings) ? rec : null;
}

export async function putReadings(sessionId, readings) {
  if (!sessionId || !Array.isArray(readings)) return;
  const s = await tx(STORE_READINGS, "readwrite");
  await reqPromise(s.put({ readings, cachedAt: Date.now() }, sessionId));
}

export async function deleteReadings(sessionId) {
  if (!sessionId) return;
  const s = await tx(STORE_READINGS, "readwrite");
  await reqPromise(s.delete(sessionId));
}

/* ---------------------------------------------------------------------------
 * Sessions (list cache + per-session summary)
 * ------------------------------------------------------------------------- */

export async function putSession(sessionId, meta) {
  if (!sessionId || !meta || typeof meta !== "object") return;
  const s = await tx(STORE_SESSIONS, "readwrite");
  await reqPromise(s.put({ ...meta, cachedAt: Date.now() }, sessionId));
}

export async function getSession(sessionId) {
  if (!sessionId) return null;
  const s = await tx(STORE_SESSIONS, "readonly");
  return await reqPromise(s.get(sessionId)) || null;
}

/* ---------------------------------------------------------------------------
 * Key-value store (settings, lastSessionId, cached session list, etc.)
 * ------------------------------------------------------------------------- */

export async function kvGet(key) {
  const s = await tx(STORE_KV, "readonly");
  return await reqPromise(s.get(key));
}

export async function kvPut(key, value) {
  const s = await tx(STORE_KV, "readwrite");
  await reqPromise(s.put(value, key));
}

export async function kvDelete(key) {
  const s = await tx(STORE_KV, "readwrite");
  await reqPromise(s.delete(key));
}

/* ---------------------------------------------------------------------------
 * Settings convenience.
 *
 * FG settings mirror the FermVault Brain's api.fg block so users can
 * compare classifications side-by-side.  Defaults match the Brain
 * shipping defaults exactly.
 * ------------------------------------------------------------------------- */

const KV_SETTINGS   = "fg.settings";
const KV_LAST_SESS  = "session.last";

export const DEFAULT_FG_SETTINGS = {
  tolerance:    0.0005,
  window_days:  3,
  max_outliers: 4,
  min_readings: 20,
  stale_hours:  6,
};

export async function getFgSettings() {
  try {
    const rec = await kvGet(KV_SETTINGS);
    return { ...DEFAULT_FG_SETTINGS, ...(rec || {}) };
  } catch (_) {
    return { ...DEFAULT_FG_SETTINGS };
  }
}

export async function putFgSettings(settings) {
  const clean = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (k in DEFAULT_FG_SETTINGS) clean[k] = v;
  }
  await kvPut(KV_SETTINGS, clean);
}

export async function getLastSessionId() {
  try { return (await kvGet(KV_LAST_SESS)) || ""; }
  catch (_) { return ""; }
}

export async function putLastSessionId(id) {
  await kvPut(KV_LAST_SESS, id || "");
}
