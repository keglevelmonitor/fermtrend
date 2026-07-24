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
import {
  compensateReadings, countReadingsWithTemp, SG_CAL_TEMP_F,
} from "./sg-compensate.js";

/* ---------------------------------------------------------------------------
 * App state (in-memory).
 * ------------------------------------------------------------------------- */

const app = {
  fgSettings:   { ...DEFAULT_FG_SETTINGS },
  sessions:     [],
  currentSessionId: "",
  currentSession:   null,
  readings:     [],
  currentBf:    null,
  // Chart display mode: "window" (analysis window only) or "full"
  // (entire fetched span, up to FETCH_SPAN_DAYS).  Persisted in
  // localStorage so it survives reloads.
  chartMode:    "window",
  // Temperature overlay on the SG trend chart.  Data is stored as F
  // (tf); tempUnit is display-only.  Defaults: Temp off, °F.
  tempVisible:  false,
  tempUnit:     "F",
  // SG temperature compensation (correct to 68 F).  Default off.
  // Applied in memory to chart + FG.analyze; raw readings stay in IDB.
  compensate:   false,
  // Right edge of the analysis window (Unix seconds).  null = anchor
  // on the newest reading (default).  Set by dragging the shaded
  // region on the Full chart; width always comes from WINDOW (DAYS).
  analysisEndSec: null,
};

// Always fetch this many days of readings on Refresh.  Independent of
// WINDOW (DAYS), which is analysis-only.
const FETCH_SPAN_DAYS = 28;
const LS_CHART_MODE   = "fermtrend.chart_mode";
const LS_TEMP_VISIBLE = "fermtrend.temp_visible";
const LS_TEMP_UNIT    = "fermtrend.temp_unit";
const LS_COMPENSATE   = "fermtrend.sg_compensate";

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
  updateConnPill();

  // Restore chart display prefs.
  try {
    const saved = localStorage.getItem(LS_CHART_MODE);
    if (saved === "full" || saved === "window") app.chartMode = saved;
    if (localStorage.getItem(LS_TEMP_VISIBLE) === "1") app.tempVisible = true;
    const u = localStorage.getItem(LS_TEMP_UNIT);
    if (u === "F" || u === "C") app.tempUnit = u;
    if (localStorage.getItem(LS_COMPENSATE) === "1") app.compensate = true;
  } catch (_) {}
  syncChartModeButtons();
  syncTempControls();
  syncCompensateControl();

  // Fetch the changelog (best-effort).  Populates the header version
  // label AND the About-tab revision history card.  A missing or
  // malformed changelog.json shouldn't break the rest of the app --
  // it's diagnostic content, not core functionality.
  loadChangelog().catch(err =>
    console.warn("[changelog] load failed:", err && err.message));

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
  app.analysisEndSec   = null;
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

  // Full / Window chart mode toggle -- re-renders from cached readings,
  // no BF round-trip.
  for (const btn of $$(".trend-mode-btn[data-mode]")) {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-mode");
      if (mode !== "full" && mode !== "window") return;
      if (mode === app.chartMode) return;
      app.chartMode = mode;
      try { localStorage.setItem(LS_CHART_MODE, mode); } catch (_) {}
      syncChartModeButtons();
      if (app.readings.length) renderDashboard();
    });
  }

  const tempBtn = $("#btn-temp-toggle");
  if (tempBtn) {
    tempBtn.addEventListener("click", () => {
      app.tempVisible = !app.tempVisible;
      try { localStorage.setItem(LS_TEMP_VISIBLE, app.tempVisible ? "1" : "0"); } catch (_) {}
      syncTempControls();
      if (app.readings.length) renderDashboard();
    });
  }

  for (const btn of $$("#trend-unit .trend-mode-btn")) {
    btn.addEventListener("click", () => {
      if (!app.tempVisible) return;
      const u = btn.getAttribute("data-unit");
      if (u !== "F" && u !== "C") return;
      if (u === app.tempUnit) return;
      app.tempUnit = u;
      try { localStorage.setItem(LS_TEMP_UNIT, u); } catch (_) {}
      syncTempControls();
      if (app.readings.length) renderDashboard();
    });
  }

  const compBtn = $("#btn-comp-toggle");
  if (compBtn) {
    compBtn.addEventListener("click", () => {
      if (compBtn.classList.contains("disabled")) return;
      app.compensate = !app.compensate;
      try { localStorage.setItem(LS_COMPENSATE, app.compensate ? "1" : "0"); } catch (_) {}
      syncCompensateControl();
      if (app.readings.length) renderDashboard();
    });
  }

  // Re-render the chart when the browser window changes size so the
  // pixel-accurate viewBox stays matched to the SVG's real client
  // size.  Debounced so a continuous drag doesn't thrash re-renders.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (app.readings && app.readings.length) renderDashboard();
    }, 150);
  });
}

function syncChartModeButtons() {
  for (const btn of $$(".trend-mode-btn[data-mode]")) {
    btn.classList.toggle("active", btn.getAttribute("data-mode") === app.chartMode);
  }
}

function syncTempControls() {
  const tempBtn = $("#btn-temp-toggle");
  if (tempBtn) {
    tempBtn.classList.toggle("active", !!app.tempVisible);
    tempBtn.setAttribute("aria-pressed", app.tempVisible ? "true" : "false");
  }
  const unitGroup = $("#trend-unit");
  if (unitGroup) {
    unitGroup.classList.toggle("disabled", !app.tempVisible);
  }
  for (const btn of $$("#trend-unit .trend-mode-btn")) {
    btn.classList.toggle("active", btn.getAttribute("data-unit") === app.tempUnit);
  }
}

function syncCompensateControl() {
  const btn = $("#btn-comp-toggle");
  if (!btn) return;
  const nTemp = countReadingsWithTemp(app.readings);
  const canComp = nTemp >= 1;
  btn.classList.toggle("disabled", !canComp);
  // If we can't compensate, force the flag off in the UI so we don't
  // leave a sticky "active" look with no effect.
  if (!canComp && app.compensate) {
    app.compensate = false;
    try { localStorage.setItem(LS_COMPENSATE, "0"); } catch (_) {}
  }
  btn.classList.toggle("active", !!app.compensate && canComp);
  btn.setAttribute("aria-pressed", app.compensate && canComp ? "true" : "false");
  btn.title = canComp
    ? `Correct SG to ${SG_CAL_TEMP_F}\u00b0F using each reading's temperature. Points without temp stay raw.`
    : "Compensate needs temperature data on the loaded readings.";
}

/** Readings fed to the chart + FG analyzer (compensated or raw). */
function readingsForAnalysis() {
  if (app.compensate && countReadingsWithTemp(app.readings) >= 1) {
    return compensateReadings(app.readings);
  }
  return app.readings;
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

    // 2. Fetch up to FETCH_SPAN_DAYS of readings.
    //
    // Active sessions: device_updated_at is trustworthy -- anchor a
    // backward window of FETCH_SPAN_DAYS on it.
    //
    // Archived sessions: device_updated_at / last_reading often point
    // at the START of the ferment (or some other stale blob), so a
    // "last 28 days before that" window lands in empty pre-ferment
    // time and returns 0-1 readings.  Instead page forward from the
    // session's created_at, then keep only the last FETCH_SPAN_DAYS
    // relative to the true newest reading we found.
    let readings;
    if (isArchivedSession(current)) {
      const startIso = (current && current.og_ts)
        || (app.currentSession && app.currentSession.created_at)
        || "";
      const fromDate = (typeof startIso === "string" && startIso.length >= 10)
        ? startIso.slice(0, 10)
        : null;
      setMsg("#refresh-msg",
        fromDate
          ? `Archived session -- loading from ${fromDate}...`
          : "Archived session -- loading full history...",
        "");
      readings = await fetchReadingsWindow(app.currentSessionId, {
        fromDate,
        toDate: null,
        onProgress: ({ page, total }) => {
          setMsg("#refresh-msg",
            `Fetching page ${page} (${total} readings so far)...`, "");
        },
      });
      const before = readings.length;
      readings = trimToLastDays(readings, FETCH_SPAN_DAYS);
      if (before > readings.length) {
        setMsg("#refresh-msg",
          `Trimmed ${before} \u2192 ${readings.length} (last ${FETCH_SPAN_DAYS}d)...`, "");
      }
    } else {
      const anchor = pickAnchorIso(current);
      const from   = isoDateMinusDays(anchor, FETCH_SPAN_DAYS);
      const to     = isoDateMinusDays(anchor, -1);
      setMsg("#refresh-msg",
        `Fetching readings ${from} \u2192 ${to} (up to ${FETCH_SPAN_DAYS}d)...`, "");
      readings = await fetchReadingsWindow(app.currentSessionId, {
        fromDate: from,
        toDate:   to,
        onProgress: ({ page, total }) => {
          setMsg("#refresh-msg",
            `Fetching page ${page} (${total} readings so far)...`, "");
        },
      });
    }

    app.readings = readings;
    app.analysisEndSec = null;
    await putReadings(app.currentSessionId, readings);

    setMsg("#refresh-msg", `Loaded ${readings.length} reading${readings.length === 1 ? "" : "s"}.`, "ok");
    renderDashboard();
  } catch (err) {
    setMsg("#refresh-msg", err.message || String(err), "err");
  } finally {
    btn.disabled = false;
  }
}

// True when the session's "last reading" timestamp is missing or older
// than 24 h.  Matches the archived-session cutoff used by the stale
// banner -- a live Pill/iSpindel uploads far more often than daily.
function isArchivedSession(current) {
  if (!current || !current.ts) return true;
  const sec = FG.parseIsoToSec(current.ts);
  if (sec === null) return true;
  const ageH = (Date.now() / 1000 - sec) / 3600;
  return ageH >= 24;
}

// Keep only readings within `days` of the newest sample.  Readings
// must already be chronological (fetchReadingsWindow sorts them).
function trimToLastDays(readings, days) {
  if (!Array.isArray(readings) || !readings.length) return [];
  const lastSec = FG.parseIsoToSec(readings[readings.length - 1].t);
  if (lastSec === null) return readings;
  const cutoff = lastSec - days * 86400;
  return readings.filter(r => {
    const t = FG.parseIsoToSec(r.t);
    return t !== null && t >= cutoff;
  });
}

function pickAnchorIso(current) {
  // Active-session path only.  Prefer device_updated_at (fetchCurrent
  // returns it as `ts`); fall back to updated_at / og_ts / today.
  const today = todayIsoDate() + "T12:00:00Z";
  if (!current) return today;
  const ts = current.ts || current.updated_at || current.og_ts || "";
  if (!ts || ts.length < 10) return today;
  return FG.parseIsoToSec(ts) !== null ? ts : today;
}

/* ---- Dashboard render ---- */

function renderDashboard() {
  const loaded = $("#dash-loaded");
  const empty  = $("#dash-empty");
  if (!app.currentSessionId || !app.readings.length) {
    loaded.classList.add("hidden");
    empty.classList.remove("hidden");
    syncCompensateControl();
    return;
  }
  loaded.classList.remove("hidden");
  empty.classList.add("hidden");

  syncCompensateControl();

  // Same array for strip / FG / chart so Compensate never disagrees
  // with itself across the dashboard.
  const readings = readingsForAnalysis();

  renderStrip(readings);
  renderStaleBanner();

  const result = FG.analyze(readings, app.fgSettings, {
    anchorSec: app.analysisEndSec,
  });
  const cls    = FG.classify(result);
  renderFgCard(cls);
  renderTrendGraph({
    svg:      $("#trend-svg"),
    emptyEl:  $("#trend-empty"),
    subEl:    $("#trend-sub"),
    readings,
    result,
    cfg:      app.fgSettings,
    cls,
    mode:     app.chartMode,
    showTemp: app.tempVisible,
    tempUnit: app.tempUnit,
    compensated: !!(app.compensate && countReadingsWithTemp(app.readings) >= 1),
    analysisEndSec: app.analysisEndSec,
    onAnalysisEndChange: (endSec) => {
      app.analysisEndSec = endSec;
      renderDashboard();
    },
    onWindowDaysChange: (days) => {
      const d = Math.max(1, Math.min(6, Math.round(Number(days) || 1)));
      if (d === app.fgSettings.window_days) return;
      app.fgSettings.window_days = d;
      populateFgSettingsForm();
      putFgSettings(app.fgSettings).catch(err =>
        console.warn("[FG] save window_days failed:", err && err.message));
      renderDashboard();
    },
  });
  $("#fg-diag").textContent = FG.renderDiagnostics(result);
}

function renderStrip(readings) {
  const src = Array.isArray(readings) && readings.length ? readings : app.readings;
  const first = src[0];
  const last  = src[src.length - 1];
  const bf    = app.currentBf || {};

  const og = bf.og || (app.currentSession && app.currentSession.og);
  $("#strip-og").textContent = fmtSg(og);

  $("#strip-sg").textContent = fmtSg(last && last.sg);
  $("#strip-temp").textContent =
    (last && typeof last.tf === "number") ? `${last.tf.toFixed(1)}\u00b0F` : "-.-\u00b0F";

  $("#strip-count").textContent = String(src.length);

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

// Cutoff (hours) above which we assume the session is archived and
// suppress the DATA STALE banner entirely.  Rationale: the banner is
// a diagnostic for actively-monitored ferments ("your sensor died").
// If the newest reading is more than a day old, the session is
// clearly not being actively polled anymore, so "stale" doesn't
// apply -- the user is running retrospective analysis and the
// CURRENT SG age string ("31.0 d ago") already conveys the fact.
const ARCHIVED_CUTOFF_H = 24;

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
  // Only fire the banner in the "active but stale" band: newer than
  // ARCHIVED_CUTOFF_H (still being polled) but older than stale_hours
  // (poll gap suggests something broke).
  if (ageH < staleH || ageH >= ARCHIVED_CUTOFF_H) {
    banner.classList.add("hidden");
    return;
  }
  text.textContent =
    `Newest reading is ${FG.fmtHours(ageH)} old (threshold ${FG.fmtHours(staleH)}).  Brewer's Friend has no fresher data.`;
  banner.classList.remove("hidden");
}

function renderFgCard(cls) {
  const bar    = $("#fg-status-bar");
  const status = $("#fg-status");
  const hint   = $("#fg-hint");
  const ts     = $("#fg-ts");

  // For Stable, show the final gravity right next to the status label
  // (e.g. "Stable  1.013").  For other statuses, VALUE is "-.---" and
  // adds no info, so omit it.
  const valuePart = (cls.status === "Stable" && cls.value && cls.value !== "-.---")
    ? "  " + cls.value
    : "";
  status.textContent = cls.status + valuePart;

  const hintText = (cls.hint || "").trim();
  hint.textContent = hintText;
  bar.classList.toggle("no-hint", !hintText);

  // Colour the status label per state.
  status.className = "fg-status-value " + statusClass(cls.status);

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
 * Changelog / version display
 *
 * changelog.json is a small file in the repo root, updated by ship.ps1
 * on every push.  Shape:
 *   { "current": "0.1.1",
 *     "entries": [ { "version": "0.1.1", "date": "2026-07-24",
 *                    "notes": ["...", "..."] }, ... ] }
 *
 * Fetched once on page load.  Cache-busted with a Date.now() query
 * param so a freshly-shipped version shows up on the very next page
 * reload without waiting for GH Pages / browser HTTP caches to clear.
 * ------------------------------------------------------------------------- */

async function loadChangelog() {
  const resp = await fetch(`changelog.json?t=${Date.now()}`, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const log = await resp.json();

  // Header version label.
  const label = $("#version-label");
  if (label && log.current) label.textContent = `v${log.current}`;

  // About-tab revision history card.
  const host = $("#rev-history");
  if (!host) return;
  host.innerHTML = "";

  const entries = Array.isArray(log.entries) ? log.entries : [];
  if (!entries.length) {
    host.innerHTML = `<div class="rev-empty">No history yet.</div>`;
    return;
  }

  entries.forEach((e, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "rev-entry";

    const head = document.createElement("div");
    head.className = "rev-entry-head";

    const v = document.createElement("span");
    v.className   = "rev-version";
    v.textContent = `v${e.version || "?"}`;
    head.appendChild(v);

    if (e.date) {
      const d = document.createElement("span");
      d.className   = "rev-date";
      d.textContent = e.date;
      head.appendChild(d);
    }

    if (idx === 0) {
      const tag = document.createElement("span");
      tag.className   = "rev-latest-tag";
      tag.textContent = "latest";
      head.appendChild(tag);
    }

    wrap.appendChild(head);

    const notes = Array.isArray(e.notes) ? e.notes : [];
    if (notes.length) {
      const ul = document.createElement("ul");
      ul.className = "rev-notes";
      for (const n of notes) {
        const li = document.createElement("li");
        li.textContent = n;
        ul.appendChild(li);
      }
      wrap.appendChild(ul);
    }

    host.appendChild(wrap);
  });
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
