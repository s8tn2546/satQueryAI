"""SAR-specific analytics: value-representation detection, polarization
resolution and per-polarization statistics.

The rest of the fusion path treats SAR as "one band of numbers". This module
makes the SAR side *scientifically explicit*:

* :func:`classify_sar_representation` decides, from evidence only, whether SAR
  values are linear amplitude, linear power/intensity, dB backscatter, or
  unknown/unverified. It never guesses the representation from value ranges.
* :func:`resolve_sar_polarizations` maps band descriptions to VV/VH/HH/HV roles
  strictly from explicit metadata. Composite descriptions (VVVH / VV_VH) are
  reported as composites and never counted as a clean single polarization.
* :func:`band_stats` and :func:`relationship_metrics` compute statistics whose
  interpretation depends on the representation and are withheld when that
  interpretation would not be valid.

Rules enforced here:
  * no fabricated values, no fabricated units, no fabricated polarization
  * ambiguous representation is marked ``unknown``/``unverified`` and never
    silently converted
  * a physical VV/VH *ratio* is only exposed when representation is a known
    linear scale (power or amplitude); a ratio of dB values is not a backscatter
    ratio and is withheld

``tif``-style tag evidence examples (both honoured): dataset tags
(``UNITS=dB`` / ``REPRESENTATION=backscatter dB``) and band descriptions with a
unit suffix (``VV (dB)``).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from app.preprocessing.band_detection import detect_bands_from_metadata

# Canonical SAR value-representation identifiers.
REP_LINEAR_AMPLITUDE = "linear_amplitude"
REP_LINEAR_POWER = "linear_power"
REP_DB = "db"
REP_UNKNOWN = "unknown"

LINEAR_REPRESENTATIONS = frozenset({REP_LINEAR_AMPLITUDE, REP_LINEAR_POWER})

# Human-readable units per representation. Only these are ever reported; an
# unknown representation is honestly reported as unverified native values.
REP_UNITS = {
    REP_LINEAR_AMPLITUDE: "linear amplitude (native raster values)",
    REP_LINEAR_POWER: "linear power / intensity (native raster values)",
    REP_DB: "dB (backscatter)",
    REP_UNKNOWN: "native raster values (unit unverified)",
}

# Single-polarization band descriptions we can attribute with certainty.
POL_ROLES = ("vv", "vh", "hh", "hv")
COMPOSITE_POL_NAMES = frozenset({"vvvh", "vv_vh", "hh_hv", "vh_hv"})

# Prefixes/suffixes stripped (evidence-present in the file description) so a
# description such as "sigma0_VV_db" still resolves to VV while never guessing
# the polarization from a band's position.
_POL_PREFIXES = (
    "sigma0_", "gamma0_", "sigma_nought_", "gamma_nought_",
    "dn_", "amplitude_", "power_", "intensity_",
)

# Dataset tag keys inspected for a declared unit/representation.
_REP_TAG_KEYS = (
    "units", "unit", "representation", "value_units", "sar_representation",
    "unit_description", "data_units",
)


class SarValidationError(Exception):
    """Raised when SAR input violates an explicit structural requirement."""


def _normalize_claim(value: str) -> str:
    return (
        value.lower().strip()
        .replace(" ", "_")
        .replace("-", "_")
        .replace("+", "_")
    )


def _map_rep_claim(value: str) -> str | None:
    """Map a raw unit/representation claim to a canonical representation.

    Returns None when the claim does not unambiguously name a representation
    (e.g. ``gamma0`` alone is ambiguous between linear and dB). ``None`` is a
    "no evidence", never a guess.
    """
    norm = _normalize_claim(value)
    has_db = "db" in norm or "decibel" in norm
    has_power = any(k in norm for k in ("power", "intensity", "linear_power"))
    has_amplitude = any(k in norm for k in ("amplitude", "magnitude", "linear_amplitude", "sqrt"))

    if has_db:
        return REP_DB
    if has_power and has_amplitude:
        return None
    if has_power:
        return REP_LINEAR_POWER
    if has_amplitude:
        return REP_LINEAR_AMPLITUDE
    return None


def _pol_from_description(desc: str) -> str | None:
    """Return the polarization named by a band description, or None.

    Only explicit descriptions map; position is never used. Composites
    (``VVVH``/``VV_VH``/``VV+VH``/``HH_HV``) return ``"composite"``.
    """
    norm = _normalize_claim(desc or "")
    for prefix in _POL_PREFIXES:
        if norm.startswith(prefix):
            norm = norm[len(prefix):]
    for suffix in ("_db", "_decibel", "_amp", "_power", "(db)", "(decibel)", "(amp)", "(power)"):
        if norm.endswith(suffix):
            norm = norm[:-len(suffix)]
            break
    norm = norm.rstrip("_").lstrip("_")
    if norm in COMPOSITE_POL_NAMES:
        return "composite"
    if norm in POL_ROLES:
        return norm
    return None


def resolve_sar_polarizations(descriptions: list[str], band_count: int) -> dict[str, Any]:
    """Map SAR bands to polarization roles from explicit metadata.

    Returns::

        {
          "vv": int | None, "vh": int | None, "hh": int | None, "hv": int | None,
          "composite": [int, ...],
          "unidentified": [int, ...],
          "method": "descriptions" | "none",
        }

    No two bands may claim the same polarization; a duplicate maps to its first
    occurrence only. Bands with no description, or with a description that does
    not name a polarization, are listed in ``unidentified`` — never guessed.
    """
    result: dict[str, Any] = {
        "vv": None, "vh": None, "hh": None, "hv": None,
        "composite": [], "unidentified": [],
        "method": "descriptions" if any(d and d.strip() for d in descriptions) else "none",
    }
    seen: dict[str, int] = {}
    for i, desc in enumerate(descriptions, start=1):
        role = _pol_from_description(desc)
        if role == "composite":
            result["composite"].append(i)
        elif role in POL_ROLES:
            seen.setdefault(role, i)
        else:
            result["unidentified"].append(i)
    for role in POL_ROLES:
        result[role] = seen.get(role)
    return result


def classify_sar_representation(
    metadata: dict[str, Any],
    *,
    path: str | Path | None = None,
    declared: str | None = None,
) -> dict[str, Any]:
    """Determine the SAR value representation from evidence only.

    Evidence, in priority order:
      1. ``declared`` — the caller explicitly names the representation
         (``"amplitude" | "power" | "db" | "unknown"``); basis ``caller-declared``.
      2. dataset tags read from ``path`` (e.g. ``UNITS=dB``); basis
         ``file-metadata-tags``.
      3. band descriptions carrying a unit suffix (e.g. ``VV (dB)``); basis
         ``band-description``.

    When claims conflict, the representation is reported as ``unknown`` with a
    warning: the system never picks a winner between competing claims.

    Returns a dict::

        {
          "value": REP_*,
          "determined": bool,
          "basis": str,            # "caller-declared" | "file-metadata-tags" |
                                   # "band-description" | "none"
          "units": str,
          "warnings": [str, ...],
        }
    """
    claims: list[tuple[str, str]] = []  # (canonical-value-or-None, basis)

    if declared:
        mapped = _map_rep_claim(declared)
        if mapped is not None:
            claims.append((mapped, "caller-declared"))

    if path is not None:
        try:
            import rasterio

            with rasterio.open(str(path)) as src:
                tags = dict(src.tags())
        except Exception:
            tags = {}
        for key, value in tags.items():
            if _normalize_claim(key) in _REP_TAG_KEYS and isinstance(value, str) and value.strip():
                claims.append((_map_rep_claim(value), "file-metadata-tags"))
                break

    descriptions = metadata.get("descriptions", [])
    for desc in descriptions:
        normalized = _normalize_claim(desc or "")
        for suffix in ("_db", "(db)"):
            if normalized.endswith(suffix):
                claims.append((_map_rep_claim("dB"), "band-description"))
                break

    warnings: list[str] = []
    evidence = [(value, basis) for value, basis in claims if value is not None]
    distinct = {value for value, _ in evidence}

    if len(distinct) == 0:
        value, determined, basis = REP_UNKNOWN, False, "none"
    elif len(distinct) == 1:
        value, basis = next(iter(evidence))
        determined = True
        if len(evidence) > 1:
            bases = {b for _, b in evidence}
            if bases == {"caller-declared", "file-metadata-tags"}:
                basis = "caller-declared (corroborated by file metadata)"
    else:
        value, determined, basis = REP_UNKNOWN, False, "conflicting-claims"
        warnings.append(
            "SAR value representation could not be determined: file metadata and/or "
            "caller declarations contradict each other. Values are reported in "
            "native (unverified) units and no physical conversion is applied."
        )

    if value == REP_UNKNOWN and basis == "none" and not warnings:
        warnings.append(
            "The SAR value representation is unknown/unverified: the file carries no "
            "unit or representation metadata and none was declared. Statistics are "
            "reported in native raster units; no dB/linear conversion is applied and "
            "no physical interpretation is claimed."
        )

    return {
        "value": value,
        "determined": determined,
        "basis": basis,
        "units": REP_UNITS[value],
        "warnings": warnings,
    }


def band_stats(values: np.ndarray, valid: np.ndarray) -> dict[str, float]:
    """Summary statistics over valid pixels of a 1D array of values."""
    vals = values[valid & np.isfinite(values)]
    if vals.size == 0:
        return {
            "mean": 0.0, "median": 0.0, "min": 0.0,
            "max": 0.0, "std": 0.0, "count": 0,
        }
    return {
        "mean": float(np.mean(vals)),
        "median": float(np.median(vals)),
        "min": float(np.min(vals)),
        "max": float(np.max(vals)),
        "std": float(np.std(vals)),
        "count": int(vals.size),
    }


def relationship_metrics(
    vv_values: np.ndarray | None,
    vh_values: np.ndarray | None,
    valid_overlap: np.ndarray,
    representation: dict[str, Any],
) -> dict[str, Any]:
    """Compute the VV/VH relationship when both polarizations are available.

    * ``vv_vh_ratio`` — mean(VV)/mean(VH) of the observed values. Only
      ``meaningful`` when the representation is a known linear scale (power or
      amplitude); on dB values a ratio of magnitudes is not a backscatter ratio,
      so it is withheld with the reason explained.
    * ``vv_vh_pearson`` — linear association between the VV and VH values at
      common valid pixels, in the raster's own value space. Interpreted as an
      association measure only, never as a physical coupling constant.

    Returns::

        {
          "vv_vh_ratio": {"value": float | None, "meaningful": bool,
                          "reason": str | None, "units": str | None},
          "vv_vh_pearson": {"value": float | None, "pixels": int,
                            "interpretation": str},
        }
    """
    ratio = {
        "value": None,
        "meaningful": False,
        "reason": (
            "Both VV and VH are required on a shared valid pixel set in a known "
            "linear representation (power or amplitude)."
        ),
        "units": None,
    }
    pearson = {"value": None, "pixels": 0, "interpretation": "linear association between the VV and VH raster values at common valid pixels (native value space; not a physical coupling constant)"}

    if vv_values is None or vh_values is None:
        ratio["reason"] = "Both VV and VH are required; one or both are absent."
        return {"vv_vh_ratio": ratio, "vv_vh_pearson": pearson}

    valid = valid_overlap & np.isfinite(vv_values) & np.isfinite(vh_values)
    vv = vv_values[valid]
    vh = vh_values[valid]
    if vv.size == 0:
        ratio["reason"] = "No common valid VV/VH pixels exist after masking."
        return {"vv_vh_ratio": ratio, "vv_vh_pearson": pearson}

    rep_value = representation.get("value")
    if rep_value in LINEAR_REPRESENTATIONS:
        vv_mean = float(np.mean(vv))
        vh_mean = float(np.mean(vh))
        if vh_mean != 0 and np.isfinite(vh_mean) and np.isfinite(vv_mean):
            ratio["value"] = float(vv_mean / vh_mean)
            ratio["meaningful"] = True
            ratio["reason"] = None
            ratio["units"] = "unitless ratio of mean values in the observed linear representation"
    else:
        ratio["reason"] = (
            f"The representation is '{rep_value}'; a ratio of observed magnitudes "
            "is not a physically meaningful backscatter ratio unless both VV and "
            "VH are on a known linear scale."
        )

    if vv.shape[0] >= 2 and np.std(vv) > 0 and np.std(vh) > 0:
        pearson["value"] = float(np.corrcoef(vv, vh)[0, 1])
        pearson["pixels"] = int(vv.shape[0])

    return {"vv_vh_ratio": ratio, "vv_vh_pearson": pearson}


def require_polarizations(pol: dict[str, Any], required: list[str]) -> None:
    """Raise ``SarValidationError`` if any required polarization is absent."""
    missing: list[str] = []
    for name in required:
        role = _normalize_claim(name)
        if role in POL_ROLES and pol.get(role) is None:
            missing.append(name.upper())
    if missing:
        found = [r.upper() for r in POL_ROLES if pol.get(r) is not None]
        raise SarValidationError(
            f"Required SAR polarization(s) missing: {', '.join(missing)}. "
            f"Available polarizations in the SAR raster: "
            f"{', '.join(found) if found else 'none identified from metadata'}."
        )