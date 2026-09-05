"""Image loading utilities.

Distinguishes between georeferenced rasters (readable by rasterio)
and ordinary images (readable by Pillow only). Provides a consistent
interface for initial inspection without loading unnecessary data
into memory.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from PIL import Image

from app.geospatial.raster_io import (
    RasterFormatError,
    is_raster_extension,
    read_metadata,
)

logger = logging.getLogger(__name__)

# Extensions that Pillow can handle but rasterio may not fully parse
PILLOW_ONLY_EXTENSIONS = {".bmp", ".gif", ".webp", ".tiff"}


class ImageLoadError(Exception):
    """Raised when an image cannot be loaded by any available reader."""


def can_read_as_raster(path: str | Path) -> bool:
    """Check whether rasterio can open the file.

    Does a quick open/read without loading band data.
    Returns True only if the file is a valid rasterio-readable format.
    """
    from app.geospatial.raster_io import open_raster

    try:
        with open_raster(path):
            return True
    except Exception:
        return False


def can_read_as_pillow(path: str | Path) -> bool:
    """Check whether Pillow can open the file."""
    try:
        with Image.open(path) as img:
            img.verify()
        return True
    except Exception:
        return False


def get_image_type(path: str | Path) -> str:
    """Determine the image type: 'raster', 'pillow', or 'unsupported'."""
    if can_read_as_raster(path):
        return "raster"
    if can_read_as_pillow(path):
        return "pillow"
    return "unsupported"


def load_metadata(path: str | Path, metadata_only: bool = True) -> dict[str, Any]:
    """Load metadata from an image file.

    Tries rasterio first (for georeferenced rasters).
    Falls back to Pillow for non-georeferenced images.
    If metadata_only=True, avoids loading pixel data into memory.
    """
    path = Path(path)
    if not path.exists():
        raise ImageLoadError(f"File not found: {path}")

    # Try rasterio first
    if can_read_as_raster(path):
        return read_metadata(path)

    # Fall back to Pillow
    if can_read_as_pillow(path):
        return _pillow_metadata(path)

    raise ImageLoadError(
        f"Cannot load image: unsupported format or corrupt file: {path}"
    )


def _pillow_metadata(path: Path) -> dict[str, Any]:
    """Extract metadata from a Pillow-readable image."""
    try:
        with Image.open(path) as img:
            width, height = img.size
            mode = img.mode
            bands = _pillow_mode_to_bands(mode)

            return {
                "width": width,
                "height": height,
                "band_count": len(bands),
                "dtype": "uint8",
                "nodata": None,
                "crs": None,
                "transform": None,
                "bounds": None,
                "resolution": None,
                "descriptions": bands,
                "driver": "PIL",
                "is_georeferenced": False,
                "pillow_mode": mode,
            }
    except Exception as exc:
        raise ImageLoadError(f"Pillow failed to read {path}: {exc}") from exc


def _pillow_mode_to_bands(mode: str) -> list[str]:
    """Map Pillow image mode to band descriptions."""
    mapping = {
        "L": ["grayscale"],
        "LA": ["grayscale", "alpha"],
        "RGB": ["red", "green", "blue"],
        "RGBA": ["red", "green", "blue", "alpha"],
        "P": ["palette"],
        "1": ["binary"],
        "I": ["int32"],
        "F": ["float32"],
    }
    return mapping.get(mode, [f"channel_{i}" for i in range(len(mode))])


def load_image_as_pil(path: str | Path) -> Image.Image:
    """Load an image as a PIL Image, handling both rasters and regular images.
    
    For rasters (GeoTIFF/TIFF), reads the first 3 bands as RGB or converts
    grayscale to RGB. For regular images (PNG/JPEG), loads directly.
    
    Args:
        path: Path to the image file
        
    Returns:
        PIL Image in RGB mode
        
    Raises:
        ImageLoadError: If the image cannot be loaded
    """
    import numpy as np
    import rasterio
    
    path = Path(path)
    if not path.exists():
        raise ImageLoadError(f"File not found: {path}")
    
    if can_read_as_raster(path):
        try:
            with rasterio.open(str(path)) as src:
                if src.count >= 3:
                    r = src.read(1)
                    g = src.read(2)
                    b = src.read(3)
                    
                    def normalize_band(band):
                        band = band.astype(np.float32)
                        valid = np.isfinite(band)
                        if not valid.any():
                            return np.zeros_like(band, dtype=np.uint8)
                        vmin, vmax = np.percentile(band[valid], [2, 98])
                        band = np.clip((band - vmin) / (vmax - vmin + 1e-8) * 255, 0, 255)
                        return band.astype(np.uint8)
                    
                    r = normalize_band(r)
                    g = normalize_band(g)
                    b = normalize_band(b)
                    
                    rgb = np.stack([r, g, b], axis=-1)
                    return Image.fromarray(rgb, mode="RGB")
                else:
                    band = src.read(1).astype(np.float32)
                    valid = np.isfinite(band)
                    if not valid.any():
                        band = np.zeros_like(band, dtype=np.uint8)
                    else:
                        vmin, vmax = np.percentile(band[valid], [2, 98])
                        band = np.clip((band - vmin) / (vmax - vmin + 1e-8) * 255, 0, 255)
                        band = band.astype(np.uint8)
                    gray = Image.fromarray(band, mode="L")
                    return gray.convert("RGB")
        except Exception as exc:
            raise ImageLoadError(f"Failed to load raster as PIL: {exc}") from exc
    
    try:
        img = Image.open(path)
        if img.mode != "RGB":
            img = img.convert("RGB")
        return img
    except Exception as exc:
        raise ImageLoadError(f"Failed to load image as PIL: {exc}") from exc
