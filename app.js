/* FermTrend main app shell.
 *
 * Responsibilities:
 *   - Tab switching (dashboard / sessions / settings / about).
 *   - Settings form: BF API key + FG analyzer knobs.
 *   - Sessions tab: fetch + list BF sessions, click to select.
 *   - Dashboard: render loaded readings through FG.analyze + chart.
 *   - Persistence: IndexedDB via storage.js.
 *
 * Everything is loaded fresh on each page load -- there's no
 * background poll, no push, no periodic tick.  Users click Refresh
 * when they want fresh BF data.  Rationale: this is a diagnostic
 * dashboard, not a control system; every extra background call
 * eats the shared Worker rate limit budget without user benefit.
 */

import { FG } from "./fg.js";
import { renderTrendGraph } from "./chart.js";
import {
  WORKER_URL,
  getApiKey, setApiKey, hasApiKey, clearApiKey,
  listSessions, fetchCurrent, fetchReadingsWindow,
  isoDateMinusDays, todayIsoDate,
} from "./bf-client.js";
import {
  getReadings, putReadings,
  putSession, getSession,
  getFgSettings, putFgSettings, DEFAULT_FG_SETTINGS,
  getLastSessionId, putLastSessionId,
} from "./storage.js";

/* ---------------------------------------------------------------------------
 * App state (in-memory).
 * ------------------------------------------------------------------------- */

const app = {
  fgSettings:   { ...DEFAULT_FG_SETTINGS },
  sessions:     [],                    // last-loaded list from /brewsessions
  currentSessionId: "",
  currentSession:   null,              // { id, title, og, updated_at, ... }
  readings:     [],                    // Array<{t, sg, tf}>
  currentBf:    null,                  // last fetchCurrent() result
};

const $  = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

/* ---------------------------------------------------------------------------
 * Init
 * ------------------------------------------------------------------------- */

document.addEventListener("DOMContentLoaded", init);

async function init() {
  wireTabs();
  wireSettings();
  wireSessions();
  wireDashboard();

  // Load persisted FG settings + last session id.
  try { app.fgSettings = await getFgSettings(); } catch (_) {}
  populateFgSettingsForm();
  updateWindowLabels();

  updateConnPill();

  // Try to reload the last-viewed session from cache so the dashboard
  // is populated on refresh without a network round-trip.
  try {
    const lastId = await getLastSessionId();
    if (lastId) {
      const meta = await getSession(lastId);
      const cached = await getReadings(lastId);
      if (meta && cached && cached.readings) {
        app.currentSessionId = lastId;
        app.currentSession   = meta;
        app.readings         = cached.readings;
        $("#session-label").textContent = meta.title || lastId;
        renderDashboard();
      }
    }
  } catch (_) {}
}

/* ---------------------------------------------------------------------------
 * Tabs
 * ------------------------------------------------------------------------- */

function wireTabs() {
  for (const btn of $$(".nav-btn")) {
    btn.addEventListener("click", () => {
      const t = btn.getAttribute("data-tab");
      for (const b of $$(".nav-btn")) b.classList.toggle("active", b === btn);
      for (const el of $$(".tab")) {
        el.classList.toggle("hidden", el.id !== "tab-" + t);
      }
    });
  }
}

/* ---------------------------------------------------------------------------
 * Connection pill
 * ------------------------------------------------------------------------- */

function updateConnPill() {
  const pill = $("#conn-pill");
  if (!pill) return;
  if (!WORKER_URL || WORKER_URL === "REPLACE_ME_WITH_YOUR_WORKER_URL") {
    pill.textContent = "NO PROXY";
    pill.className   = "status-pill warn";
    pill.title       = "Deploy the Worker and set WORKER_URL in bf-client.js";
  } else if (!hasApiKey()) {
    pill.textContent = "NO KEY";
    pill.className   = "status-pill offline";
    pill.title       = "Enter your BF API key on the Settings tab";
  } else {
    pill.textContent = "READY";
    pill.className   = "status-pill online";
    pill.title       = "API key saved locally.  Ready to fetch.";
  }
}

/* ---------------------------------------------------------------------------
 * Settings tab
 * ------------------------------------------------------------------------- */

function wireSettings() {
  const keyInput = $("#input-api-key");
  keyInput.value = getApiKey();

  $("#btn-save-key").addEventListener("click", () => {
    setApiKey(keyInput.value);
    setMsg("#key-msg", hasApiKey() ? "Saved." : "Cleared.", "ok");
    updateConnPill();
  });

  $("#btn-clear-key").addEventListener("click", () => {
    clearApiKey();
    keyInput.value = "";
    setMsg("#key-msg", "Cleared.", "ok");
    updateConnPill();
  });

  $("#btn-test-key").addEventListener("click", async () => {
    setMsg("#key-msg", "Testing...", "");
    try {
      // Cheapest call: list 1 session.  Verifies both the worker URL
      // and the key without pulling any readings.
      const sess = await listSessions({ limit: 1 });
      setMsg("#key-msg", `OK -- got ${sess.length} session${sess.length === 1 ? "" : "s"}.`, "ok");
      updateConnPill();
    } catch (err) {
      setMsg("#key-msg", err.message || String(err), "err");
    }
  });

  $("#btn-save-fg").addEventListener("click", async () => {
    readFgSettingsForm();
    try {
      await putFgSettings(app.fgSettings);
      setMsg("#fg-save-msg", "Saved.", "ok");
      updateWindowLabels();
      // Re-render the dashboard against loaded readings so tweaks show
      // up immediately.
      if (app.readings.length) renderDashboard();
    } catch (err) {
      setMsg("#fg-save-msg", err.message || String(err), "err");
    }
  });

  $("#btn-reset-fg").addEventListener("click", async () => {
    app.fgSettings = { ...DEFAULT_FG_SETTINGS };
    populateFgSettingsForm();
    try {
      await putFgSettings(app.fgSettings);
      setMsg("#fg-save-msg", "Reset.", "ok");
      updateWindowLabels();
      if (app.readings.length) renderDashboard();
    } catch (err) {
      setMsg("#fg-save-msg", err.message || String(err), "err");
    }
  });
}

function populateFgSettingsForm() {
  $("#in-tolerance").value    = app.fgSettings.tolerance;
  $("#in-window-days").value  = app.fgSettings.window_days;
  $("#in-max-outliers").value = app.fgSettings.max_outliers;
  $("#in-min-readings").value = app.fgSettings.min_readings;
  $("#in-stale-hours").value  = app.fgSettings.stale_hours;
}

function readFgSettingsForm() {
  app.fgSettings = {
    tolerance:    parseFloat($("#in-tolerance").value)    || DEFAULT_FG_SETTINGS.tolerance,
    window_days:  parseInt  ($("#in-window-days").value)  || DEFAULT_FG_SETTINGS.window_days,
    max_outliers: parseInt  ($("#in-max-outliers").value) || DEFAULT_FG_SETTINGS.max_outliers,
    min_readings: parseInt  ($("#in-min-readings").value) || DEFAULT_FG_SETTINGS.min_readings,
    stale_hours:  parseInt  ($("#in-stale-hours").value)  || DEFAULT_FG_SETTINGS.stale_hours,
  };
  // Clamp window_days to the analyzer's supported range.
  app.fgSettings.window_days = Math.max(1, Math.min(6, app.fgSettings.window_days));
}

function updateWindowLabels() {
  const w = String(app.fgSettings.window_days);
  const l1 = $("#fetch-window-label");
  const l2 = $("#fetch-window-label2");
  if (l1) l1.textContent = w;
  if (l2) l2.textContent = w;
}

/* ---------------------------------------------------------------------------
 * Sessions tab
 * ------------------------------------------------------------------------- */

function wireSessions() {
  $("#btn-load-sessions").addEventListener("click", loadSessions);
}

async function loadSessions() {
  if (!hasApiKey()) {
    setMsg("#sessions-msg", "Add your BF API key on the Settings tab first.", "warn");
    return;
  }
  setMsg("#sessions-msg", "Loading...", "");
  try {
    app.sessions = await listSessions({ limit: 20 });
    renderSessionsList();
    setMsg("#sessions-msg", `${app.sessions.length} session(s).`, "ok");
  } catch (err) {
    setMsg("#sessions-msg", err.message || String(err), "err");
  }
}

function renderSessionsList() {
  const list = $("#sessions-list");
  list.innerHTML = "";
  if (!app.sessions.length) {
    list.innerHTML = `<div class="empty-state">No sessions returned.</div>`;
    return;
  }
  for (const s of app.sessions) {
    const row = document.createElement("div");
    row.className = "session-row" + (s.id === app.currentSessionId ? " active" : "");
    row.innerHTML = `
      <div class="session-title"></div>
      <div class="session-meta"></div>
    `;
    row.querySelector(".session-title").textContent = s.title || `(session ${s.id})`;
    const bits = [];
    if (s.og) bits.push(`OG ${s.og.toFixed(3)}`);
    if (s.updated_at) bits.push(`updated ${s.updated_at.slice(0, 10)}`);
    else if (s.created_at) bits.push(`created ${s.created_at.slice(0, 10)}`);
    row.querySelector(".session-meta").textContent = bits.join(" \u00b7 ");

    row.addEventListener("click", () => selectSession(s));
    list.appendChild(row);
  }
}

async function selectSession(s) {
  app.currentSessionId = s.id;
  app.currentSession   = s;
  await putLastSessionId(s.id);
  await putSession(s.id, s);
  $("#session-label").textContent = s.title || s.id;
  renderSessionsList();

  // Kick off a fresh fetch.  Jump to dashboard so the user sees
  // progress.
  document.querySelector('.nav-btn[data-tab="dashboard"]').click();
  await refreshFromBf();
}

/* ---------------------------------------------------------------------------
 * Dashboard tab
 * ------------------------------------------------------------------------- */

function wireDashboard() {
  $("#btn-refresh").addEventListener("click", refreshFromBf);
}

async function refreshFromBf() {
  if (!hasApiKey()) {
    setMsg("#refresh-msg", "Add your BF API key on the Settings tab first.", "warn");
    return;
  }
  if (!app.currentSessionId) {
    setMsg("#refresh-msg", "Pick a session on the Sessions tab first.", "warn");
    return;
  }

  const btn = $("#btn-refresh");
  btn.disabled = true;
  setMsg("#refresh-msg", "Fetching session summary...", "");

  try {
    // 1. Pull the session summary -- gives us title / OG / updated_at.
    const current = await fetchCurrent(app.currentSessionId);
    app.currentBf = current;
    if (current && current.title) {
      $("#session-label").textContent = current.title;
      // Update the cached session meta so the sessions list reflects
      // any title/OG changes.
      await putSession(app.currentSessionId, {
        ...(app.currentSession || {}),
        title: current.title,
        og:    current.og,
        updated_at: current.updated_at,
      });
    }

    // 2. Decide the "from" date.  For an active session (updated_at
    //    within the last few days) anchor on today; for an archived
    //    session anchor on updated_at so we get the final tail.
    const anchor = pickAnchorIso(current);
    const from   = isoDateMinusDays(anchor, app.fgSettings.window_days);
    const to     = isoDateMinusDays(anchor, -1); // anchor + 1 day inclusive

    setMsg("#refresh-msg", `Fetching readings ${from} \u2192 ${to}...`, "");

    // 3. Fetch readings, page by page.
    const readings = await fetchReadingsWindow(app.currentSessionId, {
      fromDate: from,
      toDate:   to,
      onProgress: ({ page, total }) => {
        setMsg("#refresh-msg", `Fetching page ${page} (${total} readings so far)...`, "");
      },
    });
    app.readings = readings;
    await putReadings(app.currentSessionId, readings);

    setMsg("#refresh-msg", `Loaded ${readings.length} reading${readings.length === 1 ? "" : "s"}.`, "ok");
    renderDashboard();
  } catch (err) {
    setMsg("#refresh-msg", err.message || String(err), "err");
  } finally {
    btn.disabled = false;
  }
}

function pickAnchorIso(current) {
  // "Recently updated" = within the last 4 days -> use today.  Any
  // older -> use the session's updated_at (so we grab the tail of a
  // finished ferment).  Falls back to today when we have neither.
  const today = todayIsoDate() + "T12:00:00Z";
  if (!current) return today;
  const u = current.updated_at || current.og_ts || "";
  if (!u || u.length < 10) return today;
  // Use FG.parseIsoToSec so both "2026-07-20T15:32:00Z" and
  // "2026-07-20 15:32:00" (BF's alternate format) are handled.
  const udSec = FG.parseIsoToSec(u);
  if (udSec === null) return today;
  const nowSec  = Date.now() / 1000;
  const ageDays = (nowSec - udSec) / 86400;
  // BF's session.updated_at ticks when the session record is edited,
  // not on new fermentation readings.  So a "recently updated"
  // session is a proxy for "user has touched it lately", not
  // necessarily "readings are recent".  We default to today anyway
  // and only fall back to updated_at if the session hasn't been
  // touched in over a month -- that's almost always a truly archived
  // ferment where anchoring on today would return an empty window.
  if (ageDays < 30) return today;
  return u;
}

/* ---- Dashboard render ---- */

function renderDashboard() {
  const loaded = $("#dash-loaded");
  const empty  = $("#dash-empty");
  if (!app.currentSessionId || !app.readings.length) {
    loaded.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  loaded.classList.remove("hidden");
  empty.classList.add("hidden");

  renderStrip();
  renderStaleBanner();

  const result = FG.analyze(app.readings, app.fgSettings);
  const cls    = FG.classify(result);
  renderFgCard(cls);
  renderTrendGraph({
    svg:      $("#trend-svg"),
    emptyEl:  $("#trend-empty"),
    subEl:    $("#trend-sub"),
    readings: app.readings,
    result,
    cfg:      app.fgSettings,
    cls,
  });
  $("#fg-diag").textContent = FG.renderDiagnostics(result);
}

function renderStrip() {
  const first = app.readings[0];
  const last  = app.readings[app.readings.length - 1];
  const bf    = app.currentBf || {};

  const og = bf.og || (app.currentSession && app.currentSession.og);
  $("#strip-og").textContent = fmtSg(og);

  $("#strip-sg").textContent = fmtSg(last && last.sg);
  $("#strip-temp").textContent =
    (last && typeof last.tf === "number") ? `${last.tf.toFixed(1)}\u00b0F` : "-.-\u00b0F";

  $("#strip-count").textContent = String(app.readings.length);

  const lastAge = last && FG.parseIsoToSec(last.t);
  if (lastAge) {
    const ageH = (Date.now() / 1000 - lastAge) / 3600;
    $("#strip-sg-age").textContent = `${FG.fmtHours(ageH)} ago`;
  } else {
    $("#strip-sg-age").textContent = "";
  }

  if (first && last) {
    const spanH = (FG.parseIsoToSec(last.t) - FG.parseIsoToSec(first.t)) / 3600;
    $("#strip-span").textContent = `span ${FG.fmtHours(spanH)}`;
  } else {
    $("#strip-span").textContent = "";
  }
}

function renderStaleBanner() {
  const banner = $("#stale-banner");
  const text   = $("#stale-text");
  const last   = app.readings[app.readings.length - 1];
  const lastTs = last && FG.parseIsoToSec(last.t);
  if (!lastTs) {
    banner.classList.add("hidden");
    return;
  }
  const ageH = (Date.now() / 1000 - lastTs) / 3600;
  const staleH = Number(app.fgSettings.stale_hours) || DEFAULT_FG_SETTINGS.stale_hours;
  if (ageH < staleH) {
    banner.classList.add("hidden");
    return;
  }
  text.textContent =
    `Newest reading is ${FG.fmtHours(ageH)} old (threshold ${FG.fmtHours(staleH)}).  Brewer's Friend has no fresher data.`;
  banner.classList.remove("hidden");
}

function renderFgCard(cls) {
  const status = $("#fg-status");
  const value  = $("#fg-value");
  const hint   = $("#fg-hint");
  const ts     = $("#fg-ts");

  status.textContent = cls.status;
  value.textContent  = cls.value;
  hint.textContent   = cls.hint || "-";

  // Color the status label.
  status.className = "fg-val " + statusClass(cls.status);
  value.className  = "fg-val " + statusClass(cls.status);

  if (cls.last_ts) ts.textContent = `newest ${cls.last_ts.slice(0, 16).replace("T", " ")}`;
  else             ts.textContent = "";
}

function statusClass(status) {
  switch (status) {
    case "Stable":              return "fg-stable";
    case "Still Fermenting":    return "fg-fermenting";
    case "Settling":            return "fg-settling";
    case "Jittery Readings":    return "fg-jittery";
    case "Not Enough Readings": return "fg-not-enough";
    default:                    return "";
  }
}

function fmtSg(v) {
  return (typeof v === "number") ? v.toFixed(3) : "-.---";
}

/* ---------------------------------------------------------------------------
 * Message helper
 * ------------------------------------------------------------------------- */

function setMsg(sel, text, kind) {
  const el = typeof sel === "string" ? $(sel) : sel;
  if (!el) return;
  el.textContent = text;
  el.className   = "msg" + (kind ? " " + kind : "");
}
