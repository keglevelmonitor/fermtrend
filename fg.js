/* FG stability analyzer -- pure JS, dependency-free.
 *
 * Lifted verbatim from FermVault Brain's web/app.js (the FG object)
 * so results are byte-for-byte identical to what the Brain dashboard
 * shows for the same readings + same knobs.
 *
 * Naming note: "Settling" replaced "Trending" in Brain v0.1.37 --
 * the original label left the question "trending toward what?" open,
 * whereas "settling" reads intuitively as "gravity is slowly
 * approaching equilibrium" for the typical downward case.  The
 * slope-magnitude threshold is unchanged.
 *
 * Consumers should treat readings as: Array<{ t: ISOString, sg: number, tf?: number }>
 * -- the same shape the Brain's ring buffer uses and the same shape
 * bf-client.js normalises BF's raw JSON into.
 */

export const FG = {
  COVERAGE_GRACE_H: 1.0,

  // BF timestamps look like "2026-07-20T12:27:00+00:00" or the space-
  // separated variant "2026-07-20 12:27:00".  Normalise to ISO-8601
  // with an explicit Z when no zone is present (BF's convention is
  // bare UTC) and hand the whole thing to the browser's Date parser.
  // Returns seconds since Unix epoch, or null on any failure.
  parseIsoToSec(s) {
    if (typeof s !== "string" || !s) return null;
    let t = s.trim();
    if (t.indexOf(" ") >= 0 && t.indexOf("T") < 0) t = t.replace(" ", "T");
    if (!/[Zz]|[+\-]\d{2}:?\d{2}$/.test(t)) t += "Z";
    const d = new Date(t);
    const ms = d.getTime();
    return isFinite(ms) ? ms / 1000 : null;
  },

  // Filter+transform readings into (t_seconds, sg, ts_iso_string)
  // triples in chronological order.  If cutoffSec is given, only
  // readings with t >= cutoffSec are kept -- lets analyze() ignore
  // the pre-window tail.
  pointsFromHistory(readings, cutoffSec) {
    const pts = [];
    for (const r of readings) {
      if (!r || typeof r !== "object") continue;
      const sg = r.sg;
      if (typeof sg !== "number" || !isFinite(sg)) continue;
      const tsStr = r.t || "";
      const t = FG.parseIsoToSec(tsStr);
      if (t === null) continue;
      if (cutoffSec !== null && cutoffSec !== undefined && t < cutoffSec) continue;
      pts.push([t, sg, tsStr]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    return pts;
  },

  // Least-squares slope of SG vs time-in-HOURS across a
  // chronologically sorted point list.  Two passes, no intermediate
  // x/y arrays.
  slopePerHour(pts) {
    const n = pts.length;
    if (n < 2) return 0.0;
    const t0 = pts[0][0];
    let sx = 0, sy = 0;
    for (let i = 0; i < n; i++) {
      sx += (pts[i][0] - t0) / 3600.0;
      sy += pts[i][1];
    }
    const mx = sx / n;
    const my = sy / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const dx = (pts[i][0] - t0) / 3600.0 - mx;
      num += dx * (pts[i][1] - my);
      den += dx * dx;
    }
    return den > 0 ? num / den : 0.0;
  },

  // True if the window can be made stable by dropping up to
  // maxOutliers values from the ends of the sorted array.
  windowStable(sortedVals, tolerance, maxOutliers) {
    const n = sortedVals.length;
    for (let k = 0; k <= maxOutliers; k++) {
      const hi = maxOutliers - k;
      if (sortedVals[n - 1 - hi] - sortedVals[k] <= tolerance) return true;
    }
    return false;
  },

  diagnostics(pts, tolerance, maxOutliers) {
    const sorted = pts.map(p => p[1]).sort((a, b) => a - b);
    const n      = sorted.length;
    const rawRange = sorted[n - 1] - sorted[0];

    let bestRange = rawRange;
    let minOutliersToPass = null;
    for (let total = 0; total <= maxOutliers; total++) {
      for (let k = 0; k <= total; k++) {
        const hi = total - k;
        const r  = sorted[n - 1 - hi] - sorted[k];
        if (r < bestRange) bestRange = r;
        if (r <= tolerance && minOutliersToPass === null) minOutliersToPass = total;
      }
    }

    const slopeH = FG.slopePerHour(pts);
    const spanS  = pts[n - 1][0] - pts[0][0];
    const spanH  = spanS / 3600.0;
    return {
      window_start_sg: pts[0][1],
      window_end_sg:   pts[n - 1][1],
      window_min:      sorted[0],
      window_max:      sorted[n - 1],
      raw_range:       rawRange,
      best_range:      bestRange,
      outliers_used:   minOutliersToPass !== null ? minOutliersToPass : maxOutliers,
      ratio:           tolerance > 0 ? bestRange / tolerance : 0.0,
      slope_per_hour:  slopeH,
      slope_per_day:   slopeH * 24.0,
      total_change:    Math.abs(slopeH) * spanH,
      span_hours:      spanH,
      n:               n,
    };
  },

  // Core analyzer.  `readings` is the array-of-{t,sg} readings from
  // bf-client.js; `cfg` is the FG settings object with { tolerance,
  // window_days, max_outliers, min_readings }.
  //
  // Returns:
  //   { stable: bool, error?: string, first_ts?, last_ts?,
  //     average_sg?, diagnostics?: {...}, settings: {...} }
  analyze(readings, cfg) {
    cfg = cfg || {};
    const tol         = Number(cfg.tolerance)      || 0.0005;
    // Window is a whole-day integer (max 6).  Convert to hours for
    // the existing slope math -- the analyzer speaks hours
    // internally because it also computes per-hour slopes.
    const winD        = Math.max(1, Math.min(6, Number(cfg.window_days) || 3));
    const winH        = winD * 24.0;
    const maxout      = Number(cfg.max_outliers)   || 4;
    const minreadings = Number(cfg.min_readings)   || 20;
    const winS        = winH * 3600.0;

    const total = Array.isArray(readings) ? readings.length : 0;
    const settings = {
      tolerance:      tol,
      window_days:    winD,
      window_hours:   winH,   // kept for downstream code that speaks hours
      max_outliers:   maxout,
      min_readings:   minreadings,
      total_readings: total,
    };

    if (!total) return { stable: false, error: "no data", settings };

    // Ring buffer is stored chronologically, so the last entry is
    // newest.  Anchor the analysis window on that timestamp --
    // historical sessions classify meaningfully even weeks after
    // fermentation ended.
    const lastR   = readings[total - 1];
    const lastTs  = (lastR && typeof lastR === "object") ? (lastR.t || "") : "";
    const analysisRef = FG.parseIsoToSec(lastTs);
    const cutoff  = analysisRef !== null ? analysisRef - winS : null;

    const winPts = FG.pointsFromHistory(readings, cutoff);
    settings.window_readings = winPts.length;

    if (!winPts.length) {
      return { stable: false, error: "no data in window", settings };
    }

    const wallNow   = Date.now() / 1000;
    const newestT   = winPts[winPts.length - 1][0];
    const ref       = analysisRef !== null ? analysisRef : newestT;
    const newestAge = Math.max(0.0, (wallNow - newestT) / 3600.0);
    settings.newest_age_h = newestAge;

    const coverageH = (ref - winPts[0][0]) / 3600.0;
    const spanH     = (winPts[winPts.length - 1][0] - winPts[0][0]) / 3600.0;
    settings.coverage_h = coverageH;
    settings.span_hours = spanH;

    // Gate: enough samples in the window
    if (winPts.length < minreadings) {
      const diag = winPts.length >= 2 ? FG.diagnostics(winPts, tol, maxout) : null;
      const out  = { stable: false, error: "not enough readings", settings };
      if (diag) out.diagnostics = diag;
      return out;
    }

    // Gate: window not yet time-covered
    if (coverageH < winH - FG.COVERAGE_GRACE_H) {
      return {
        stable:      false,
        error:       "not enough time",
        diagnostics: FG.diagnostics(winPts, tol, maxout),
        settings,
      };
    }

    // Classify the newest window
    const sgsSorted = winPts.map(p => p[1]).sort((a, b) => a - b);
    if (FG.windowStable(sgsSorted, tol, maxout)) {
      const avg = winPts.reduce((s, p) => s + p[1], 0) / winPts.length;
      return {
        stable:      true,
        first_ts:    winPts[0][2],
        last_ts:     winPts[winPts.length - 1][2],
        average_sg:  avg,
        diagnostics: FG.diagnostics(winPts, tol, maxout),
        settings,
      };
    }

    return {
      stable:      false,
      diagnostics: FG.diagnostics(winPts, tol, maxout),
      settings,
    };
  },

  fmtSg(v)     { return (typeof v === "number") ? v.toFixed(4) : "-.----"; },
  fmtDelta(v)  { return (typeof v === "number") ? Math.abs(v).toFixed(4) : "0.0000"; },
  fmtHours(h)  {
    if (typeof h !== "number" || !isFinite(h)) return "?";
    return h < 24.0 ? `${h.toFixed(1)} h` : `${(h / 24.0).toFixed(1)} d`;
  },

  // Status label + hint.  Vocabulary matches Brain firmware exactly:
  // Stable / Not Enough Readings / Still Fermenting / Settling /
  // Jittery Readings.
  classify(result) {
    if (!result) {
      return { status: "Pending", value: "-.---", average_sg: null,
               first_ts: "", last_ts: "", hint: "" };
    }
    const sett  = result.settings    || {};
    const diag  = result.diagnostics || {};
    const tol   = Number(sett.tolerance)    || 0.0005;
    const winH  = Number(sett.window_hours) || 72.0;
    const midot = " \u00b7 ";

    if (result.stable) {
      const avg   = result.average_sg;
      const bestR = diag.best_range;
      const spanH = diag.span_hours;
      const parts = [];
      if (typeof bestR === "number") parts.push(`spread ${bestR.toFixed(4)}`);
      if (typeof spanH === "number" && spanH > 0) parts.push(`held ${FG.fmtHours(spanH)}`);
      return {
        status:     "Stable",
        value:      typeof avg === "number" ? avg.toFixed(3) : "-.---",
        average_sg: avg,
        first_ts:   result.first_ts || "",
        last_ts:    result.last_ts  || "",
        hint:       parts.join(midot),
      };
    }

    const err = String(result.error || "").toLowerCase();
    if (err === "no data" || err === "no data in window") {
      return { status: "Not Enough Readings", value: "-.---", average_sg: null,
               first_ts: "", last_ts: "", hint: "no readings yet" };
    }

    if (err === "not enough readings" || err === "not enough time") {
      const got   = Number(sett.window_readings) || 0;
      const needR = Number(sett.min_readings)    || 20;
      const covH  = sett.coverage_h;
      const parts = [];
      parts.push(got < needR ? `${got} of ${needR} readings` : `${got} readings`);
      if (typeof covH === "number") {
        parts.push(`${FG.fmtHours(covH)} of ${FG.fmtHours(winH)} covered`);
      }
      return { status: "Not Enough Readings", value: "-.---", average_sg: null,
               first_ts: "", last_ts: "", hint: parts.join(midot) };
    }

    // Full window, not stable -- split on SG/day trend
    const slopeDay = Number(diag.slope_per_day) || 0;
    const absDay   = Math.abs(slopeDay);
    const startSg  = diag.window_start_sg;
    const endSg    = diag.window_end_sg;
    const bestR    = diag.best_range;

    let status;
    if      (absDay >= 10.0 * tol) status = "Still Fermenting";
    else if (absDay >= tol)        status = "Settling";
    else                           status = "Jittery Readings";

    let hint;
    if (status === "Still Fermenting" || status === "Settling") {
      let hi = startSg, lo = endSg;
      if (typeof startSg === "number" && typeof endSg === "number") {
        hi = startSg >= endSg ? startSg : endSg;
        lo = startSg <  endSg ? startSg : endSg;
      }
      const sign      = slopeDay >= 0 ? "+" : "";
      const trendStr  = `${sign}${slopeDay.toFixed(4)} SG/d`;
      hint = `Range ${FG.fmtSg(hi)} to ${FG.fmtSg(lo)}${midot}trend ${trendStr}`;
    } else {
      if (typeof bestR === "number" && tol > 0) {
        hint = `spread ${bestR.toFixed(4)} (${(bestR / tol).toFixed(1)}x tolerance)`;
      } else if (typeof bestR === "number") {
        hint = `spread ${bestR.toFixed(4)}`;
      } else {
        hint = "";
      }
    }

    return { status, value: "-.---", average_sg: null,
             first_ts: "", last_ts: "", hint };
  },

  // Render the full diagnostics text block (multi-line string) shown
  // in the FG diagnostics panel.  Same layout as the FermVault Brain
  // API & FG tab so users can compare side-by-side.
  renderDiagnostics(r) {
    if (!r || typeof r !== "object") return "No result.";

    const settings = r.settings || {};
    const diag     = r.diagnostics || null;
    const cls      = FG.classify(r);
    const stable   = !!r.stable;

    const tol       = Number(settings.tolerance)      || 0;
    const winH      = Number(settings.window_hours)   || 0;
    const maxout    = Number(settings.max_outliers)   || 0;
    const minReads  = Number(settings.min_readings)   || 0;
    const total     = Number(settings.total_readings) || 0;
    const winReads  = Number(settings.window_readings) || 0;
    const coverageH = Number(settings.coverage_h);
    const spanH     = Number(settings.span_hours);
    const newestAge = settings.newest_age_h;

    const fmt4 = v => (typeof v === "number") ? v.toFixed(4) : "-.----";
    const fmt6 = v => (typeof v === "number") ? v.toFixed(6) : "0.000000";
    const fmtH = v => {
      if (typeof v !== "number" || !isFinite(v)) return "?";
      if (v < 24) return `${v.toFixed(1)} h`;
      return `${(v / 24).toFixed(1)} d`;
    };
    const fmtPct = v => (typeof v === "number") ? (v * 100).toFixed(0) + "%" : "?";
    const rule   = "-".repeat(50);
    const lines  = [];

    lines.push("FG Stability Analysis");
    lines.push(rule);

    const status = cls.status || (stable ? "Stable" : "Pending");
    const hint   = cls.hint   || "";
    lines.push(`Status              ${status}${stable ? "  (stable)" : ""}`);
    if (hint) lines.push(`                    ${hint}`);
    lines.push("");

    lines.push("Data");
    lines.push(`  History size      ${total} readings`);
    lines.push(`  Newest age        ${fmtH(newestAge)}`);
    lines.push("");

    lines.push("Analysis window");
    lines.push(`  Requested         ${fmtH(winH)}`);
    lines.push(`  Covered           ${fmtH(coverageH)}  (${winReads} readings)`);
    if (winH > 0 && typeof coverageH === "number") {
      const fillFrac = Math.max(0, Math.min(1, coverageH / winH));
      const barW = 20;
      const filled = Math.round(fillFrac * barW);
      const bar = "[" + "=".repeat(filled) + " ".repeat(barW - filled) + "]";
      lines.push(`  Coverage          ${fmtPct(fillFrac)}  ${bar}`);
    }
    if (winReads < minReads) {
      lines.push(`  Density           ${winReads} of ${minReads} min readings`);
    }
    lines.push("");

    if (diag) {
      const first   = stable ? r.first_ts : null;
      const last    = stable ? r.last_ts  : null;
      const rawR    = diag.raw_range;
      const bestR   = diag.best_range;
      const ratio   = diag.ratio;
      const slopeH  = diag.slope_per_hour;
      const slopeD  = diag.slope_per_day;
      const change  = diag.total_change;
      const outUsed = diag.outliers_used;

      lines.push(stable ? "Stable window" : "Newest window");
      if (first) lines.push(`  First             ${fmt4(diag.window_start_sg)}   ${first}`);
      if (last)  lines.push(`  Last              ${fmt4(diag.window_end_sg)}   ${last}`);
      if (!first && !last) {
        lines.push(`  First SG          ${fmt4(diag.window_start_sg)}`);
        lines.push(`  Last SG           ${fmt4(diag.window_end_sg)}`);
      }
      lines.push(`  Min / Max         ${fmt4(diag.window_min)} / ${fmt4(diag.window_max)}`);
      lines.push(`  Raw range         ${fmt4(rawR)}`);
      if (typeof bestR === "number" && typeof ratio === "number") {
        lines.push(`  Best range        ${fmt4(bestR)}   (${ratio.toFixed(1)}x tolerance)`);
      } else if (typeof bestR === "number") {
        lines.push(`  Best range        ${fmt4(bestR)}`);
      }
      if (typeof outUsed === "number") {
        lines.push(`  Outliers dropped  ${outUsed} of ${maxout} allowed`);
      }
      if (typeof spanH === "number") {
        lines.push(`  Span              ${fmtH(spanH)}`);
      }
      if (typeof slopeD === "number") {
        const dir = slopeD < 0 ? "dropping" : (slopeD > 0 ? "rising" : "flat");
        lines.push(`  Slope             ${(slopeD >= 0 ? "+" : "")}${fmt4(slopeD)} SG/day  (${dir})`);
        if (typeof slopeH === "number") {
          lines.push(`                    ${(slopeH >= 0 ? "+" : "")}${fmt6(slopeH)} SG/hour  (fine)`);
        }
      }
      if (typeof change === "number") {
        lines.push(`  Total change      ${fmt4(change)} SG across window`);
      }
      if (stable && typeof r.average_sg === "number") {
        lines.push(`  Average SG        ${fmt4(r.average_sg)}`);
      }
      lines.push("");
    }

    lines.push("Settings");
    lines.push(`  Tolerance         ${fmt4(tol)}`);
    lines.push(`  Window            ${fmtH(winH)}`);
    lines.push(`  Max outliers      ${maxout}`);
    lines.push(`  Min readings      ${minReads}`);

    return lines.join("\n");
  },
};
