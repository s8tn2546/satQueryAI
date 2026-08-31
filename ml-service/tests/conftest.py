"""Shared pytest fixtures using synthetic rasters.

Uses rasterio MemoryFile and temporary GeoTIFF files so tests do
not depend on external satellite datasets.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_origin


@pytest.fixture
def georeferenced_raster(tmp_path: Path) -> Path:
    """A valid georeferenced single-band GeoTIFF."""
    path = tmp_path / "valid_georef.tif"
    data = np.arange(100, dtype=np.uint8).reshape(10, 10)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=10,
        height=10,
        count=1,
        dtype="uint8",
        crs=CRS.from_epsg(32643),
        transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(data, 1)
    return path


@pytest.fixture
def multiband_raster(tmp_path: Path) -> Path:
    """A georeferenced 4-band raster (optical-like, red/green/blue/nir)."""
    path = tmp_path / "multiband.tif"
    data = np.zeros((4, 10, 10), dtype=np.uint16)
    for i in range(4):
        data[i] = (i + 1) * 100
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=10,
        height=10,
        count=4,
        dtype="uint16",
        crs=CRS.from_epsg(32643),
        transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(data)
        dst.set_band_description(1, "red")
        dst.set_band_description(2, "green")
        dst.set_band_description(3, "blue")
        dst.set_band_description(4, "nir")
    return path


@pytest.fixture
def sar_like_raster(tmp_path: Path) -> Path:
    """A georeferenced 2-band raster with SAR-like band descriptions."""
    path = tmp_path / "sar.tif"
    data = np.zeros((2, 10, 10), dtype=np.float32)
    data[0] = 0.1
    data[1] = 0.2
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=10,
        height=10,
        count=2,
        dtype="float32",
        crs=CRS.from_epsg(32643),
        transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(data)
        dst.set_band_description(1, "VV")
        dst.set_band_description(2, "VH")
    return path


@pytest.fixture
def no_crs_raster(tmp_path: Path) -> Path:
    """A raster without CRS or geotransform metadata."""
    path = tmp_path / "no_crs.tif"
    data = np.zeros((10, 10), dtype=np.uint8)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=10,
        height=10,
        count=1,
        dtype="uint8",
    ) as dst:
        dst.write(data, 1)
    return path


@pytest.fixture
def nodata_raster(tmp_path: Path) -> Path:
    """A raster with a nodata value where some pixels are nodata."""
    path = tmp_path / "nodata.tif"
    data = np.full((10, 10), -9999, dtype=np.int16)
    data[2:8, 2:8] = 100
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=10,
        height=10,
        count=1,
        dtype="int16",
        nodata=-9999,
        crs=CRS.from_epsg(32643),
        transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(data, 1)
    return path


@pytest.fixture
def all_nodata_raster(tmp_path: Path) -> Path:
    """A raster where every pixel is nodata."""
    path = tmp_path / "all_nodata.tif"
    data = np.full((10, 10), -9999, dtype=np.int16)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=10,
        height=10,
        count=1,
        dtype="int16",
        nodata=-9999,
        crs=CRS.from_epsg(32643),
        transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(data, 1)
    return path


@pytest.fixture
def corrupt_file(tmp_path: Path) -> Path:
    """A file with a .tif extension that is not a valid raster."""
    path = tmp_path / "corrupt.tif"
    path.write_bytes(b"this is definitely not a valid geotiff file content")
    return path


@pytest.fixture
def plain_png(tmp_path: Path) -> Path:
    """A plain non-georeferenced PNG image."""
    from PIL import Image

    path = tmp_path / "plain.png"
    img = Image.new("RGB", (16, 16), color=(100, 150, 200))
    img.save(path)
    return path


@pytest.fixture
def empty_file(tmp_path: Path) -> Path:
    """An empty file with a supported extension."""
    path = tmp_path / "empty.tif"
    path.touch()
    return path


@pytest.fixture
def single_band_raster(tmp_path: Path) -> Path:
    """A single-band raster without band description."""
    path = tmp_path / "single_band.tif"
    data = np.zeros((10, 10), dtype=np.uint8)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=10,
        height=10,
        count=1,
        dtype="uint8",
        crs=CRS.from_epsg(32643),
        transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(data, 1)
    return path
