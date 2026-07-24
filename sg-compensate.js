/* Specific-gravity temperature compensation.
 *
 * Readings are stored raw: { t, sg, tf } with tf in Fahrenheit (or
 * null when BF omitted temp).  Compensation is applied in memory only
 * -- IndexedDB keeps the raw values.
 *
 * Calibration temperature: 68 F (Pill / common digital densitometer).
 *
 * Why poly(cal)/poly(temp) and not the glass-hydrometer ratio:
 *   Glass hydrometers read HIGH when cold; the classic BF formula is
 *   sg * poly(temp)/poly(cal) and pulls those readings down.
 *   Digital densitometers (Pill, Tilt, etc.) commonly read LOW during
 *   a cold crash -- the green SG line drops with the blue temp line.
 *   Using the inverse ratio raises cold readings toward the 68 F
 *   equivalent so apparent gravity stays flat when sugar content is
 *   flat.  Points without tf are left unchanged (raw sg).
 */

export const SG_CAL_TEMP_F = 68;

// Cubic used by Brewer's Friend / BeerSmith hydrometer calculators.
function waterPoly(tempF) {
  const t = Number(tempF);
  return (
    1.00130346
    - 0.000134722124 * t
    + 0.00000204052596 * t * t
    - 0.00000000232820948 * t * t * t
  );
}

/**
 * Correct one SG reading to the calibration temperature.
 * @param {number} sg      measured specific gravity
 * @param {number} tempF   sample temperature in Fahrenheit
 * @param {number} [calF]  calibration temperature (default 68)
 * @returns {number|null}  corrected SG, or null if inputs are unusable
 */
export function compensateSg(sg, tempF, calF = SG_CAL_TEMP_F) {
  if (typeof sg !== "number" || !isFinite(sg)) return null;
  if (typeof tempF !== "number" || !isFinite(tempF)) return null;
  const denom = waterPoly(tempF);
  if (!denom) return null;
  return sg * (waterPoly(calF) / denom);
}

/**
 * Return a new readings array with SG corrected where tf is present.
 * Readings without a numeric tf keep their raw sg.  Does not mutate
 * the input.
 */
export function compensateReadings(readings, calF = SG_CAL_TEMP_F) {
  if (!Array.isArray(readings)) return [];
  return readings.map(r => {
    if (!r || typeof r !== "object") return r;
    if (typeof r.tf !== "number" || !isFinite(r.tf)) return r;
    if (typeof r.sg !== "number" || !isFinite(r.sg)) return r;
    const sg = compensateSg(r.sg, r.tf, calF);
    if (sg === null) return r;
    return { t: r.t, sg, tf: r.tf };
  });
}

/** Count readings that have a usable temperature for compensation. */
export function countReadingsWithTemp(readings) {
  if (!Array.isArray(readings)) return 0;
  let n = 0;
  for (const r of readings) {
    if (r && typeof r.tf === "number" && isFinite(r.tf)) n++;
  }
  return n;
}
