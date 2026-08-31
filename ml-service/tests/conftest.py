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


@pytest.fixture
def unlabeled_multiband_raster(tmp_path: Path) -> Path:
    """A multiband raster whose bands carry NO descriptions.

    Used to verify that NDVI/NDWI fail honestly when band identities
    cannot be determined from metadata.
    """
    path = tmp_path / "unlabeled_multiband.tif"
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
    return path


@pytest.fixture
def geographic_raster(tmp_path: Path) -> Path:
    """A raster in a geographic (degree-based) CRS, EPSG:4326."""
    path = tmp_path / "geographic.tif"
    data = np.ones((10, 10), dtype=np.uint8)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=10,
        height=10,
        count=1,
        dtype="uint8",
        crs=CRS.from_epsg(4326),
        transform=from_origin(72.0, 19.0, 0.0001, 0.0001),
    ) as dst:
        dst.write(data, 1)
    return path


@pytest.fixture
def ndvi_ndwi_raster(tmp_path: Path) -> Path:
    """A multispectral raster with labelled RED/GREEN/NIR bands and a nodata zone.

    Values: band red=red_val, green=green_val, nir=nir_val; a 6x6 central
    region carries real values and the surrounding border is nodata.
    """
    path = tmp_path / "ndvi_ndwi.tif"
    nodata = -9999.0
    data = np.full((3, 10, 10), nodata, dtype=np.float32)
    data[0, 2:8, 2:8] = 200.0   # red
    data[1, 2:8, 2:8] = 260.0   # green
    data[2, 2:8, 2:8] = 500.0   # nir
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=10,
        height=10,
        count=3,
        dtype="float32",
        nodata=nodata,
        crs=CRS.from_epsg(32643),
        transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(data)
        dst.set_band_description(1, "red")
        dst.set_band_description(2, "green")
        dst.set_band_description(3, "nir")
    return path


def _write_geo_tif(
    path: Path,
    data: np.ndarray,
    crs_epsg: int = 32643,
    origin: tuple[float, float] = (500000, 4600000),
    res: float = 10.0,
    nodata=None,
    dtype=None,
) -> Path:
    """Write a georeferenced single-band GeoTIFF; return its path."""
    arr = np.asarray(data)
    if dtype is None:
        dtype = str(arr.dtype)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=arr.shape[1],
        height=arr.shape[0],
        count=1,
        dtype=dtype,
        nodata=nodata,
        crs=CRS.from_epsg(crs_epsg),
        transform=from_origin(origin[0], origin[1], res, res),
    ) as dst:
        dst.write(arr, 1)
    return path


def _write_non_geo_tif(path: Path, data: np.ndarray, dtype=None) -> Path:
    """Write a single-band, non-georeferenced GeoTIFF."""
    arr = np.asarray(data)
    if dtype is None:
        dtype = str(arr.dtype)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=arr.shape[1],
        height=arr.shape[0],
        count=1,
        dtype=dtype,
    ) as dst:
        dst.write(arr, 1)
    return path


@pytest.fixture
def change_identical_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Two identical georeferenced single-band rasters -> 0% change."""
    base = np.zeros((10, 10), dtype=np.uint8) + 50
    p1 = _write_geo_tif(tmp_path / "a1.tif", base)
    p2 = _write_geo_tif(tmp_path / "a2.tif", base)
    return p1, p2


@pytest.fixture
def change_known_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Two rasters with a known 3x3 changed block.

    image1 = 10 everywhere; image2 = 10 everywhere except a 3x3 block = 210
    (difference 200 in that block). With an explicit threshold of 50 this yields
    exactly 9 changed pixels.
    """
    a = np.full((10, 10), 10, dtype=np.uint16)
    b = np.full((10, 10), 10, dtype=np.uint16)
    b[2:5, 2:5] = 210
    p1 = _write_geo_tif(tmp_path / "b1.tif", a, dtype="uint16")
    p2 = _write_geo_tif(tmp_path / "b2.tif", b, dtype="uint16")
    return p1, p2


@pytest.fixture
def change_nodata_pair(tmp_path: Path) -> tuple[Path, Path]:
    """A pair where some pixels are nodata and must be excluded.

    10x10 ranges: image1 = 100 everywhere, image2 = 100 everywhere except a
    4x4 nodata block (must not count as change) and a 2x2 changed block = 300.
    """
    nodata = -9999
    a = np.full((10, 10), 100, dtype=np.int16)
    b = np.full((10, 10), 100, dtype=np.int16)
    b[3:7, 3:7] = nodata           # nodata region (16 px)
    b[1:3, 1:3] = 300              # changed region (4 px)
    p1 = _write_geo_tif(tmp_path / "n1.tif", a, nodata=None, dtype="int16")
    p2 = _write_geo_tif(tmp_path / "n2.tif", b, nodata=nodata, dtype="int16")
    return p1, p2


@pytest.fixture
def change_nan_pair(tmp_path: Path) -> tuple[Path, Path]:
    """A float pair containing NaN and Inf that must be excluded."""
    a = np.full((10, 10), 1.0, dtype=np.float32)
    b = np.full((10, 10), 1.0, dtype=np.float32)
    b[2:4, 2:4] = np.nan
    b[5, 5] = np.inf
    b[0, 0] = 50.0
    p1 = _write_geo_tif(tmp_path / "nan1.tif", a, dtype="float32", nodata=None)
    p2 = _write_geo_tif(tmp_path / "nan2.tif", b, dtype="float32", nodata=None)
    return p1, p2


@pytest.fixture
def change_nonoverlap_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Two georeferenced rasters with no spatial overlap."""
    a = np.zeros((10, 10), dtype=np.uint8)
    p1 = _write_geo_tif(tmp_path / "no1.tif", a, origin=(500000, 4600000))
    p2 = _write_geo_tif(tmp_path / "no2.tif", a, origin=(700000, 4600000))
    return p1, p2


@pytest.fixture
def change_diff_crs_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Two overlapping rasters in different UTM zones -> reprojection path.

    p2's origin is placed (in ESPG:32644) so that its footprint overlaps p1
    (in EPSG:32643) after transformation, guaranteeing the reprojection path.
    """
    a = np.zeros((10, 10), dtype=np.uint8)
    b = np.zeros((10, 10), dtype=np.uint8)
    p1 = _write_geo_tif(tmp_path / "c1.tif", a, crs_epsg=32643, origin=(500000, 4600000))
    p2 = _write_geo_tif(tmp_path / "c2.tif", b, crs_epsg=32644, origin=(-500, 4617400))
    return p1, p2


@pytest.fixture
def change_diff_transform_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Same CRS, same pixels, but a shifted transform origin -> reprojection."""
    a = np.zeros((10, 10), dtype=np.uint8)
    b = np.full((10, 10), 0, dtype=np.uint8)
    p1 = _write_geo_tif(tmp_path / "t1.tif", a, origin=(500000, 4600000))
    p2 = _write_geo_tif(tmp_path / "t2.tif", b, origin=(500010, 4600000))
    return p1, p2


@pytest.fixture
def change_diff_dims_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Two non-georeferenced rasters with different dimensions -> fail."""
    p1 = _write_non_geo_tif(tmp_path / "d1.tif", np.zeros((8, 8), dtype=np.uint8))
    p2 = _write_non_geo_tif(tmp_path / "d2.tif", np.zeros((10, 10), dtype=np.uint8))
    return p1, p2


@pytest.fixture
def change_mixed_georef_pair(tmp_path: Path) -> tuple[Path, Path]:
    """One georeferenced image and one not -> cannot compare."""
    p1 = _write_geo_tif(tmp_path / "m1.tif", np.zeros((10, 10), dtype=np.uint8))
    p2 = _write_non_geo_tif(tmp_path / "m2.tif", np.zeros((10, 10), dtype=np.uint8))
    return p1, p2


def _write_fusion_multiband(
    tmp_path: Path, name: str, red, green, nir, nodata=None
) -> Path:
    """Write a labelled RED/GREEN/NIR optical-like multiband GeoTIFF."""
    path = tmp_path / name
    data = np.stack([np.full((10, 10), red), np.full((10, 10), green),
                     np.full((10, 10), nir)]).astype(np.float32)
    if nodata is not None:
        mask = data == nodata
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=10,
        height=10,
        count=3,
        dtype="float32",
        nodata=nodata,
        crs=CRS.from_epsg(32643),
        transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(data)
        dst.set_band_description(1, "red")
        dst.set_band_description(2, "green")
        dst.set_band_description(3, "nir")
    return path


def _write_fusion_optical_single(path: Path, value) -> Path:
    """Write an unlabelled single-band optical-like raster (unknown modality)."""
    return _write_geo_tif(path, np.full((10, 10), value, dtype=np.uint8))


@pytest.fixture
def fusion_paired_rasters(tmp_path: Path) -> tuple[Path, Path]:
    """Optical (multiband NDVI) + SAR (VV) aligned to the same grid (direct)."""
    optical = _write_fusion_multiband(tmp_path, "opt.tif", red=100, green=200, nir=400)
    sar = tmp_path / "sar.tif"
    data = np.full((10, 10), 0.1, dtype=np.float32)
    with rasterio.open(
        sar, "w", driver="GTiff", width=10, height=10, count=2, dtype="float32",
        crs=CRS.from_epsg(32643), transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(np.stack([data, data + 0.1]))
        dst.set_band_description(1, "VV")
        dst.set_band_description(2, "VH")
    return optical, sar


@pytest.fixture
def fusion_nonoverlap_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Same CRS/grid but footprints do not overlap -> failure."""
    optical = _write_fusion_multiband(tmp_path, "opt.tif", red=100, green=200, nir=400)
    sar = _write_geo_tif(tmp_path / "far_sar.tif", np.full((10, 10), 0.1), origin=(700000, 4600000))
    return optical, sar


@pytest.fixture
def fusion_diff_crs_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Overlapping optical (EPSG:32643) and SAR (EPSG:32644) -> reproject."""
    optical = _write_fusion_multiband(tmp_path, "opt.tif", red=100, green=200, nir=400)
    sar = _write_geo_tif(tmp_path / "sar.tif", np.full((10, 10), 0.1),
                         crs_epsg=32644, origin=(-500, 4617400))
    return optical, sar


@pytest.fixture
def fusion_missing_crs_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Optical is georeferenced but SAR is not -> cannot align."""
    optical = _write_fusion_multiband(tmp_path, "opt.tif", red=100, green=200, nir=400)
    sar = _write_non_geo_tif(tmp_path / "sar.tif", np.full((10, 10), 0.1))
    return optical, sar


@pytest.fixture
def fusion_unknown_modality_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Optical is a single unlabelled band (unknown modality) -> warning."""
    optical = _write_fusion_optical_single(tmp_path / "opt.tif", 50)
    sar = tmp_path / "sar.tif"
    data = np.full((10, 10), 0.1, dtype=np.float32)
    with rasterio.open(
        sar, "w", driver="GTiff", width=10, height=10, count=2, dtype="float32",
        crs=CRS.from_epsg(32643), transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(np.stack([data, data + 0.1]))
        dst.set_band_description(1, "VV")
        dst.set_band_description(2, "VH")
    return optical, sar


@pytest.fixture
def fusion_nodata_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Optical has a nodata border; SAR overlaps the same full footprint."""
    optical = _write_fusion_multiband(
        tmp_path, "opt.tif",
        red=100, green=200, nir=400,
        nodata=-9999.0,
    )
    # Overwrite the optical file with a nodata border around a 6x6 core.
    with rasterio.open(
        optical, "w", driver="GTiff", width=10, height=10, count=3, dtype="float32",
        nodata=-9999.0, crs=CRS.from_epsg(32643), transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        data = np.full((3, 10, 10), -9999.0, dtype=np.float32)
        data[0, 2:8, 2:8] = 100
        data[1, 2:8, 2:8] = 200
        data[2, 2:8, 2:8] = 400
        dst.write(data)
        dst.set_band_description(1, "red")
        dst.set_band_description(2, "green")
        dst.set_band_description(3, "nir")
    sar = tmp_path / "sar.tif"
    data_sar = np.full((2, 10, 10), 0.1, dtype=np.float32)
    with rasterio.open(
        sar, "w", driver="GTiff", width=10, height=10, count=2, dtype="float32",
        crs=CRS.from_epsg(32643), transform=from_origin(500000, 4600000, 10, 10),
    ) as dst:
        dst.write(data_sar)
        dst.set_band_description(1, "VV")
        dst.set_band_description(2, "VH")
    return optical, sar
