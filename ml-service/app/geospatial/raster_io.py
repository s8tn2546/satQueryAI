"""Raster I/O operations using rasterio.

Provides safe functions for opening, reading metadata from, and
extracting band data from raster files (GeoTIFF, TIFF, and
rasterio-readable PNG/JPEG).
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Generator

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import Affine

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
        has_transform = not _is_identity_transform(transform)
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
    """Return raster bounds as {west, south, east, north}."""
    with open_raster(path) as src:
        b = src.bounds
        return {"west": b.left, "south": b.bottom, "east": b.right, "north": b.top}


def get_resolution(path: str | Path) -> dict[str, float]:
    """Return pixel resolution as {x, y} in CRS units."""
    with open_raster(path) as src:
        res = src.res
        return {"x": abs(res[0]), "y": abs(res[1])}


def get_crs(path: str | Path) -> rasterio.crs.CRS | None:
    """Return the CRS of a raster, or None if not georeferenced."""
    with open_raster(path) as src:
        return src.crs if _crs_is_defined(src.crs) else None


def get_band_count(path: str | Path) -> int:
    """Return the number of bands in the raster."""
    with open_raster(path) as src:
        return src.count


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
