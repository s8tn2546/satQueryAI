"""Band detection and identification.

Identifies what can be safely inferred about raster bands from
available metadata. Does NOT assume band positions — only infers
from explicit metadata, descriptions, wavelength information,
or well-known band name conventions present in the file.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# Well-known band names that may appear in metadata descriptions
KNOWN_BAND_NAMES = {
    "blue", "green", "red", "red_edge", "rededge",
    "nir", "nir1", "nir2", "swir1", "swir2",
    "coastal", "coastal_aerosol",
    "cirrus", "water_vapor",
    "vv", "vh", "vvvh", "vv_vh",
    "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b8a", "b9", "b10", "b11", "b12",
}

# Sentinel-2 band names for reference (1-indexed)
SENTINEL2_BAND_NAMES = {
    1: "coastal_aerosol",
    2: "blue",
    3: "green",
    4: "red",
    5: "red_edge_1",
    6: "red_edge_2",
    7: "red_edge_3",
    8: "nir",
    8: "nir_narrow",
    9: "water_vapor",
    10: "cirrus",
    11: "swir1",
    12: "swir2",
}

# Common SAR polarization names
SAR_POLARIZATIONS = {"vv", "vh", "vvvh", "vv_vh", "hh", "hv", "hh_hv"}


@dataclass
class DetectedBand:
    """Information about a single detected band."""
    index: int
    detected_name: str = ""
    description: str = ""
    wavelength: str = ""
    is_known: bool = False


@dataclass
class BandDetectionResult:
    """Result of band detection analysis."""
    bands: list[DetectedBand] = field(default_factory=list)
    unknown_band_count: int = 0
    detection_method: str = "none"
    warnings: list[str] = field(default_factory=list)
    has_required_optical_bands: bool = False
    has_required_sar_bands: bool = False


def detect_bands_from_metadata(
    band_descriptions: list[str],
    band_count: int,
    wavelength_metadata: list[str] | None = None,
) -> BandDetectionResult:
    """Detect band names from explicit metadata descriptions.

    Only trusts information that is explicitly present in the file's
    band descriptions or wavelength metadata. Does not guess positions.
    """
    result = BandDetectionResult()

    if not band_descriptions or all(d == "" for d in band_descriptions):
        result.detection_method = "none"
        result.unknown_band_count = band_count
        result.warnings.append(
            f"No band descriptions available for {band_count} band(s). "
            "Band identities cannot be determined from metadata alone."
        )
        for i in range(1, band_count + 1):
            result.bands.append(DetectedBand(index=i))
        return result

    result.detection_method = "band_descriptions"
    optical_found = set()
    sar_found = set()

    for i, desc in enumerate(band_descriptions, start=1):
        if not desc:
            result.bands.append(DetectedBand(index=i))
            result.unknown_band_count += 1
            continue

        normalized = desc.lower().strip().replace(" ", "_")
        is_known = normalized in KNOWN_BAND_NAMES

        wavelength = ""
        if wavelength_metadata and i <= len(wavelength_metadata):
            wavelength = wavelength_metadata[i - 1]

        band = DetectedBand(
            index=i,
            detected_name=normalized if is_known else "",
            description=desc,
            wavelength=wavelength,
            is_known=is_known,
        )
        result.bands.append(band)

        if is_known:
            if normalized in SAR_POLARIZATIONS:
                sar_found.add(normalized)
            else:
                optical_found.add(normalized)
        else:
            result.unknown_band_count += 1

    has_red = "red" in optical_found
    has_nir = "nir" in optical_found or "nir1" in optical_found
    result.has_required_optical_bands = has_red and has_nir

    has_vv = "vv" in sar_found
    has_vh = "vh" in sar_found
    result.has_required_sar_bands = has_vv or has_vh

    if result.unknown_band_count > 0:
        result.warnings.append(
            f"{result.unknown_band_count} of {band_count} band(s) could not "
            "be identified from metadata."
        )

    return result


def detect_bands(
    band_descriptions: list[str],
    band_count: int,
    wavelength_metadata: list[str] | None = None,
    crs_string: str | None = None,
) -> BandDetectionResult:
    """High-level band detection that also considers CRS context.

    This adds a heuristic check: if the CRS looks like a UTM zone
    and band descriptions are empty, we can note that it's likely
    a satellite image but cannot identify specific bands.
    """
    result = detect_bands_from_metadata(
        band_descriptions, band_count, wavelength_metadata
    )

    if result.detection_method == "none" and crs_string:
        if "UTM" in crs_string.upper() or "326" in crs_string or "327" in crs_string:
            result.warnings.append(
                "CRS indicates a projected coordinate system (likely satellite imagery), "
                "but band identities could not be determined from metadata."
            )

    return result


def detect_modality_from_bands(
    band_descriptions: list[str],
    band_count: int,
) -> str:
    """Detect modality (optical/sar/unknown) from band information.

    Returns 'optical', 'sar', or 'unknown'.
    """
    if not band_descriptions or all(d == "" for d in band_descriptions):
        if band_count <= 2:
            return "unknown"
        return "unknown"

    normalized = [d.lower().strip().replace(" ", "_") for d in band_descriptions]

    sar_keywords = {"vv", "vh", "vvvh", "vv_vh", "hh", "hv", "hh_hv",
                    "sigma0", "sigma_nought", "backscatter", "sar"}
    optical_keywords = {"red", "green", "blue", "nir", "swir", "coastal",
                        "cirrus", "water_vapor", "red_edge"}

    for name in normalized:
        if name in sar_keywords:
            return "sar"
    for name in normalized:
        if name in optical_keywords:
            return "optical"

    return "unknown"
