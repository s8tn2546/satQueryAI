"""Raster I/O operations using rasterio.

Provides safe functions for opening, reading metadata from, and
extracting band data from raster files (GeoTIFF, TIFF, and
rasterio-readable PNG/JPEG).
"""

from __future__ import annotations

import logging
import math
import warnings
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

import numpy as np
import rasterio
from rasterio.errors import NotGeoreferencedWarning
from rasterio.io import MemoryFile
from rasterio.transform import Affine

from app.common.safe_errors import safe_error

logger = logging.getLogger(__name__)

SUPPORTED_RASTER_EXTENSIONS = {".tif", ".tiff", ".geotiff", ".png", ".jpeg", ".jpg"}
SUPPORTED_RASTER_DRIVERS = {"GTiff", "PNG", "JPEG"}


class RasterError(Exception):
    """Base exception for raster I/O errors."""


class RasterNotFoundError(RasterError):
    """Raised when a raster file does not exist."""


class RasterFormatError(RasterError):
    """Raised when a raster file format is unsupported or unreadable."""


class RasterCorruptError(RasterError):
    """Raised when a raster file is corrupt or cannot be parsed."""


class NotGeoreferencedError(RasterError):
    """Raised when a spatial value is requested from a raster that has none.

    rasterio silently substitutes the identity transform (and therefore
    pixel-sized "bounds") for a raster with no georeferencing. Returning that
    would hand callers coordinates that describe array indices, not geography,
    so the accessors refuse instead. Callers that only need pixel data
    (:func:`read_band`, :func:`read_all_bands`) are unaffected.
    """


@contextmanager
def _suppress_not_georeferenced() -> Generator[None, None, None]:
    """Silence *only* rasterio's identity-substitution notice.

    ``NotGeoreferencedWarning`` fires on every open of a non-georeferenced
    raster — including legitimate visual-only PNGs — and is informational: the
    fact it reports is already surfaced authoritatively as
    ``metadata["is_georeferenced"]``. Left alone it floods logs and gets
    mistaken for a defect.

    The suppression is deliberately narrow: it names this one category, so a
    genuine warning or error from rasterio still propagates untouched.
    """
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            category=NotGeoreferencedWarning,
            # Only the identity-matrix notice; other rasterio warnings are errors
            # in disguise and must never be hidden.
            message=r".*no geotransform, gcps, or rpcs.*",
        )
        yield


def _crs_is_defined(crs: Any) -> bool:
    """Return True if a CRS object is present and defined.

    Avoids deprecated rasterio attributes. A CRS is considered defined
    if it produces a non-empty string representation.
    """
    if crs is None:
        return False
    try:
        return bool(crs.to_string().strip())
    except Exception:
        return False


def _is_identity_transform(transform: Affine) -> bool:
    """Return True if an affine transform is the identity matrix.

    Rasterio falls back to the identity matrix when a dataset has no
    geotransform. An identity transform carries no geographic meaning,
    so we must not interpret its implied "bounds" as real coordinates.
    """
    return (
        transform.a == 1
        and transform.b == 0
        and transform.c == 0
        and transform.d == 0
        and transform.e == 1
        and transform.f == 0
    )


def _is_real_geotransform(transform: Affine) -> bool:
    """Return True only if the transform genuinely georeferences the raster.

    Rejects two cases that rasterio will happily hand back without complaint:
    the identity matrix it substitutes when a dataset has no geotransform, and a
    degenerate transform with a zero/non-finite pixel size that collapses the
    raster to a single point.
    """
    if _is_identity_transform(transform):
        return False
    for component in (transform.a, transform.b, transform.d, transform.e):
        if not math.isfinite(component):
            return False
    # Pixel size along both axes must be strictly positive and finite.
    if transform.a == 0 or transform.e == 0:
        return False
    return True


def is_raster_extension(path: str | Path) -> bool:
    """Check whether a file path has a known raster extension."""
    return Path(path).suffix.lower() in SUPPORTED_RASTER_EXTENSIONS


def get_file_extension(path: str | Path) -> str:
    """Return the lowercase extension without the dot."""
    ext = Path(path).suffix.lower().lstrip(".")
    if ext in ("tif", "tiff", "geotiff"):
        return "geotiff"
    if ext in ("jpg", "jpeg"):
        return "jpeg"
    if ext == "png":
        return "png"
    return ext


@contextmanager
def open_raster(path: str | Path) -> Generator[rasterio.DatasetReader, None, None]:
    """Context manager that opens a raster file safely.

    Raises:
        RasterNotFoundError: If the file does not exist.
        RasterFormatError: If the format is unsupported or unreadable.
        RasterCorruptError: If the file is corrupt.
    """
    path = Path(path)
    if not path.exists():
        raise RasterNotFoundError(f"File not found: {path}")

    if not is_raster_extension(path):
        raise RasterFormatError(
            f"Unsupported file format '{path.suffix}'. "
            f"Supported: {sorted(SUPPORTED_RASTER_EXTENSIONS)}"
        )

    try:
        with _suppress_not_georeferenced():
            with rasterio.open(path) as src:
                yield src
    except rasterio.errors.RasterioIOError as exc:
        raise RasterFormatError(f"Cannot read file as raster: {path} — {exc}") from exc
    except rasterio.errors.CRSError as exc:
        raise RasterCorruptError(f"Corrupt raster or unreadable CRS: {path} — {exc}") from exc
    except (
        ValueError,
        TypeError,
        IndexError,
        KeyError,
        MemoryError,
    ):
        raise
    except Exception as exc:
        raise RasterCorruptError(f"Failed to open raster: {path} — {exc}") from exc


def read_metadata(path: str | Path) -> dict[str, Any]:
    """Read basic metadata from a raster file without loading band data.

    Returns a dict with: width, height, band_count, dtype, nodata,
    crs, transform, bounds, resolution, description, count, driver.
    """
    with open_raster(path) as src:
        bounds = src.bounds
        res = src.res
        transform = src.transform
        is_georef = _crs_is_defined(src.crs)
        has_transform = _is_real_geotransform(transform)
        georeferenced = is_georef and has_transform
        return {
            "width": src.width,
            "height": src.height,
            "band_count": src.count,
            "dtype": src.dtypes[0] if src.dtypes else "",
            "nodata": src.nodata,
            "crs": src.crs,
            "transform": transform if georeferenced else None,
            "bounds": {
                "west": bounds.left,
                "south": bounds.bottom,
                "east": bounds.right,
                "north": bounds.top,
            } if georeferenced else None,
            "resolution": {
                "x": abs(res[0]),
                "y": abs(res[1]),
            } if georeferenced else None,
            "descriptions": [
                d if d else "" for d in src.descriptions
            ],
            "driver": src.driver,
            "is_georeferenced": georeferenced,
        }


def read_band(
    path: str | Path,
    band_index: int,
) -> np.ndarray:
    """Read a single band from a raster file as a 2D numpy array."""
    with open_raster(path) as src:
        if band_index < 1 or band_index > src.count:
            raise ValueError(
                f"Band index {band_index} out of range (1..{src.count})"
            )
        return src.read(band_index)


def read_all_bands(path: str | Path) -> np.ndarray:
    """Read all bands from a raster file as a 3D numpy array (bands, height, width)."""
    with open_raster(path) as src:
        return src.read()


def get_bounds(path: str | Path) -> dict[str, float]:
    """Return raster bounds as {west, south, east, north}.

    Raises:
        NotGeoreferencedError: the raster has no CRS/geotransform. rasterio would
            otherwise return identity-implied bounds derived from pixel counts,
            which are array indices rather than coordinates.
    """
    metadata = read_metadata(path)
    if not metadata["is_georeferenced"] or metadata["bounds"] is None:
        raise NotGeoreferencedError(
            f"{path} is not georeferenced, so it has no geographic bounds. "
            "Refusing to return identity-implied pixel bounds as coordinates."
        )
    return dict(metadata["bounds"])


def get_resolution(path: str | Path) -> dict[str, float]:
    """Return pixel resolution as {x, y} in CRS units.

    Raises:
        NotGeoreferencedError: the raster has no CRS/geotransform, so its
            "resolution" is the identity matrix's 1.0, not a ground distance.
    """
    metadata = read_metadata(path)
    if not metadata["is_georeferenced"] or metadata["resolution"] is None:
        raise NotGeoreferencedError(
            f"{path} is not georeferenced, so it has no ground resolution. "
            "Refusing to report the identity matrix's 1.0 as a pixel size."
        )
    return dict(metadata["resolution"])


def get_crs(path: str | Path) -> rasterio.crs.CRS | None:
    """Return the CRS of a raster, or None if not georeferenced."""
    with open_raster(path) as src:
        return src.crs if _crs_is_defined(src.crs) else None


def get_band_count(path: str | Path) -> int:
    """Return the number of bands in the raster."""
    with open_raster(path) as src:
        return src.count


# Integrity categories. A file's readability and its georeferencing are
# independent questions, and conflating them would either reject perfectly good
# visual-only images or let unmeasurable rasters into spatial analysis.
INTEGRITY_VISUAL_ONLY = "visual_only_valid"
INTEGRITY_ANALYSIS_READY = "georeferenced_analysis_ready"
INTEGRITY_INVALID = "invalid"


def classify_raster(path: str | Path) -> dict[str, Any]:
    """Classify a raster into exactly one integrity category.

    Returns a dict with ``integrity`` (one of the ``INTEGRITY_*`` constants) and
    the observed facts behind the decision. Every reported value is read from
    the file; nothing is inferred.

    * ``invalid`` — the file cannot be opened, parsed, or has impossible
      geometry (zero/negative dimensions or band count). It must not reach any
      analysis.
    * ``visual_only_valid`` — readable, but not georeferenced. Usable for
      VQA/caption and other pixel-domain work; *not* usable for area, AOI or
      any other measurement that needs real-world units.
    * ``georeferenced_analysis_ready`` — readable with a defined CRS *and* a
      non-identity transform, so spatial metadata is meaningful.
    """
    try:
        with open_raster(path) as src:
            width, height, count = int(src.width), int(src.height), int(src.count)
            src_crs = src.crs
            has_crs = _crs_is_defined(src_crs)
            transform = src.transform
            identity = _is_identity_transform(transform)
            usable = _is_real_geotransform(transform)
            dtypes = list(src.dtypes)
    except RasterError as exc:
        return {
            "integrity": INTEGRITY_INVALID,
            "isGeoreferenced": None,
            "reason": safe_error(exc, fallback="The file could not be read."),
        }

    if width <= 0 or height <= 0:
        return {
            "integrity": INTEGRITY_INVALID,
            "isGeoreferenced": False,
            "width": width,
            "height": height,
            "bandCount": count,
            "reason": f"Invalid raster dimensions: {width}x{height}.",
        }
    if count <= 0:
        return {
            "integrity": INTEGRITY_INVALID,
            "isGeoreferenced": False,
            "width": width,
            "height": height,
            "bandCount": count,
            "reason": f"Invalid band count: {count}.",
        }
    if has_crs and not usable and not identity:
        # A CRS is declared but the geotransform is degenerate (zero/non-finite
        # pixel size). The raster itself is still readable, so this is *not*
        # invalid: it is a non-georeferenced image whose footprint would
        # collapse to a point. Classified visual-only, with the reason spelled
        # out, and every spatial accessor refuses it.
        return {
            "integrity": INTEGRITY_VISUAL_ONLY,
            "isGeoreferenced": False,
            "width": width,
            "height": height,
            "bandCount": count,
            "dtypes": dtypes,
            "crs": str(src_crs) if src_crs is not None else None,
            "reason": (
                "The raster declares a CRS but its geotransform is degenerate "
                "(zero or non-finite pixel size), so it has no usable ground "
                "footprint. Pixel-domain analysis is available; area, AOI and "
                "other spatial measurements are not."
            ),
        }

    is_georeferenced = has_crs and usable
    if is_georeferenced:
        integrity, reason = INTEGRITY_ANALYSIS_READY, None
    else:
        integrity = INTEGRITY_VISUAL_ONLY
        reason = (
            "The raster is readable but not georeferenced (no CRS and/or no "
            "geotransform). Pixel-domain analysis (VQA, caption, spectral "
            "indices) is available; area, AOI and other spatial measurements are not."
        )

    return {
        "integrity": integrity,
        "isGeoreferenced": is_georeferenced,
        "width": width,
        "height": height,
        "bandCount": count,
        "dtypes": dtypes,
        "reason": reason,
    }


def get_nodata(path: str | Path) -> Any:
    """Return the nodata value of the first band, or None."""
    with open_raster(path) as src:
        return src.nodata


def is_band_all_nodata(path: str | Path, band_index: int) -> bool:
    """Check whether a specific band contains only nodata values."""
    with open_raster(path) as src:
        nodata = src.nodata
        if nodata is None:
            return False
        data = src.read(band_index)
        return bool(np.all(data == nodata))


def is_raster_empty(path: str | Path) -> bool:
    """Check whether all bands contain only nodata values."""
    with open_raster(path) as src:
        nodata = src.nodata
        if nodata is None:
            return False
        for i in range(1, src.count + 1):
            data = src.read(i)
            if not np.all(data == nodata):
                return False
        return True
