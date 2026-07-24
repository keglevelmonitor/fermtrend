/* SG trend chart -- inline SVG, no dependencies.
 *
 * Lifted from FermVault Brain's web/app.js (renderTrendGraph +
 * computeOutlierIndices).  Same layers, same colours, same state-
 * aware garnish bands.
 *
 * Layers, top to bottom in visual priority:
 *   1. Frame + Y/X ticks + labels
 *   2. State garnish band (Stable = green tolerance band around
 *      average, Jittery = red raw-spread band inside the frame)
 *   3. Least-squares slope line (amber dashed)
 *   4. Raw SG polyline (green)
 *   5. Outlier dots (red) at the readings the analyzer would drop
 *      from best_range
 */

import { FG } from "./fg.js";

// Reproduce the k_lo + k_hi split search from FG.diagnostics so we can
// mark the same readings as "dropped" that contribute to best_range.
// Returns a Set of INDEX values into the winPts array.
export function computeOutlierIndices(winPts, outliersUsed) {
  if (!Array.isArray(winPts) || outliersUsed <= 0) return new Set();
  const n = winPts.length;
  if (n < 3) return new Set();
  const withIdx = winPts.map((p, i) => [p[1], i]);
  withIdx.sort((a, b) => a[0] - b[0]);

  let bestKLo = 0;
  let bestRange = Infinity;
  const total = Math.min(outliersUsed, n - 2);
  for (let kLo = 0; kLo <= total; kLo++) {
    const kHi = total - kLo;
    const hiIdx = n - 1 - kHi;
    if (hiIdx <= kLo) continue;
    const r = withIdx[hiIdx][0] - withIdx[kLo][0];
    if (r < bestRange) {
      bestRange = r;
      bestKLo = kLo;
    }
  }
  const kHi = total - bestKLo;
  const outSet = new Set();
  for (let i = 0; i < bestKLo; i++) outSet.add(withIdx[i][1]);
  for (let i = 0; i < kHi; i++)    outSet.add(withIdx[n - 1 - i][1]);
  return outSet;
}

/**
 * Render the SG trend graph.
 *
 * @param {Object}   opts
 * @param {SVGElement}    opts.svg       target <svg id="trend-svg">
 * @param {HTMLElement}   opts.emptyEl   fallback element ("waiting for data")
 * @param {HTMLElement?}  opts.subEl     small subtitle element
 * @param {Array}         opts.readings  ring buffer array-of-{t,sg}
 * @param {Object}        opts.result    output of FG.analyze()
 * @param {Object}        opts.cfg       FG settings block
 * @param {Object}        opts.cls       output of FG.classify()
 */
export function renderTrendGraph({ svg, emptyEl, subEl, readings, result, cfg, cls }) {
  if (!svg || !emptyEl) return;

  const sett   = (result && result.settings) || {};
  const winD   = sett.window_days || (cfg && cfg.window_days) || 3;
  const winS   = winD * 24 * 3600;

  if (!Array.isArray(readings) || !readings.length) {
    svg.innerHTML = "";
    svg.style.display = "none";
    emptyEl.classList.remove("hidden");
    if (subEl) subEl.textContent = "";
    return;
  }
  const lastR   = readings[readings.length - 1];
  const lastTs  = (lastR && typeof lastR === "object") ? (lastR.t || "") : "";
  const anchor  = FG.parseIsoToSec(lastTs);
  const cutoff  = anchor !== null ? anchor - winS : null;
  const winPts  = FG.pointsFromHistory(readings, cutoff);
  if (winPts.length < 2) {
    svg.innerHTML = "";
    svg.style.display = "none";
    emptyEl.classList.remove("hidden");
    if (subEl) subEl.textContent = winPts.length ? "1 reading -- need at least 2" : "";
    return;
  }
  svg.style.display = "";
  emptyEl.classList.add("hidden");

  const t0 = winPts[0][0];
  const t1 = winPts[winPts.length - 1][0];
  const tSpan = Math.max(1, t1 - t0);
  let sgMin = winPts[0][1], sgMax = winPts[0][1];
  for (const p of winPts) {
    if (p[1] < sgMin) sgMin = p[1];
    if (p[1] > sgMax) sgMax = p[1];
  }
  const pad = Math.max((sgMax - sgMin) * 0.05, 0.001);
  sgMin -= pad;
  sgMax += pad;
  const sgSpan = sgMax - sgMin;

  // Pixel-accurate viewBox: match the SVG's real rendered size so
  // "1 SVG unit == 1 CSS pixel".  A fixed viewBox stretched via
  // preserveAspectRatio="none" scales text / dots / stroke widths
  // horizontally along with the container width, which looks
  // oversized next to the rest of the page.  Measuring clientWidth
  // at render time keeps chart elements at their intended physical
  // pixel sizes regardless of card width.
  const VW = Math.max(320, svg.clientWidth  || 900);
  const VH = Math.max(160, svg.clientHeight || 200);
  svg.setAttribute("viewBox", `0 0 ${VW} ${VH}`);

  const L = 44, R = 14, T = 14, B = 24;
  const PW = VW - L - R;
  const PH = VH - T - B;
  const xOf = tSec => L + ((tSec - t0) / tSpan) * PW;
  const yOf = sg   => T + (1 - (sg - sgMin) / sgSpan) * PH;

  const diag = result && result.diagnostics;
  const slopePerHour = (diag && typeof diag.slope_per_hour === "number")
                        ? diag.slope_per_hour
                        : FG.slopePerHour(winPts);
  const meanSg = winPts.reduce((s, p) => s + p[1], 0) / winPts.length;
  const meanT  = winPts.reduce((s, p) => s + p[0], 0) / winPts.length;
  const sg_at = tSec => meanSg + slopePerHour * ((tSec - meanT) / 3600);
  const slopeX1 = xOf(t0), slopeY1 = yOf(sg_at(t0));
  const slopeX2 = xOf(t1), slopeY2 = yOf(sg_at(t1));

  const outliersUsed = (diag && typeof diag.outliers_used === "number")
                        ? diag.outliers_used : 0;
  const outSet = computeOutlierIndices(winPts, outliersUsed);

  const tickVals = [sgMin, (sgMin + sgMax) / 2, sgMax];
  const tLabel = tSec => {
    const d = new Date(tSec * 1000);
    const p = n => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const parts = [];
  parts.push(`<rect x="${L}" y="${T}" width="${PW}" height="${PH}" fill="none" class="trend-axis"/>`);

  // State-aware garnish band
  const status = (cls && cls.status) || "";
  const clampY = y => Math.max(T, Math.min(T + PH, y));
  if (status === "Stable") {
    const avg = (typeof cls.average_sg === "number")
                 ? cls.average_sg
                 : ((diag && (diag.window_start_sg + diag.window_end_sg) / 2)
                    || (sgMin + sgSpan / 2));
    const tol = Number(sett.tolerance) || Number((cfg && cfg.tolerance)) || 0.0005;
    const yTop = clampY(yOf(avg + tol));
    const yBot = clampY(yOf(avg - tol));
    parts.push(
      `<rect class="trend-band-stable" x="${L}" y="${yTop.toFixed(1)}" `
      + `width="${PW}" height="${(yBot - yTop).toFixed(1)}"/>`
    );
    parts.push(
      `<text class="trend-band-label" x="${VW - R - 4}" y="${(yTop - 2).toFixed(1)}" `
      + `text-anchor="end">${"\u00b1"}${tol.toFixed(4)} tolerance</text>`
    );
  } else if (status === "Jittery Readings") {
    const winLo = (diag && typeof diag.window_min === "number")
                   ? diag.window_min : sgMin + pad;
    const winHi = (diag && typeof diag.window_max === "number")
                   ? diag.window_max : sgMax - pad;
    const yTop = clampY(yOf(winHi));
    const yBot = clampY(yOf(winLo));
    parts.push(
      `<rect class="trend-band-jittery" x="${L}" y="${yTop.toFixed(1)}" `
      + `width="${PW}" height="${(yBot - yTop).toFixed(1)}"/>`
    );
    const rawSpread = Math.abs(winHi - winLo);
    parts.push(
      `<text class="trend-band-label" x="${VW - R - 4}" y="${(yTop - 2).toFixed(1)}" `
      + `text-anchor="end">raw spread ${rawSpread.toFixed(4)}</text>`
    );
  }

  for (const v of tickVals) {
    const y = yOf(v);
    parts.push(`<line x1="${L}" y1="${y}" x2="${VW - R}" y2="${y}" class="trend-tick"/>`);
    parts.push(`<text x="${L - 4}" y="${y + 3}" text-anchor="end" class="trend-tick-label">${v.toFixed(4)}</text>`);
  }
  parts.push(`<text x="${L}" y="${VH - 6}" text-anchor="start" class="trend-tick-label">${tLabel(t0)}</text>`);
  parts.push(`<text x="${VW - R}" y="${VH - 6}" text-anchor="end" class="trend-tick-label">${tLabel(t1)}</text>`);

  parts.push(`<line class="trend-slope" x1="${slopeX1.toFixed(1)}" y1="${slopeY1.toFixed(1)}" x2="${slopeX2.toFixed(1)}" y2="${slopeY2.toFixed(1)}"/>`);

  let poly = "";
  for (let i = 0; i < winPts.length; i++) {
    if (i) poly += " ";
    poly += `${xOf(winPts[i][0]).toFixed(1)},${yOf(winPts[i][1]).toFixed(1)}`;
  }
  parts.push(`<polyline class="trend-line" points="${poly}"/>`);

  for (const idx of outSet) {
    const p = winPts[idx];
    if (!p) continue;
    parts.push(`<circle class="trend-outlier" cx="${xOf(p[0]).toFixed(1)}" cy="${yOf(p[1]).toFixed(1)}" r="4"/>`);
  }

  svg.innerHTML = parts.join("");

  if (subEl) {
    const slopePerDay = slopePerHour * 24;
    const dir = Math.abs(slopePerDay) < 0.0001
                ? "steady"
                : (slopePerDay < 0 ? "dropping" : "rising");
    const spanH = (t1 - t0) / 3600;
    const spanStr = spanH < 24
                    ? `${spanH.toFixed(1)} h`
                    : `${(spanH / 24).toFixed(1)} d`;
    subEl.textContent =
      `${winPts.length} pts \u00b7 ${spanStr} \u00b7 slope ${slopePerDay >= 0 ? "+" : ""}${slopePerDay.toFixed(4)} SG/d (${dir})`;
  }
}
