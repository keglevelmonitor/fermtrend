/* SG trend chart -- inline SVG, no dependencies.
 *
 * Display modes:
 *   "window" -- FG analysis window only (+ slope / outliers / bands)
 *   "full"   -- fetched span up to 28d (+ analysis-window shade)
 *
 * Optional temperature overlay (tf stored as Fahrenheit at ingest):
 *   left Y-axis = temp (blue), right Y-axis = SG (green).
 *   Unit toggle converts F <-> C at draw time only.
 */

import { FG } from "./fg.js";

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

function fToDisplay(f, unit) {
  return unit === "C" ? (f - 32) * 5 / 9 : f;
}

function fmtTempTick(v, unit) {
  return unit === "C" ? v.toFixed(1) : v.toFixed(1);
}

// Build [tSec, tempF, tsStr] triples for readings that have a numeric tf.
function tempPointsFromHistory(readings, cutoffSec, endSec) {
  const pts = [];
  for (const r of readings) {
    if (!r || typeof r !== "object") continue;
    const tf = r.tf;
    if (typeof tf !== "number" || !isFinite(tf)) continue;
    const tsStr = r.t || "";
    const t = FG.parseIsoToSec(tsStr);
    if (t === null) continue;
    if (cutoffSec !== null && cutoffSec !== undefined && t < cutoffSec) continue;
    if (endSec !== null && endSec !== undefined && t > endSec) continue;
    pts.push([t, tf, tsStr]);
  }
  pts.sort((a, b) => a[0] - b[0]);
  return pts;
}

// Module-level drag state so pointermove survives SVG re-renders.
let _windowDrag = null;

function clientToSvgX(svg, clientX) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width) return 0;
  const vb = svg.viewBox.baseVal;
  const vw = (vb && vb.width) ? vb.width : svg.clientWidth || 900;
  return ((clientX - rect.left) / rect.width) * vw;
}

function clampAnalysisEnd(endSec, dataT0, dataT1, winS) {
  const minEnd = dataT0 + winS;
  const maxEnd = dataT1;
  if (minEnd >= maxEnd) return maxEnd;
  return Math.max(minEnd, Math.min(maxEnd, endSec));
}

/**
 * @param {Object}   opts
 * @param {SVGElement}    opts.svg
 * @param {HTMLElement}   opts.emptyEl
 * @param {HTMLElement?}  opts.subEl
 * @param {Array}         opts.readings
 * @param {Object}        opts.result
 * @param {Object}        opts.cfg
 * @param {Object}        opts.cls
 * @param {"window"|"full"} opts.mode
 * @param {boolean}       opts.showTemp
 * @param {"F"|"C"}       opts.tempUnit
 * @param {boolean}       opts.compensated
 * @param {number|null}   opts.analysisEndSec  right edge of analysis window (Unix s); null = newest
 * @param {function?}     opts.onAnalysisEndChange  (endSec|null) => void
 * @param {function?}     opts.onWindowDaysChange   (days:int 1..6) => void
 */
export function renderTrendGraph({
  svg, emptyEl, subEl, readings, result, cfg, cls, mode,
  showTemp = false, tempUnit = "F", compensated = false,
  analysisEndSec = null, onAnalysisEndChange = null, onWindowDaysChange = null,
}) {
  if (!svg || !emptyEl) return;

  const sett   = (result && result.settings) || {};
  const winD   = sett.window_days || (cfg && cfg.window_days) || 3;
  const winS   = winD * 24 * 3600;
  const isFull = mode === "full";
  const unit   = tempUnit === "C" ? "C" : "F";

  if (!Array.isArray(readings) || !readings.length) {
    svg.innerHTML = "";
    svg.style.display = "none";
    emptyEl.classList.remove("hidden");
    if (subEl) subEl.textContent = "";
    return;
  }

  const lastR   = readings[readings.length - 1];
  const lastTs  = (lastR && typeof lastR === "object") ? (lastR.t || "") : "";
  const dataNewest = FG.parseIsoToSec(lastTs);
  if (dataNewest === null) {
    svg.innerHTML = "";
    svg.style.display = "none";
    emptyEl.classList.remove("hidden");
    return;
  }

  // Analysis window right edge: user drag override, else newest sample.
  let analysisRef = (typeof analysisEndSec === "number" && isFinite(analysisEndSec))
    ? analysisEndSec
    : dataNewest;
  if (analysisRef > dataNewest) analysisRef = dataNewest;
  const winCutoff = analysisRef - winS;

  const winPts = FG.pointsFromHistory(readings, winCutoff, analysisRef);

  // Full = entire fetched span; Window = the analysis window only.
  const plotCutoff = isFull ? null : winCutoff;
  const plotEnd    = isFull ? null : analysisRef;
  const plotPts = FG.pointsFromHistory(readings, plotCutoff, plotEnd);
  const tempPtsRaw = showTemp
    ? tempPointsFromHistory(readings, plotCutoff, plotEnd)
    : [];
  const drawTemp = showTemp && tempPtsRaw.length >= 2;

  if (plotPts.length < 2) {
    svg.innerHTML = "";
    svg.style.display = "none";
    emptyEl.classList.remove("hidden");
    if (subEl) subEl.textContent = plotPts.length ? "1 reading -- need at least 2" : "";
    return;
  }
  svg.style.display = "";
  emptyEl.classList.add("hidden");

  const t0 = plotPts[0][0];
  const t1 = plotPts[plotPts.length - 1][0];
  const tSpan = Math.max(1, t1 - t0);

  // For Full-mode drag clamps we need the full-span extents even when
  // plotting Window mode (drag only active in Full).
  const fullPts = isFull ? plotPts : FG.pointsFromHistory(readings, null, null);
  const dataT0 = fullPts.length ? fullPts[0][0] : t0;
  const dataT1 = fullPts.length ? fullPts[fullPts.length - 1][0] : t1;

  // SG bounds (true data min/max + tight pad)
  let dataMin = plotPts[0][1], dataMax = plotPts[0][1];
  for (const p of plotPts) {
    if (p[1] < dataMin) dataMin = p[1];
    if (p[1] > dataMax) dataMax = p[1];
  }
  const dataSpan = Math.max(dataMax - dataMin, 1e-6);
  const pad = Math.max(dataSpan * 0.02, 0.0002);
  const sgMin = dataMin - pad;
  const sgMax = dataMax + pad;
  const sgSpan = sgMax - sgMin;

  // Temp bounds in display units
  let tempDispMin = 0, tempDispMax = 1, tempSpan = 1;
  if (drawTemp) {
    let tMin = tempPtsRaw[0][1], tMax = tempPtsRaw[0][1];
    for (const p of tempPtsRaw) {
      if (p[1] < tMin) tMin = p[1];
      if (p[1] > tMax) tMax = p[1];
    }
    const tMinD = fToDisplay(tMin, unit);
    const tMaxD = fToDisplay(tMax, unit);
    // Ensure min < max even if inverted after C conversion of equal F
    const lo = Math.min(tMinD, tMaxD);
    const hi = Math.max(tMinD, tMaxD);
    const tSpanD = Math.max(hi - lo, unit === "C" ? 0.2 : 0.5);
    const tPad = Math.max(tSpanD * 0.02, unit === "C" ? 0.1 : 0.2);
    tempDispMin = lo - tPad;
    tempDispMax = hi + tPad;
    tempSpan = tempDispMax - tempDispMin;
  }

  const VW = Math.max(320, svg.clientWidth  || 900);
  const VH = Math.max(160, svg.clientHeight || 200);
  svg.setAttribute("viewBox", `0 0 ${VW} ${VH}`);

  // Dual-axis layout when temp is drawn: temp left, SG right.
  const L = drawTemp ? 48 : 44;
  const R = drawTemp ? 52 : 14;
  const T = 14, B = 24;
  const PW = VW - L - R;
  const PH = VH - T - B;
  const xOf = tSec => L + ((tSec - t0) / tSpan) * PW;
  const yOfSg = sg => T + (1 - (sg - sgMin) / sgSpan) * PH;
  const yOfTemp = td => T + (1 - (td - tempDispMin) / tempSpan) * PH;
  const clampX = x => Math.max(L, Math.min(L + PW, x));
  const clampY = y => Math.max(T, Math.min(T + PH, y));

  const diag = result && result.diagnostics;
  const sgTicks = [dataMin, (dataMin + dataMax) / 2, dataMax];
  const tLabel = tSec => {
    const d = new Date(tSec * 1000);
    const p = n => String(n).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  const parts = [];
  parts.push(`<rect x="${L}" y="${T}" width="${PW}" height="${PH}" fill="none" class="trend-axis"/>`);

  // Window shade is drawn later (on top) in Full mode so it receives
  // pointer events above the polylines.
  let fullWindowShade = null;
  if (isFull) {
    const w0 = clampX(xOf(Math.max(dataT0, analysisRef - winS)));
    const w1 = clampX(xOf(analysisRef));
    const ww = Math.max(0, w1 - w0);
    if (ww > 0) {
      fullWindowShade = { w0, w1, ww };
    }
  } else {
    const status = (cls && cls.status) || "";
    if (status === "Stable") {
      const avg = (typeof cls.average_sg === "number")
                   ? cls.average_sg
                   : ((diag && (diag.window_start_sg + diag.window_end_sg) / 2)
                      || (sgMin + sgSpan / 2));
      const tol = Number(sett.tolerance) || Number((cfg && cfg.tolerance)) || 0.0005;
      const yTop = clampY(yOfSg(avg + tol));
      const yBot = clampY(yOfSg(avg - tol));
      parts.push(
        `<rect class="trend-band-stable" x="${L}" y="${yTop.toFixed(1)}" `
        + `width="${PW}" height="${(yBot - yTop).toFixed(1)}"/>`
      );
      parts.push(
        `<text class="trend-band-label" x="${(VW - R - 4).toFixed(1)}" y="${(yTop - 2).toFixed(1)}" `
        + `text-anchor="end">${"\u00b1"}${tol.toFixed(4)} tolerance</text>`
      );
    } else if (status === "Jittery Readings") {
      const winLo = (diag && typeof diag.window_min === "number")
                     ? diag.window_min : dataMin;
      const winHi = (diag && typeof diag.window_max === "number")
                     ? diag.window_max : dataMax;
      const yTop = clampY(yOfSg(winHi));
      const yBot = clampY(yOfSg(winLo));
      parts.push(
        `<rect class="trend-band-jittery" x="${L}" y="${yTop.toFixed(1)}" `
        + `width="${PW}" height="${(yBot - yTop).toFixed(1)}"/>`
      );
      const rawSpread = Math.abs(winHi - winLo);
      parts.push(
        `<text class="trend-band-label" x="${(VW - R - 4).toFixed(1)}" y="${(yTop - 2).toFixed(1)}" `
        + `text-anchor="end">raw spread ${rawSpread.toFixed(4)}</text>`
      );
    }
  }

  // Horizontal grid + axis labels
  if (drawTemp) {
    // Temp tick labels use true data min/mid/max in display units
    // (same policy as SG ticks), not the padded plot extremes.
    let tMinF = tempPtsRaw[0][1], tMaxF = tempPtsRaw[0][1];
    for (const p of tempPtsRaw) {
      if (p[1] < tMinF) tMinF = p[1];
      if (p[1] > tMaxF) tMaxF = p[1];
    }
    const td0 = fToDisplay(tMinF, unit);
    const td1 = fToDisplay(tMaxF, unit);
    const tLo = Math.min(td0, td1);
    const tHi = Math.max(td0, td1);
    const tempTickVals = [tLo, (tLo + tHi) / 2, tHi];

    for (const v of sgTicks) {
      const y = yOfSg(v);
      parts.push(`<line x1="${L}" y1="${y}" x2="${VW - R}" y2="${y}" class="trend-tick"/>`);
      parts.push(
        `<text x="${(VW - R + 4).toFixed(1)}" y="${y + 3}" text-anchor="start" `
        + `class="trend-tick-label trend-tick-sg">${v.toFixed(4)}</text>`
      );
    }
    for (const v of tempTickVals) {
      const y = yOfTemp(v);
      parts.push(
        `<text x="${(L - 4).toFixed(1)}" y="${y + 3}" text-anchor="end" `
        + `class="trend-tick-label trend-tick-temp">${fmtTempTick(v, unit)}${"\u00b0"}${unit}</text>`
      );
    }
  } else {
    for (const v of sgTicks) {
      const y = yOfSg(v);
      parts.push(`<line x1="${L}" y1="${y}" x2="${VW - R}" y2="${y}" class="trend-tick"/>`);
      parts.push(
        `<text x="${(L - 4).toFixed(1)}" y="${y + 3}" text-anchor="end" `
        + `class="trend-tick-label">${v.toFixed(4)}</text>`
      );
    }
  }

  parts.push(`<text x="${L}" y="${VH - 6}" text-anchor="start" class="trend-tick-label">${tLabel(t0)}</text>`);
  parts.push(`<text x="${VW - R}" y="${VH - 6}" text-anchor="end" class="trend-tick-label">${tLabel(t1)}</text>`);

  // Slope + outliers only in window mode (SG / classifier).
  if (!isFull && winPts.length >= 2) {
    const slopePerHour = (diag && typeof diag.slope_per_hour === "number")
                          ? diag.slope_per_hour
                          : FG.slopePerHour(winPts);
    const meanSg = winPts.reduce((s, p) => s + p[1], 0) / winPts.length;
    const meanT  = winPts.reduce((s, p) => s + p[0], 0) / winPts.length;
    const sg_at = tSec => meanSg + slopePerHour * ((tSec - meanT) / 3600);
    const slopeX1 = xOf(winPts[0][0]), slopeY1 = yOfSg(sg_at(winPts[0][0]));
    const slopeX2 = xOf(winPts[winPts.length - 1][0]);
    const slopeY2 = yOfSg(sg_at(winPts[winPts.length - 1][0]));
    parts.push(`<line class="trend-slope" x1="${slopeX1.toFixed(1)}" y1="${slopeY1.toFixed(1)}" x2="${slopeX2.toFixed(1)}" y2="${slopeY2.toFixed(1)}"/>`);

    const outliersUsed = (diag && typeof diag.outliers_used === "number")
                          ? diag.outliers_used : 0;
    const outSet = computeOutlierIndices(winPts, outliersUsed);
    for (const idx of outSet) {
      const p = winPts[idx];
      if (!p) continue;
      parts.push(`<circle class="trend-outlier" cx="${xOf(p[0]).toFixed(1)}" cy="${yOfSg(p[1]).toFixed(1)}" r="4"/>`);
    }
  }

  // Temp polyline under SG so gravity stays the visual hero.
  if (drawTemp) {
    let tpoly = "";
    for (let i = 0; i < tempPtsRaw.length; i++) {
      if (i) tpoly += " ";
      const td = fToDisplay(tempPtsRaw[i][1], unit);
      tpoly += `${xOf(tempPtsRaw[i][0]).toFixed(1)},${yOfTemp(td).toFixed(1)}`;
    }
    parts.push(`<polyline class="trend-temp-line" points="${tpoly}"/>`);
  }

  let poly = "";
  for (let i = 0; i < plotPts.length; i++) {
    if (i) poly += " ";
    poly += `${xOf(plotPts[i][0]).toFixed(1)},${yOfSg(plotPts[i][1]).toFixed(1)}`;
  }
  parts.push(`<polyline class="trend-line" points="${poly}"/>`);

  // Full-mode window shade + hit targets on top of the data.
  // Body drag moves the window; left handle resizes (integer days).
  if (fullWindowShade) {
    const { w0, w1, ww } = fullWindowShade;
    parts.push(
      `<rect class="trend-window-region" id="trend-window-hit" x="${w0.toFixed(1)}" y="${T}" `
      + `width="${ww.toFixed(1)}" height="${PH}" `
      + `style="cursor:grab"/>`
    );
    // Left-edge resize handle (~10 SVG px wide, full plot height).
    const handleW = 10;
    const hx = Math.max(L, w0 - handleW / 2);
    parts.push(
      `<rect class="trend-window-handle" id="trend-window-resize" `
      + `x="${hx.toFixed(1)}" y="${T}" width="${handleW}" height="${PH}" `
      + `style="cursor:ew-resize"/>`
    );
    parts.push(
      `<text class="trend-band-label trend-window-label" x="${((w0 + w1) / 2).toFixed(1)}" y="${(T + 12).toFixed(1)}" `
      + `text-anchor="middle">${winD}d window \u00b7 drag / resize</text>`
    );
  }

  svg.innerHTML = parts.join("");

  if (subEl) {
    const spanH = (t1 - t0) / 3600;
    const spanStr = spanH < 24
                    ? `${spanH.toFixed(1)} h`
                    : `${(spanH / 24).toFixed(1)} d`;
    let base;
    if (isFull) {
      base = `${plotPts.length} pts \u00b7 ${spanStr} \u00b7 full ferment`
        + (winPts.length ? ` \u00b7 window ${winPts.length} pts` : "");
    } else {
      const slopePerHour = (diag && typeof diag.slope_per_hour === "number")
                            ? diag.slope_per_hour
                            : FG.slopePerHour(plotPts);
      const slopePerDay = slopePerHour * 24;
      const dir = Math.abs(slopePerDay) < 0.0001
                  ? "steady"
                  : (slopePerDay < 0 ? "dropping" : "rising");
      base = `${plotPts.length} pts \u00b7 ${spanStr} \u00b7 slope ${slopePerDay >= 0 ? "+" : ""}${slopePerDay.toFixed(4)} SG/d (${dir})`;
    }
    if (showTemp && !drawTemp) {
      base += " \u00b7 no temp data";
    } else if (drawTemp) {
      base += ` \u00b7 temp ${tempPtsRaw.length} pts (\u00b0${unit})`;
    }
    if (compensated) {
      base += " \u00b7 SG @ 68\u00b0F";
    }
    if (isFull && typeof analysisEndSec === "number") {
      base += " \u00b7 window moved";
    }
    subEl.textContent = base;
  }

  // Full-mode interactions:
  //   body drag  -> move window (fixed width)
  //   left handle -> resize width in integer days 1..6 (right edge fixed)
  //   double-click body -> snap right edge to newest sample
  if (isFull) {
    const hit = svg.querySelector("#trend-window-hit");
    const handle = svg.querySelector("#trend-window-resize");

    if (hit && typeof onAnalysisEndChange === "function") {
      hit.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        // Ignore if the event originated on the resize handle
        // (handle is drawn on top and has its own listener).
        if (e.target && e.target.id === "trend-window-resize") return;
        e.preventDefault();
        e.stopPropagation();
        const svgX = clientToSvgX(svg, e.clientX);
        const tAt = t0 + ((svgX - L) / PW) * tSpan;
        _windowDrag = {
          mode: "move",
          svg,
          grabDelta: analysisRef - tAt,
          winS,
          dataT0,
          dataT1,
          L, PW, t0, tSpan,
          onChange: onAnalysisEndChange,
        };
        hit.style.cursor = "grabbing";
        _bindWindowDragListeners();
      });
      hit.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onAnalysisEndChange(null);
      });
    }

    if (handle && typeof onWindowDaysChange === "function") {
      handle.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        _windowDrag = {
          mode: "resize",
          svg,
          fixedEnd: analysisRef,
          dataT0,
          dataT1,
          L, PW, t0, tSpan,
          lastDays: winD,
          onDaysChange: onWindowDaysChange,
        };
        _bindWindowDragListeners();
      });
    }
  }
}

function _bindWindowDragListeners() {
  document.addEventListener("pointermove", _onWindowDragMove);
  document.addEventListener("pointerup", _onWindowDragEnd);
  document.addEventListener("pointercancel", _onWindowDragEnd);
}

function _onWindowDragMove(e) {
  if (!_windowDrag) return;
  _windowDrag.lastEvent = e;
  if (_windowDrag.raf) return;
  _windowDrag.raf = requestAnimationFrame(() => {
    if (!_windowDrag || !_windowDrag.lastEvent) return;
    const ev = _windowDrag.lastEvent;
    _windowDrag.raf = 0;
    const d = _windowDrag;
    const svgX = clientToSvgX(d.svg, ev.clientX);
    const tAt = d.t0 + ((svgX - d.L) / d.PW) * d.tSpan;

    if (d.mode === "resize") {
      // Right edge fixed; left edge follows pointer.  Snap to integer
      // days in [1, 6], and never extend left of the data start.
      const spanSec = Math.max(0, d.fixedEnd - tAt);
      let days = Math.round(spanSec / 86400);
      const maxByData = Math.max(1, Math.floor((d.fixedEnd - d.dataT0) / 86400));
      days = Math.max(1, Math.min(6, Math.min(days, maxByData)));
      if (days !== d.lastDays) {
        d.lastDays = days;
        d.onDaysChange(days);
      }
      return;
    }

    // mode === "move"
    let endSec = tAt + d.grabDelta;
    endSec = clampAnalysisEnd(endSec, d.dataT0, d.dataT1, d.winS);
    // Snap to "newest" (null) when within ~30 minutes of the end so
    // the default live-anchor behaviour returns cleanly.
    if (d.dataT1 - endSec < 1800) {
      d.onChange(null);
    } else {
      d.onChange(endSec);
    }
  });
}

function _onWindowDragEnd() {
  if (_windowDrag && _windowDrag.svg) {
    const hit = _windowDrag.svg.querySelector("#trend-window-hit");
    if (hit) hit.style.cursor = "grab";
  }
  _windowDrag = null;
  document.removeEventListener("pointermove", _onWindowDragMove);
  document.removeEventListener("pointerup", _onWindowDragEnd);
  document.removeEventListener("pointercancel", _onWindowDragEnd);
}
