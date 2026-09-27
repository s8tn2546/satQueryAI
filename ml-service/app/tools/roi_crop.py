"""AOI (area-of-interest) parsing, validation and exact raster crop/mask.

This is the single shared AOI layer for the whole ML service. Analysis tools do
not implement their own clipping: they open an :func:`aoi_scope` and read the
raster the scope hands back, so AOI semantics (CRS handling, masking, nodata,
georeferencing) are identical for every tool.

Guarantees
----------
* The crop is a real spatial operation (``rasterio.mask.mask``), not a bbox
  approximation, and it never modifies the source raster: the cropped raster is
  a derived temporary GeoTIFF.
* Band count, per-band dtypes, band descriptions and nodata semantics are
  preserved in the derived raster, so downstream band resolution keeps working.
* The raster CRS is read from the file. When the AOI is expressed in a different
  CRS it is transformed explicitly with pyproj; no CRS is ever guessed. A bare
  GeoJSON geometry follows RFC 7946 (WGS84 / EPSG:4326) and that choice is
  *reported* (``aoiCrsSource``), never implicit.
* A raster without georeferencing can never be spatially clipped. The scope
  raises :class:`AoiGeoreferenceError` with ``isGeoreferenced: False`` instead of
  returning a whole-scene result that looks AOI-scoped.
* Nothing spatial is fabricated: bounds, dimensions, resolution and pixel counts
  all come from the files themselves.
"""

from __future__ import annotations

import json
import logging
import math
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Generator

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.features import geometry_mask
from rasterio.mask import mask as rio_mask
from rasterio.transform import array_bounds
from rasterio.windows import Window, from_bounds
from shapely.geometry import box, mapping, shape
from shapely.ops import transform as shapely_transform
from shapely.validation import explain_validity

from app.geospatial.crs import crs_to_string, parse_crs
from app.geospatial.raster_io import RasterError, read_metadata
from app.tools.band_utils import build_valid_mask

logger = logging.getLogger(__name__)

# RFC 7946 defines the coordinate reference system for GeoJSON as WGS84
# (CRS84 / lon-lat). That is a standard, not a guess, but it is still reported
# so every result states which CRS its AOI was interpreted in.
GEOJSON_DEFAULT_CRS = "EPSG:4326"
GEOJSON_DEFAULT_CRS_SOURCE = "geojson-rfc7946-default"

SUPPORTED_AOI_TYPES = ("Polygon", "MultiPolygon")

# Clipping modes. A tool declares which one it actually performed so a
# whole-window result is never presented as a polygon-masked result.
SCOPE_MASKED = "raster_window+mask"
SCOPE_WINDOW = "raster_window"

# AOI status values reported in the AOI metadata block.
STATUS_APPLIED = "applied"
STATUS_REJECTED_GEOMETRY = "rejected_invalid_geometry"
STATUS_REJECTED_CRS = "rejected_crs_mismatch"
STATUS_REJECTED_OUTSIDE = "rejected_outside_raster"
STATUS_NOT_GEOREFERENCED = "not_applied_raster_not_georeferenced"
STATUS_NOT_REQUESTED = "not_requested"
STATUS_VALIDATED = "validated_not_applied"


class RoiCropError(Exception):
    """Base exception for AOI crop/validation failures.

    ``metadata`` carries the structured AOI report that the API layer attaches
    to the failed ``ToolOutput``, so a failure is self-describing.
    """

    def __init__(self, message: str, *, metadata: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.metadata: dict[str, Any] = metadata or {}


class AoiValidationError(RoiCropError):
    """Raised for a missing, malformed, unsupported or zero-area AOI."""


class AoiCrsError(RoiCropError):
    """Raised when the AOI CRS cannot be parsed or transformed."""


class AoiGeoreferenceError(RoiCropError):
    """Raised when the raster has no georeferencing and cannot be clipped."""


class AoiOutsideRasterError(RoiCropError):
    """Raised when the AOI does not intersect the raster footprint."""


@dataclass
class ParsedAoi:
    """A validated AOI geometry ready to be intersected with a raster."""

    geometry: dict[str, Any]
    shapely: Any
    crs: Any
    crs_label: str
    crs_source: str
    bounds: dict[str, float]
    warnings: list[str] = field(default_factory=list)


@dataclass
class AoiScope:
    """Result of applying an AOI to a raster.

    ``raster_path`` is always a readable raster: the original file when no AOI
    was requested, otherwise a derived temporary GeoTIFF that exists only for
    the lifetime of the scope.
    """

    raster_path: Path
    aoi_applied: bool
    is_georeferenced: bool
    scope: str | None
    status: str
    original_dimensions: dict[str, int]
    analyzed_dimensions: dict[str, int]
    original_bounds: dict[str, float] | None
    analyzed_bounds: dict[str, float] | None
    crs: str | None
    resolution: dict[str, float] | None
    band_count: int
    dtypes: list[str]
    nodata: Any
    transform: Any = None
    aoi_geometry: dict[str, Any] | None = None
    aoi_bounds: dict[str, float] | None = None
    aoi_crs: str | None = None
    aoi_crs_source: str | None = None
    crs_transformed: bool = False
    aoi_masked_pixels: int | None = None
    valid_pixels: int | None = None
    masked_out_pixels: int | None = None
    nodata_source: str | None = None
    warnings: list[str] = field(default_factory=list)
    reason: str | None = None

    def summary(self) -> dict[str, Any]:
        """Compact, JSON-safe AOI summary safe to embed in a tool ``result``."""
        return {
            "aoiApplied": self.aoi_applied,
            "aoiScope": self.scope if self.aoi_applied else None,
            "isGeoreferenced": self.is_georeferenced,
            "aoiStatus": self.status,
            "originalDimensions": dict(self.original_dimensions),
            "analyzedDimensions": dict(self.analyzed_dimensions),
            "crs": self.crs,
        }

    def metadata(self) -> dict[str, Any]:
        """Full AOI report for ``ToolOutput.metadata.aoi``."""
        return {
            **self.summary(),
            "aoiPresent": self.status != STATUS_NOT_REQUESTED,
            "originalBounds": self.original_bounds,
            "analyzedBounds": self.analyzed_bounds,
            "resolution": self.resolution,
            "aoiGeometry": self.aoi_geometry,
            "aoiBounds": self.aoi_bounds,
            "aoiCrs": self.aoi_crs,
            "aoiCrsSource": self.aoi_crs_source,
            "crsTransformed": self.crs_transformed,
            "bandCount": self.band_count,
            "dtypes": list(self.dtypes),
            "nodata": self.nodata,
            "nodataSource": self.nodata_source,
            "aoiMaskedPixels": self.aoi_masked_pixels,
            "validPixels": self.valid_pixels,
            "maskedOutPixels": self.masked_out_pixels,
            "warnings": list(self.warnings),
            "reason": self.reason,
        }


# --------------------------------------------------------------------------- #
# Geometry validation                                                          #
# --------------------------------------------------------------------------- #


def _fail(status: str, reason: str, **extra: Any) -> AoiValidationError:
    return AoiValidationError(
        reason,
        metadata={
            "aoiApplied": False,
            "aoiPresent": True,
            "aoiStatus": status,
            "aoiScope": None,
            "reason": reason,
            **extra,
        },
    )


def _is_finite_pair(position: Any) -> bool:
    return (
        isinstance(position, (list, tuple))
        and len(position) >= 2
        and isinstance(position[0], (int, float))
        and isinstance(position[1], (int, float))
        and not isinstance(position[0], bool)
        and not isinstance(position[1], bool)
        and math.isfinite(float(position[0]))
        and math.isfinite(float(position[1]))
    )


def _validate_ring(ring: Any, label: str) -> list[list[float]]:
    if not isinstance(ring, list) or not ring:
        raise _fail(STATUS_REJECTED_GEOMETRY, f"AOI {label} is empty; a ring needs at least 3 positions.")
    cleaned: list[list[float]] = []
    for position in ring:
        if not _is_finite_pair(position):
            raise _fail(
                STATUS_REJECTED_GEOMETRY,
                f"AOI {label} contains a position that is not a finite [x, y] number pair: {position!r}.",
            )
        cleaned.append([float(position[0]), float(position[1])])
    if len(cleaned) < 3:
        raise _fail(
            STATUS_REJECTED_GEOMETRY,
            f"AOI {label} has {len(cleaned)} position(s); at least 3 are required to enclose an area.",
        )
    return cleaned


def _close_ring(ring: list[list[float]], warnings: list[str], label: str) -> None:
    if ring[0] != ring[-1]:
        ring.append(list(ring[0]))
        warnings.append(f"AOI {label} was not explicitly closed; the first position was repeated.")


def _normalize_geojson_crs_member(value: Any) -> Any:
    """Unwrap a legacy GeoJSON ``crs`` member into something pyproj accepts.

    Pre-RFC-7946 GeoJSON described its CRS as an object, e.g.
    ``{"type": "name", "properties": {"name": "urn:ogc:def:crs:EPSG::32643"}}``
    or ``{"type": "EPSG", "properties": {"code": 32643}}``. Those forms still
    appear in the wild, so they are recognised rather than rejected.
    """
    if not isinstance(value, dict):
        return value
    properties = value.get("properties")
    if not isinstance(properties, dict):
        return value
    for key in ("name", "href", "code"):
        candidate = properties.get(key)
        if candidate not in (None, ""):
            return candidate
    return value


def _resolve_aoi_crs(aoi: dict[str, Any], aoi_crs: Any) -> tuple[Any, str, str]:
    """Resolve the CRS the AOI coordinates are expressed in.

    Precedence: explicit argument > a ``crs`` member on the geometry > the
    RFC 7946 default. The resolved source is always reported, so the choice is
    auditable rather than implicit.
    """
    explicit = aoi_crs if aoi_crs not in (None, "") else aoi.get("crs")
    if explicit not in (None, ""):
        explicit = _normalize_geojson_crs_member(explicit)
        crs = parse_crs(explicit)
        if crs is None:
            raise AoiCrsError(
                f"AOI CRS {explicit!r} could not be parsed as a coordinate reference system. "
                "Provide a valid CRS (e.g. 'EPSG:4326', 'EPSG:32643', an EPSG code or a PROJ dict).",
                metadata={
                    "aoiApplied": False,
                    "aoiPresent": True,
                    "aoiStatus": STATUS_REJECTED_CRS,
                    "aoiCrs": str(explicit),
                    "aoiCrsSource": "explicit",
                    "reason": "The supplied AOI CRS could not be parsed.",
                },
            )
        return crs, (crs_to_string(crs) or str(crs)), "explicit"

    crs = parse_crs(GEOJSON_DEFAULT_CRS)
    return crs, GEOJSON_DEFAULT_CRS, GEOJSON_DEFAULT_CRS_SOURCE


def _unwrap_aoi_collection(payload: dict[str, Any]) -> dict[str, Any]:
    """Flatten Feature / FeatureCollection wrappers into a single geometry."""
    kind = payload.get("type")

    if kind == "Feature":
        geometry = payload.get("geometry")
        if not isinstance(geometry, dict):
            raise _fail(STATUS_REJECTED_GEOMETRY, "GeoJSON Feature carries no geometry object.")
        return geometry

    if kind == "FeatureCollection":
        features = payload.get("features")
        if not isinstance(features, list) or not features:
            raise _fail(
                STATUS_REJECTED_GEOMETRY,
                "GeoJSON FeatureCollection is empty; an AOI needs at least one feature.",
            )
        geometries = [f.get("geometry") for f in features if isinstance(f, dict)]
        geometries = [g for g in geometries if isinstance(g, dict)]
        if not geometries:
            raise _fail(STATUS_REJECTED_GEOMETRY, "GeoJSON FeatureCollection carries no geometry.")
        if any(g.get("type") not in SUPPORTED_AOI_TYPES for g in geometries):
            raise _fail(
                STATUS_REJECTED_GEOMETRY,
                f"Every AOI feature must be a {' or '.join(SUPPORTED_AOI_TYPES)}.",
            )
        if len(geometries) == 1:
            return geometries[0]
        polygons: list[Any] = []
        for geometry in geometries:
            coordinates = geometry.get("coordinates")
            if geometry.get("type") == "Polygon":
                polygons.append(coordinates)
            else:
                polygons.extend(coordinates)
        return {"type": "MultiPolygon", "coordinates": polygons}

    return payload


def _validity_detail(geom: Any) -> str:
    """Human-readable explanation of why a polygon geometry is invalid."""
    try:
        return str(explain_validity(geom))
    except Exception:
        return "the rings self-intersect or do not enclose a single area"


def parse_aoi(aoi: Any, aoi_crs: Any = None) -> ParsedAoi:
    """Validate an AOI and return it as a :class:`ParsedAoi`.

    Accepts a GeoJSON geometry, a Feature/FeatureCollection, or the
    JSON-stringified form of any of those (the transport used by the multipart
    API). Only ``Polygon`` and ``MultiPolygon`` are supported; anything else is
    rejected rather than approximated.

    Raises:
        AoiValidationError: missing, malformed, unsupported, empty or zero-area AOI.
        AoiCrsError: the supplied AOI CRS cannot be parsed.
    """
    if aoi is None:
        raise AoiValidationError(
            "No AOI geometry was supplied.",
            metadata={
                "aoiApplied": False,
                "aoiPresent": False,
                "aoiStatus": STATUS_REJECTED_GEOMETRY,
                "aoiScope": None,
                "reason": "No AOI geometry was supplied.",
            },
        )

    payload: Any = aoi
    if isinstance(payload, (str, bytes)):
        try:
            payload = json.loads(payload)
        except (TypeError, ValueError) as exc:
            raise _fail(STATUS_REJECTED_GEOMETRY, f"AOI geometry is not valid JSON: {exc}") from exc

    if not isinstance(payload, dict):
        raise _fail(
            STATUS_REJECTED_GEOMETRY,
            f"AOI must be a GeoJSON object; got {type(payload).__name__}.",
        )

    payload = _unwrap_aoi_collection(payload)
    kind = payload.get("type")

    if kind not in SUPPORTED_AOI_TYPES:
        raise _fail(
            STATUS_REJECTED_GEOMETRY,
            f"Unsupported AOI geometry type {kind!r}. Supported: {', '.join(SUPPORTED_AOI_TYPES)}.",
        )

    warnings: list[str] = []
    coordinates = payload.get("coordinates")

    if kind == "Polygon":
        if not isinstance(coordinates, list) or not coordinates:
            raise _fail(STATUS_REJECTED_GEOMETRY, "AOI Polygon carries no coordinate ring.")
        rings: list[list[list[float]]] = []
        for index, ring in enumerate(coordinates):
            label = "exterior ring" if index == 0 else f"interior ring {index}"
            cleaned = _validate_ring(ring, label)
            _close_ring(cleaned, warnings, label)
            rings.append(cleaned)
        normalized: dict[str, Any] = {"type": "Polygon", "coordinates": rings}
    else:
        if not isinstance(coordinates, list) or not coordinates:
            raise _fail(STATUS_REJECTED_GEOMETRY, "AOI MultiPolygon carries no polygon coordinates.")
        polygons: list[list[list[list[float]]]] = []
        for p_index, polygon in enumerate(coordinates):
            if not isinstance(polygon, list) or not polygon:
                raise _fail(
                    STATUS_REJECTED_GEOMETRY,
                    f"AOI MultiPolygon polygon {p_index + 1} is empty.",
                )
            poly_rings: list[list[list[float]]] = []
            for r_index, ring in enumerate(polygon):
                label = f"polygon {p_index + 1} ring {r_index + 1}"
                cleaned = _validate_ring(ring, label)
                _close_ring(cleaned, warnings, label)
                poly_rings.append(cleaned)
            polygons.append(poly_rings)
        normalized = {"type": "MultiPolygon", "coordinates": polygons}

    try:
        geom = shape(normalized)
    except Exception as exc:
        raise _fail(STATUS_REJECTED_GEOMETRY, f"AOI geometry could not be interpreted: {exc}") from exc

    if geom.is_empty:
        raise _fail(STATUS_REJECTED_GEOMETRY, "AOI geometry is empty.")
    if not geom.is_valid:
        raise _fail(
            STATUS_REJECTED_GEOMETRY,
            f"AOI geometry is not a valid polygon: {_validity_detail(geom)}.",
        )
    if geom.area <= 0:
        raise _fail(
            STATUS_REJECTED_GEOMETRY,
            "AOI geometry has zero area; it cannot describe a region of interest.",
        )

    crs, crs_label, crs_source = _resolve_aoi_crs(payload, aoi_crs)

    return ParsedAoi(
        geometry=normalized,
        shapely=geom,
        crs=crs,
        crs_label=crs_label,
        crs_source=crs_source,
        bounds={
            "west": float(geom.bounds[0]),
            "south": float(geom.bounds[1]),
            "east": float(geom.bounds[2]),
            "north": float(geom.bounds[3]),
        },
        warnings=warnings,
    )


def has_aoi(aoi: Any) -> bool:
    """True when an AOI was actually supplied (None/empty means "whole scene")."""
    if aoi is None:
        return False
    if isinstance(aoi, (str, bytes)):
        return len(aoi.strip()) > 0
    if isinstance(aoi, dict):
        return len(aoi) > 0
    return True


# --------------------------------------------------------------------------- #
# CRS handling                                                                 #
# --------------------------------------------------------------------------- #


def _crs_equivalent(a: Any, b: Any) -> bool:
    """True when two CRS objects denote the same system (never a guess)."""
    pa, pb = parse_crs(a), parse_crs(b)
    if pa is None or pb is None:
        return False
    if pa.to_epsg() is not None and pa.to_epsg() == pb.to_epsg():
        return True
    try:
        return bool(pa.equals(pb))
    except Exception:
        return False


def transform_aoi_to_crs(geom: Any, src_crs: Any, dst_crs: Any) -> Any:
    """Transform a shapely geometry between two CRSs, explicitly.

    Raises:
        AoiCrsError: if either CRS is unusable or the transformation fails.
    """
    src = parse_crs(src_crs)
    dst = parse_crs(dst_crs)
    if src is None or dst is None:
        raise AoiCrsError(
            "AOI or raster CRS is undefined, so the AOI cannot be transformed. "
            "Refusing to assume a coordinate reference system.",
            metadata={
                "aoiApplied": False,
                "aoiPresent": True,
                "aoiStatus": STATUS_REJECTED_CRS,
                "aoiScope": None,
                "reason": "The AOI or raster CRS is undefined.",
            },
        )
    try:
        transformer = Transformer.from_crs(src, dst, always_xy=True)
        return shapely_transform(lambda x, y, z=None: transformer.transform(x, y), geom)
    except Exception as exc:
        raise AoiCrsError(
            f"AOI could not be transformed from {crs_to_string(src) or 'unknown'} to "
            f"{crs_to_string(dst) or 'unknown'}: {exc}",
            metadata={
                "aoiApplied": False,
                "aoiPresent": True,
                "aoiStatus": STATUS_REJECTED_CRS,
                "aoiScope": None,
                "aoiCrs": crs_to_string(src),
                "reason": "The AOI CRS transformation failed.",
            },
        ) from exc


# --------------------------------------------------------------------------- #
# Cropping                                                                     #
# --------------------------------------------------------------------------- #


def _pick_nodata(
    dtype: str,
    source_nodata: Any,
    data: np.ndarray | None = None,
) -> tuple[Any, str]:
    """Choose the fill/nodata value used for pixels outside the AOI.

    The source raster's own nodata is always preferred so nodata semantics are
    preserved. Only when the source declares none is a sentinel assigned.

    For integer rasters the sentinel is checked against the actual pixel values
    and a value that is genuinely absent from the data is used. A sentinel that
    collides with real reflectance would silently make valid pixels look invalid,
    so a collision is never accepted silently: it is reported via
    ``nodataSource`` and the exact AOI mask is written to the derived raster as
    an internal mask band.
    """
    if source_nodata is not None:
        return source_nodata, "dataset"

    np_dtype = np.dtype(dtype)
    if np_dtype.kind == "f":
        # NaN is never equal to a real measurement, so it cannot collide.
        return float("nan"), "assigned_nan"

    if np_dtype.kind in "iu":
        info = np.iinfo(np_dtype)
        candidates = [int(info.min), int(info.max)]
        if data is not None and data.size:
            for candidate in candidates:
                if not bool(np.any(data == candidate)):
                    label = (
                        "assigned_dtype_min_sentinel"
                        if candidate == int(info.min)
                        else "assigned_dtype_max_sentinel"
                    )
                    return candidate, label
            return candidates[0], "assigned_dtype_sentinel_value_collision"

    return 0, "assigned_zero_sentinel"


def _base_scope(path: Path, metadata: dict[str, Any]) -> dict[str, Any]:
    return {
        "original_dimensions": {
            "width": int(metadata.get("width", 0) or 0),
            "height": int(metadata.get("height", 0) or 0),
        },
        "original_bounds": metadata.get("bounds"),
        "band_count": int(metadata.get("band_count", 0) or 0),
        "dtypes": [metadata.get("dtype")] if metadata.get("dtype") else [],
    }


def no_aoi_scope(path: str | Path) -> AoiScope:
    """Scope representing an unrestricted (whole-scene) analysis."""
    p = Path(path)
    try:
        metadata = read_metadata(p)
    except RasterError:
        metadata = {}
    dims = {
        "width": int(metadata.get("width", 0) or 0),
        "height": int(metadata.get("height", 0) or 0),
    }
    crs = metadata.get("crs")
    return AoiScope(
        raster_path=p,
        aoi_applied=False,
        is_georeferenced=bool(metadata.get("is_georeferenced", False)),
        scope=None,
        status=STATUS_NOT_REQUESTED,
        original_dimensions=dims,
        analyzed_dimensions=dict(dims),
        original_bounds=metadata.get("bounds"),
        analyzed_bounds=metadata.get("bounds"),
        crs=crs_to_string(crs) if crs is not None else None,
        resolution=metadata.get("resolution"),
        band_count=int(metadata.get("band_count", 0) or 0),
        dtypes=[metadata.get("dtype")] if metadata.get("dtype") else [],
        nodata=metadata.get("nodata"),
        transform=metadata.get("transform"),
    )


def _georeference_failure(path: Path) -> AoiGeoreferenceError:
    try:
        metadata = read_metadata(path)
    except RasterError:
        metadata = {}
    base = _base_scope(path, metadata)
    return AoiGeoreferenceError(
        "The raster is not georeferenced (no CRS and/or no geotransform), so a geographic "
        "AOI cannot be located within it. Spatial clipping was NOT performed and no "
        "AOI-scoped result was produced.",
        metadata={
            "aoiApplied": False,
            "aoiPresent": True,
            "aoiStatus": STATUS_NOT_GEOREFERENCED,
            "aoiScope": None,
            "isGeoreferenced": False,
            "originalDimensions": base["original_dimensions"],
            "analyzedDimensions": base["original_dimensions"],
            "originalBounds": base["original_bounds"],
            "analyzedBounds": None,
            "crs": None,
            "resolution": None,
            "reason": (
                "The raster has no CRS/geotransform, so a geographic AOI cannot be mapped "
                "onto it and no spatial clipping could be performed."
            ),
        },
    )


def crop_raster(
    path: str | Path,
    aoi: Any,
    *,
    aoi_crs: Any = None,
    all_touched: bool = False,
    apply_mask: bool = True,
) -> tuple[np.ndarray, np.ndarray | None, AoiScope]:
    """Crop/mask a raster to an AOI, returning the data plus an AOI scope.

    Args:
        path: Source raster. Opened read-only; never modified.
        aoi: GeoJSON Polygon/MultiPolygon (or JSON string / Feature).
        aoi_crs: Optional explicit CRS of the AOI coordinates.
        all_touched: rasterio pixel-inclusion rule. ``False`` (default) selects
            pixels whose centre lies inside the AOI, the standard rule.
        apply_mask: ``True`` performs a real polygon mask (``rasterio.mask.mask``)
            and fills pixels outside the AOI with the effective nodata. ``False``
            extracts only the AOI's bounding window with no polygon mask, which is
            what the VLM tools use (they render a rectangular image and must not
            claim polygon-level masking).

    Returns:
        ``(data, inside_aoi_mask, scope)``. ``data`` has shape (bands, h, w).
        ``inside_aoi_mask`` is a 2D boolean array, or ``None`` in window mode.

    Raises:
        AoiValidationError, AoiCrsError, AoiGeoreferenceError,
        AoiOutsideRasterError, RasterError.
    """
    src_path = Path(path)

    metadata = read_metadata(src_path)
    if not metadata.get("is_georeferenced"):
        raise _georeference_failure(src_path)

    parsed = parse_aoi(aoi, aoi_crs)
    raster_crs = metadata.get("crs")
    raster_crs_label = crs_to_string(raster_crs) or "defined"
    transformed = not _crs_equivalent(parsed.crs, raster_crs)

    geom = (
        transform_aoi_to_crs(parsed.shapely, parsed.crs, raster_crs) if transformed else parsed.shapely
    )

    raster_bounds = metadata.get("bounds") or {}
    footprint = box(
        raster_bounds.get("west", 0.0),
        raster_bounds.get("south", 0.0),
        raster_bounds.get("east", 0.0),
        raster_bounds.get("north", 0.0),
    )
    intersection = geom.intersection(footprint)
    aoi_bounds = {
        "west": float(geom.bounds[0]),
        "south": float(geom.bounds[1]),
        "east": float(geom.bounds[2]),
        "north": float(geom.bounds[3]),
    }
    base = _base_scope(src_path, metadata)

    if intersection.is_empty or intersection.area <= 0:
        raise AoiOutsideRasterError(
            "The AOI does not intersect the raster footprint. "
            f"raster bounds (W,S,E,N) = ({footprint.bounds[0]}, {footprint.bounds[1]}, "
            f"{footprint.bounds[2]}, {footprint.bounds[3]}) in {raster_crs_label}; "
            f"AOI bounds (W,S,E,N) = ({geom.bounds[0]}, {geom.bounds[1]}, {geom.bounds[2]}, "
            f"{geom.bounds[3]}) in {raster_crs_label}.",
            metadata={
                "aoiApplied": False,
                "aoiPresent": True,
                "aoiStatus": STATUS_REJECTED_OUTSIDE,
                "aoiScope": None,
                "isGeoreferenced": True,
                "originalDimensions": base["original_dimensions"],
                "analyzedDimensions": base["original_dimensions"],
                "originalBounds": base["original_bounds"],
                "analyzedBounds": None,
                "crs": raster_crs_label,
                "aoiBounds": aoi_bounds,
                "aoiCrs": parsed.crs_label,
                "aoiCrsSource": parsed.crs_source,
                "crsTransformed": transformed,
                "reason": "The AOI does not intersect the raster footprint.",
            },
        )

    warnings = list(parsed.warnings)
    if intersection.area < geom.area:
        warnings.append(
            "The AOI extends beyond the raster footprint; only the overlapping part was analyzed."
        )

    with rasterio.open(str(src_path)) as src:
        source_nodata = src.nodata
        dtypes = list(src.dtypes)

        if apply_mask:
            try:
                masked, out_transform = rio_mask(
                    src,
                    [geom],
                    all_touched=all_touched,
                    crop=True,
                    filled=False,
                )
            except ValueError as exc:
                # rasterio raises when the mask selects no pixel at all.
                raise AoiOutsideRasterError(
                    f"The AOI covers no pixel of the raster: {exc}",
                    metadata={
                        "aoiApplied": False,
                        "aoiPresent": True,
                        "aoiStatus": STATUS_REJECTED_OUTSIDE,
                        "aoiScope": None,
                        "isGeoreferenced": True,
                        "crs": raster_crs_label,
                        "aoiBounds": aoi_bounds,
                        "reason": "The AOI covers no raster pixel.",
                    },
                ) from exc
            except RoiCropError:
                raise
            except Exception as exc:
                raise RoiCropError(
                    f"AOI crop/mask failed: {exc}",
                    metadata={
                        "aoiApplied": False,
                        "aoiPresent": True,
                        "aoiStatus": STATUS_REJECTED_GEOMETRY,
                        "aoiScope": None,
                        "isGeoreferenced": True,
                        "crs": raster_crs_label,
                        "reason": "The AOI crop/mask failed.",
                    },
                ) from exc

            arr = np.ma.masked_array(masked)
            out_h, out_w = int(arr.shape[1]), int(arr.shape[2])
            # Exact AOI membership, independent of any nodata the dataset itself
            # contains, so valid-pixel counts are attributable to the AOI alone.
            inside = geometry_mask(
                [geom],
                out_shape=(out_h, out_w),
                transform=out_transform,
                all_touched=all_touched,
                invert=True,
            )
            if not bool(inside.any()):
                raise AoiOutsideRasterError(
                    "The AOI covers no pixel centre of the raster.",
                    metadata={
                        "aoiApplied": False,
                        "aoiPresent": True,
                        "aoiStatus": STATUS_REJECTED_OUTSIDE,
                        "aoiScope": None,
                        "isGeoreferenced": True,
                        "crs": raster_crs_label,
                        "aoiBounds": aoi_bounds,
                        "reason": "The AOI covers no raster pixel.",
                    },
                )
            # Restore genuine source nodata inside the AOI, then fill everything
            # outside the AOI with a sentinel proven not to collide with data.
            data = np.ma.filled(arr, source_nodata if source_nodata is not None else 0)
            effective_nodata, nodata_source = _pick_nodata(
                dtypes[0], source_nodata, np.asarray(data)[:, inside]
            )
            fill = np.array(effective_nodata, dtype=data.dtype)
            data = np.where(inside[None, :, :], data, fill)
        else:
            # Window-only scope: extract the AOI's pixel window verbatim, with
            # no polygon mask applied (the caller declares this honestly).
            # The window is grown to fully contain the AOI bounds, so the AOI is
            # never under-covered by rounding.
            raw = from_bounds(
                aoi_bounds["west"], aoi_bounds["south"], aoi_bounds["east"], aoi_bounds["north"],
                transform=src.transform,
            )
            col_start = math.floor(raw.col_off)
            row_start = math.floor(raw.row_off)
            col_stop = math.ceil(raw.col_off + raw.width)
            row_stop = math.ceil(raw.row_off + raw.height)
            window = Window(col_start, row_start, col_stop - col_start, row_stop - row_start)
            window = window.intersection(Window(0, 0, src.width, src.height))
            if window.width <= 0 or window.height <= 0:
                raise AoiOutsideRasterError(
                    "The AOI does not cover any pixel window of the raster.",
                    metadata={
                        "aoiApplied": False,
                        "aoiPresent": True,
                        "aoiStatus": STATUS_REJECTED_OUTSIDE,
                        "aoiScope": None,
                        "isGeoreferenced": True,
                        "crs": raster_crs_label,
                        "aoiBounds": aoi_bounds,
                        "reason": "The AOI covers no raster pixel window.",
                    },
                )
            out_transform = src.window_transform(window)
            out_h, out_w = int(window.height), int(window.width)
            data = np.asarray(src.read(window=window))
            inside = None
            effective_nodata = source_nodata
            nodata_source = "dataset" if source_nodata is not None else "none_declared"

        west, south, east, north = array_bounds(out_h, out_w, out_transform)
        out_bounds = {
            "west": float(west),
            "south": float(south),
            "east": float(east),
            "north": float(north),
        }
        res = src.res

    if transformed:
        warnings.append(
            f"AOI was transformed from {parsed.crs_label} ({parsed.crs_source}) into the "
            f"raster CRS {raster_crs_label} before masking."
        )
    if apply_mask and nodata_source == "assigned_dtype_sentinel_value_collision":
        warnings.append(
            f"The source raster declares no nodata value and its data spans the full "
            f"{dtypes[0]} range, so no value sentinel is guaranteed to be distinguishable "
            "from real data. Pixels outside the AOI were filled with "
            f"{effective_nodata} and the exact AOI mask is also stored in the derived "
            "raster's mask band."
        )
    elif apply_mask and nodata_source != "dataset":
        warnings.append(
            "The source raster declares no nodata value; a sentinel nodata "
            f"({effective_nodata}, verified absent from the data inside the AOI) was "
            "assigned to pixels outside the AOI so they are excluded from statistics."
        )

    valid_pixels: int | None = None
    aoi_pixels: int | None = None
    masked_out: int | None = None
    if apply_mask:
        assert inside is not None
        aoi_pixels = int(np.count_nonzero(inside))
        masked_out = int(inside.size - aoi_pixels)
        # Validity is judged against the *source* nodata, never against the
        # assigned sentinel, so real pixels equal to the sentinel stay valid.
        valid_pixels = 0
        for index in range(data.shape[0]):
            valid_pixels += int(
                np.count_nonzero(build_valid_mask(data[index], source_nodata) & inside)
            )
    else:
        first = data[0] if data.ndim == 3 else data
        valid_pixels = int(np.count_nonzero(build_valid_mask(first, source_nodata)))

    scope = AoiScope(
        raster_path=src_path,
        aoi_applied=True,
        is_georeferenced=True,
        scope=SCOPE_MASKED if apply_mask else SCOPE_WINDOW,
        status=STATUS_APPLIED,
        original_dimensions=base["original_dimensions"],
        analyzed_dimensions={"width": int(out_w), "height": int(out_h)},
        original_bounds=base["original_bounds"],
        analyzed_bounds=out_bounds,
        crs=raster_crs_label,
        resolution={"x": abs(float(res[0])), "y": abs(float(res[1]))},
        band_count=int(data.shape[0]),
        dtypes=[str(data.dtype)] * int(data.shape[0]),
        nodata=effective_nodata,
        transform=out_transform,
        aoi_geometry=mapping(geom),
        aoi_bounds=aoi_bounds,
        aoi_crs=parsed.crs_label,
        aoi_crs_source=parsed.crs_source,
        crs_transformed=transformed,
        aoi_masked_pixels=aoi_pixels,
        valid_pixels=valid_pixels,
        masked_out_pixels=masked_out,
        nodata_source=nodata_source,
        warnings=warnings,
    )
    return data, inside, scope


def write_cropped_raster(
    data: np.ndarray,
    inside_mask: np.ndarray | None,
    scope: AoiScope,
    out_path: str | Path,
    *,
    descriptions: list[str] | None = None,
) -> Path:
    """Write a derived GeoTIFF from cropped arrays, preserving the raster contract.

    Band count, per-band dtypes, band descriptions, nodata, transform, CRS and
    resolution come from the source/crop, so downstream tools resolve bands and
    masks exactly as they would on the original file.
    """
    out = Path(out_path)
    arrays = data if data.ndim == 3 else data[None, :, :]
    masked_scope = inside_mask is not None and scope.scope == SCOPE_MASKED
    if masked_scope:
        fill = np.array(scope.nodata, dtype=arrays.dtype)
        arrays = np.where(inside_mask[None, :, :], arrays, fill)

    height, width = int(arrays.shape[1]), int(arrays.shape[2])
    # Prefer the exact crop transform produced by rasterio so a rotated or
    # otherwise non-axis-aligned geotransform survives the round trip exactly.
    transform = scope.transform if (scope.is_georeferenced and scope.transform is not None) else None

    with rasterio.open(
        out,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=int(arrays.shape[0]),
        dtype=str(arrays.dtype),
        nodata=scope.nodata,
        crs=scope.crs if scope.crs else None,
        transform=transform,
    ) as dst:
        for i in range(arrays.shape[0]):
            dst.write(arrays[i], i + 1)
        for i, desc in enumerate(descriptions or [], start=1):
            if i <= arrays.shape[0] and desc:
                dst.set_band_description(i, desc)
        if masked_scope:
            # Keep the exact AOI membership as an internal mask band so the
            # derived raster is self-describing and does not rely on a value
            # sentinel to convey the boundary.
            dst.write_mask(np.where(inside_mask, 255, 0).astype(np.uint8))
    return out


def _source_descriptions(path: str | Path) -> list[str]:
    try:
        with rasterio.open(str(path)) as src:
            return list(src.descriptions)
    except Exception:
        return []


@contextmanager
def aoi_scope(
    path: str | Path,
    aoi: Any,
    *,
    aoi_crs: Any = None,
    all_touched: bool = False,
    apply_mask: bool = True,
) -> Generator[AoiScope, None, None]:
    """Yield a scope whose ``raster_path`` is AOI-restricted when an AOI is given.

    With no AOI the original file is handed back untouched, so existing
    whole-scene behaviour is preserved exactly. With an AOI, a derived temporary
    GeoTIFF is created and removed on exit — the source raster is never modified.
    """
    src_path = Path(path)
    if not has_aoi(aoi):
        yield no_aoi_scope(src_path)
        return

    data, inside, scope = crop_raster(
        src_path, aoi, aoi_crs=aoi_crs, all_touched=all_touched, apply_mask=apply_mask
    )
    descriptions = _source_descriptions(src_path)

    with tempfile.TemporaryDirectory(prefix="satquery-aoi-") as tmpdir:
        derived = Path(tmpdir) / f"{src_path.stem or 'raster'}_aoi.tif"
        write_cropped_raster(data, inside, scope, derived, descriptions=descriptions)
        try:
            scope.raster_path = derived
            yield scope
        finally:
            scope.raster_path = src_path


def _merge_warnings(result: dict[str, Any], scope_warnings: list[str]) -> None:
    warnings = list(result.get("warnings") or [])
    for warning in scope_warnings:
        if warning not in warnings:
            warnings.append(warning)
    result["warnings"] = warnings


def attach_aoi(result: dict[str, Any], scope: AoiScope) -> dict[str, Any]:
    """Merge AOI reporting into a tool's result dict.

    Every tool returns its measurements in a ``result`` dict; this adds the AOI
    report under ``result["aoi"]`` and folds any AOI warnings (CRS
    transformation, partial overlap, assigned nodata) into ``result["warnings"]``
    so a caller sees them alongside the tool's own warnings. Existing keys are
    never modified, which keeps the published result schema backwards compatible
    — the AOI block is purely additive.
    """
    result["aoi"] = scope.metadata()
    _merge_warnings(result, scope.warnings)
    return result


def attach_aoi_pair(
    result: dict[str, Any],
    first: AoiScope,
    second: AoiScope,
    *,
    first_label: str = "image1",
    second_label: str = "image2",
) -> dict[str, Any]:
    """Merge AOI reporting for a tool that analyzes two rasters.

    The same AOI is applied to both inputs, so the top level reports the shared
    facts (was it applied, which CRS, was it transformed) while each input's own
    crop is reported separately under ``aoi.images``. This keeps a bi-temporal
    result auditable: a reader can see that both dates were clipped the same way
    and by how much.
    """
    labels = [first_label, second_label]
    scopes = [first, second]
    applied = all(scope.aoi_applied for scope in scopes)
    statuses = {scope.status for scope in scopes}
    scope_kinds = {scope.scope for scope in scopes}
    geometries = [scope.aoi_geometry for scope in scopes if scope.aoi_geometry is not None]
    warnings: list[str] = []
    for scope in scopes:
        for warning in scope.warnings:
            if warning not in warnings:
                warnings.append(warning)

    report: dict[str, Any] = {
        "aoiPresent": any(scope.status != STATUS_NOT_REQUESTED for scope in scopes),
        "aoiApplied": applied,
        "aoiScope": (scope_kinds.pop() if applied and len(scope_kinds) == 1 else ("mixed" if applied else None)),
        "isGeoreferenced": all(scope.is_georeferenced for scope in scopes),
        "aoiStatus": statuses.pop() if len(statuses) == 1 else "mixed",
        "aoiCrs": first.aoi_crs,
        "aoiCrsSource": first.aoi_crs_source,
        "crsTransformed": any(scope.crs_transformed for scope in scopes),
        "aoiBounds": first.aoi_bounds,
        "aoiMaskedPixels": first.aoi_masked_pixels if first.aoi_masked_pixels == second.aoi_masked_pixels else None,
        "warnings": warnings,
        "images": [
            {"image": label, **scope.metadata()} for label, scope in zip(labels, scopes)
        ],
    }
    # Both inputs are clipped by the same geometry, but it is transformed into
    # each raster's own CRS, so report each raster-space geometry explicitly.
    report["aoiGeometry"] = geometries[0] if geometries else None
    if len(geometries) == 2 and geometries[0] != geometries[1]:
        report["aoiGeometryPerImageCrs"] = {
            labels[0]: geometries[0],
            labels[1]: geometries[1],
        }

    result["aoi"] = report
    _merge_warnings(result, warnings)
    return result


def validate_aoi_only(aoi: Any, aoi_crs: Any = None) -> dict[str, Any]:
    """Validate an AOI on its own and return a compact report.

    Used where a tool must state whether an AOI is usable without touching a
    raster (e.g. a non-georeferenced input where no clipping is possible).
    """
    if not has_aoi(aoi):
        return {
            "aoiPresent": False,
            "aoiApplied": False,
            "aoiStatus": STATUS_NOT_REQUESTED,
            "isGeoreferenced": None,
        }
    try:
        parsed = parse_aoi(aoi, aoi_crs)
    except AoiCrsError as exc:
        return {
            "aoiPresent": True,
            "aoiApplied": False,
            "aoiStatus": STATUS_REJECTED_CRS,
            "isGeoreferenced": None,
            "reason": str(exc),
        }
    except RoiCropError as exc:
        return {
            "aoiPresent": True,
            "aoiApplied": False,
            "aoiStatus": STATUS_REJECTED_GEOMETRY,
            "isGeoreferenced": None,
            "reason": str(exc),
        }
    return {
        "aoiPresent": True,
        "aoiApplied": False,
        "aoiStatus": STATUS_VALIDATED,
        "isGeoreferenced": None,
        "aoiGeometry": parsed.geometry,
        "aoiBounds": parsed.bounds,
        "aoiCrs": parsed.crs_label,
        "aoiCrsSource": parsed.crs_source,
        "warnings": list(parsed.warnings),
        "reason": "AOI is a valid Polygon/MultiPolygon but was not applied to a raster.",
    }
