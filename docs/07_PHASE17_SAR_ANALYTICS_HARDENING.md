# Phase 17 — SAR-Specific Analytics Hardening (Backend + ML)

Status: **DONE** — all suites green.
ML `pytest`: **559 passed**. Backend `npm test`: **35 suites / 476 passed**.

---

## 1. Objective

Make the Optical+SAR fusion path **scientifically explicit** instead of treating
the SAR side as "one band of numbers". SAR input must be validated, its value
representation detected from evidence only, polarization (VV/VH) identified from
metadata, statistics computed per-polarization on the exact pixels the fusion
describes, and the result contract must never fabricate SAR values, units,
polarization, confidence, or semantic percentages.

Backend + ML service only.

## 2. Scope and boundaries (explicit)

- **No frontend changes.** The response schema is extended additively; the UI
  still consumes the same top-level keys it did before.
- **No fabricated SAR measurements.** Analysis is computed from the raster values
  actually read; nothing is invented, averaged, or scaled to fit a claim.
- **No guessed polarization and no guessed units/CRS.** Polarization comes only
  from explicit band descriptions (position is never used); representation from
  caller declaration, file tags, or band-description suffix — otherwise
  `unknown`/`unverified`, never converted.
- **No STAC acquisition redesign, no async queues, no quantization.**
- **The AOI path is authoritative and unchanged.** The shared
  `aoi_scope`/`attach_aoi_pair` already restricts both inputs; stats run on the
  scoped rasters.
- **Complex (SLC) SAR is rejected**, and an all-invalid SAR band fails the
  request — a missing measurement is an error, not a zero.

## 3. What existed before

The fusion path read a single SAR band (chosen by explicit `sar_band`, a
single-band image, or the first *labelled* band), applied a deterministic 3×3
NaN-aware median speckle filter, reprojected it onto the optical grid when needed,
and reported mean/median/min/max/std/count in **native units with units never
named**. No polarization identity, no value-representation handling, no
per-polarization statistics, no VV/VH relationship, no composite-SLC rejection,
and no all-invalid check. The backend offline fallback returned all-`null`
blocks and honestly reported `mock: true`.

## 4. Hardening contract (evidenced, not guessed)

| Concern | Old behaviour | New behaviour |
|---|---|---|
| Value representation | Never determined | `amplitude` / `power` / `db` / `unknown` from caller-declaration → file tags → band-description suffix; conflicts → `unknown` + warning |
| Physical VV/VH ratio | n/a (single band only) | Reported **only** when representation is a known linear scale (power/amplitude); withheld with a written reason for dB / unknown |
| Polarization identity | Lost | Per-band VV/VH/HH/HV mapped from descriptions; composites (`VV+VH`) reported as composites, never as a clean polarization; unlabelled bands → `unidentified` |
| Per-pol statistics | none | For each present polarization: stats + pixel count over the **shared valid overlap**, in the identified units |
| System fingerprint | `custom/upload` | `Sentinel-1 Ground Range Detected (GRD)` for GEE `COPERNICUS/S1_GRD` (VV/VH, gamma0); custom uploads reported as such, never passed off as real |
| Complex SLC / all-invalid SAR | silently dangerous | Explicit `FusionValidationError` |
| Required polarizations | n/a | `sar_polarizations=VV,VH` enforced: missing required polarization fails, naming the missing and available ones |
| Units | implicit | Reported per representation; `unknown` reports native values as *unverified* |
| Confidence | unchanged | New blocks never inject warnings into `result["warnings"]`, so existing confidence (1.0/0.8/0.0) is preserved |

## 5. What was built

- **New module `ml-service/app/tools/sar_analytics.py`** — representation
  classification (`classify_sar_representation`), polarization resolution
  (`resolve_sar_polarizations`), per-polarization `band_stats`, VV/VH
  `relationship_metrics`, and `require_polarizations` (raises
  `SarValidationError`). Honesty rules are baked in: a physical ratio is only
  meaningful on a known linear scale; Pearson is reported as an association in
  native value space, never as a physical coupling constant.
- **`ml-service/app/tools/fusion.py`** — new `_load_sar_band` helper, complex-SLC
  rejection, resolution-mismatch warning, per-polarization analytics scoped to the
  joint valid mask, SAR all-invalid failure, and additive result blocks:
  `sar.polarization/representation/representation_basis/units`,
  `polarization`, `representation`, `coverage` (total/sar-valid pixels,
  `sar_validation_ratio`, `polarization_availability`, `polarization_composite_bands`,
  `polarization_unidentified_bands`, dtype/nodata, `aoi_scoped`),
  `metrics.relationship`, `fusion.sar_evidence`. Caller-declared
  `sar_representation` is recorded as evidence only — **never used to convert or
  calibrate pixel values**.
- **`ml-service/app/api/optical_sar.py`** — new optional form fields
  `sar_representation` (`amplitude|power|db|unknown`) and `sar_polarizations`
  (`VV,VH,…`) with validation against a whitelist; passes them to fusion and
  enriches `evidence`/`metadata` with the SAR representation and available
  polarizations. Invalid parameter values return the established
  `status: "failed"` + `confidence: 0.0` pattern.
- **Backend** — `backend/src/services/seedTools.js` `optical_sar` outputSchema
  extended additively; the offline `/optical-sar` fallback now also nulls the new
  `polarization` / `representation` / `coverage` / `metrics` blocks and lists them
  in `notComputed` — it reports nothing it did not compute.
- **Tests** — `ml-service/tests/test_sar_analytics.py` (37 tests) and 3 new
  API tests, plus new synthetic fixtures (clearly synthetic; no real data
  downloaded): dB-tagged, amplitude-tagged, ambiguous `sigma0_*`, bare VV/VH,
  all-NaN SAR, complex (SLC) SAR, and composite VV+VH SAR, plus a single-band VV
  raster.

## 6. Representation detection — evidence priority

1. `sar_representation` caller declaration (basis `caller-declared`);
2. GeoTIFF dataset tags `UNITS`/`REPRESENTATION`/… (basis `file-metadata-tags`);
3. band-description unit suffix, e.g. `sigma0_VV_dB` (basis
   `band-description`).

Agreeing claims corroborate; conflicting claims resolve to `unknown` with a
warning. `gamma0`/`sigma0` alone are ambiguous (amplitude vs power vs dB) and are
never interpreted without further evidence. `sar_representation=unknown` is
accepted as "no claim".

## 7. Key design decisions

- **Fusion band vs per-polarization stats are the same pixels.** The analyzed
  fusion band (existing `sar.band`) is still the run-of-the-mill fusion input, but
  every polarization's statistics are computed over the exact joint valid mask,
  so the SAR numbers always describe the pixels the fusion describes.
- **A dB VV/VH "ratio" is never reported as backscatter ratio.** It is exposed as
  a linear association (Pearson) in the raster's own value space, and the physical
  ratio is withheld with the reason written into `metrics.relationship`.
- **No new warnings for labelled-but-unitless SAR.** A file that names
  `VV`/`VH` but carries no unit metadata now reports `representation: unknown`
  (basis `none`) inside its own block — it does not degrade the request's
  confidence, preserving the existing 1.0-confidence tests.
- **No calibration.** The system does not apply a dB conversion or `10*log10`
  transform anywhere; unverified values stay native and are labelled as such.

## 8. Test results

- ML `pytest`: **559 passed** (was 519; +37 SAR analytics, +3 API).
- Backend `jest`: **35 suites / 476 passed** (unchanged, additive schema).
- Fusion + optical-sar endpoint tests: 30 passed (18 pre-existing + 12 endpoint).
- No real satellite data was downloaded; all SAR fixtures are synthetic and
  labelled as such.

## 9. Follow-ups

- Frontend consumption of the new `polarization` / `representation` / `coverage`
  / `metrics` blocks.
- Optional caller-supplied calibration metadata (synthetic aperture radar location
  handling) if a calibrated-dB interpretation is ever required — currently
  deliberately out of scope.