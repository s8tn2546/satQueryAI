"""Tests for the standardized spatial-metadata block on tool responses.

Every raster-consuming endpoint must publish the same top-level
``metadata.isGeoreferenced`` signal, so a consumer never has to infer
georeferencing from an absent field. Absent spatial values must be ``null``
with an explanation rather than a defaulted or invented number.
"""

from __future__ import annotations

import numpy as np
import pytest
import rasterio
from fastapi.testclient import TestClient
from rasterio.transform import from_origin

from app.main import app

client = TestClient(app)


# Every endpoint that accepts an image and reports on it, with the field name
# it uses and whether it needs explicitly labelled bands (NDVI/NDWI/change do).
# Endpoints whose fixture can be the plain 1-band no-CRS raster.
SINGLE_BAND_ENDPOINTS = [
    ("/validate", "file", "image.tif", False),
    ("/area", "file", "image.tif", False),
]

# All raster endpoints, including those needing explicitly labelled bands.
RASTER_ENDPOINTS = SINGLE_BAND_ENDPOINTS + [
    ("/ndvi", "file", "image.tif", True),
    ("/ndwi", "file", "image.tif", True),
]


def _post(path, field, name, path_on_disk, needs_bands):
    """POST one image (or two, for /change) choosing the right fixture."""
    with open(path_on_disk, "rb") as f:
        if path == "/change":
            with open(path_on_disk, "rb") as g:
                return client.post(
                    path,
                    files=[
                        (field, (name, f, "image/tiff")),
                        ("image2", ("after.tif", g, "image/tiff")),
                    ],
                )
        return client.post(path, files=[(field, (name, f, "image/tiff"))])


def _spatial(metadata):
    """Extract the standardized spatial keys, ignoring endpoint extras."""
    keys = (
        "isGeoreferenced",
        "crs",
        "resolution",
        "width",
        "height",
        "bandCount",
        "bounds",
        "dataQuality",
    )
    return {k: metadata.get(k) for k in keys}


# --------------------------------------------------------------------------
# Georeferenced input: real values must be published
# --------------------------------------------------------------------------


@pytest.mark.parametrize("path,field,name,needs_bands", RASTER_ENDPOINTS)
def test_georeferenced_input_publishes_is_georeferenced(
    path, field, name, needs_bands, georeferenced_raster, multiband_raster
):
    """A CRS + transform means every raster endpoint says so explicitly."""
    source = multiband_raster if needs_bands else georeferenced_raster
    res = _post(path, field, name, source, needs_bands)

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["status"] == "success", body["result"]
    metadata = body["metadata"]

    # Top-level signal must exist and be a real boolean, never inferred/absent.
    assert "isGeoreferenced" in metadata, metadata
    assert metadata["isGeoreferenced"] is True
    assert metadata["crs"] is not None
    assert metadata["bounds"] is not None
    assert metadata["resolution"] is not None
    assert metadata["width"] is not None
    assert metadata["height"] is not None


def test_change_publishes_per_image_spatial_facts(multiband_raster):
    """Two images can differ, so each reports its own georeference state."""
    with open(multiband_raster, "rb") as f, open(multiband_raster, "rb") as g:
        res = client.post(
            "/change",
            files=[
                ("image1", ("a.tif", f, "image/tiff")),
                ("image2", ("b.tif", g, "image/tiff")),
            ],
        )
    metadata = res.json()["metadata"]
    assert metadata["isGeoreferenced"] is True
    assert set(metadata["images"]) == {"image1", "image2"}
    for entry in metadata["images"].values():
        assert entry["isGeoreferenced"] is True
        assert entry["crs"] is not None
        assert entry["bounds"] is not None
        assert entry["resolution"] is not None


def test_validate_publishes_integrity_verdict(georeferenced_raster):
    with open(georeferenced_raster, "rb") as f:
        res = client.post("/validate", files={"file": ("valid.tif", f, "image/tiff")})
    body = res.json()
    assert body["result"]["integrity"] == "georeferenced_analysis_ready"
    assert body["result"]["is_georeferenced"] is True
    # The readiness verdict is also published at the top level.
    assert body["metadata"]["dataQuality"] == "georeferenced_analysis_ready"
    # wgs84 bounds are surfaced separately, never conflated with native CRS.
    assert body["metadata"]["wgs84Bounds"] is not None
    assert body["metadata"]["bounds"] != body["metadata"]["wgs84Bounds"]


# --------------------------------------------------------------------------
# Non-georeferenced input: nulls plus an explanation, never a default
# --------------------------------------------------------------------------


@pytest.mark.parametrize("path,field,name,needs_bands", SINGLE_BAND_ENDPOINTS)
def test_non_georeferenced_input_publishes_false_with_explanation(
    path, field, name, needs_bands, no_crs_raster
):
    """A raster with no CRS must report False and null spatial values.

    The endpoint may still succeed (NDVI/NDWI/change are pixel-domain or
    refuse separately), but it must never invent a CRS, bounds or a 1-unit
    resolution for a file that has none.
    """
    res = _post(path, field, name, no_crs_raster, needs_bands)

    body = res.json()
    metadata = body.get("metadata", {})

    if body["status"] != "success":
        # /area refuses outright; it must say *why* rather than guess.
        assert "resolution" in str(body["result"].get("error", "")).lower()
        return

    assert "isGeoreferenced" in metadata, metadata
    assert metadata["isGeoreferenced"] is False
    # Explicitly null, not defaulted to a plausible-looking value.
    assert metadata["crs"] is None
    assert metadata["bounds"] is None
    assert metadata["resolution"] is None
    # The consumer is told *why* the values are missing.
    assert "spatialMetadataUnavailable" in metadata
    assert "not georeferenced" in metadata["spatialMetadataUnavailable"]


def test_area_refuses_non_georeferenced_rather_than_guessing(no_crs_raster):
    """Area needs real-world units; with no resolution it must not invent one."""
    with open(no_crs_raster, "rb") as f:
        res = client.post("/area", files={"file": ("i.tif", f, "image/tiff")})
    body = res.json()
    assert body["status"] == "failed"
    assert "resolution" in body["result"]["error"].lower()
    # No area may be reported from an unmeasurable raster.
    result = body["result"]
    for key in ("area_km2", "area", "pixel_area_km2"):
        if key in result:
            assert result[key] is None


def test_spectral_index_still_works_without_georeferencing(tmp_path):
    """NDVI is pixel-domain: a non-georeferenced image is still usable."""
    path = tmp_path / "nogeo_multiband.tif"
    with rasterio.open(
        path, "w", driver="GTiff", width=10, height=10, count=4, dtype="uint16"
    ) as dst:
        dst.write(
            np.stack([np.full((10, 10), (i + 1) * 100, dtype="uint16") for i in range(4)])
        )
        for i, name in enumerate(["red", "green", "blue", "nir"]):
            dst.set_band_description(i + 1, name)

    with open(path, "rb") as f:
        res = client.post("/ndvi", files={"file": ("i.tif", f, "image/tiff")})

    body = res.json()
    # The computation succeeds ...
    assert body["status"] == "success"
    assert body["result"]["mean"] is not None
    # ... while the spatial claim stays honest.
    assert body["metadata"]["isGeoreferenced"] is False
    assert body["metadata"]["resolution"] is None
    assert "spatialMetadataUnavailable" in body["metadata"]


def test_change_reports_no_area_for_non_georeferenced_inputs(tmp_path):
    """Change may compare pixels, but must not report a real-world area."""
    path = tmp_path / "nogeo_multiband.tif"
    with rasterio.open(
        path, "w", driver="GTiff", width=10, height=10, count=4, dtype="uint16"
    ) as dst:
        dst.write(
            np.stack([np.full((10, 10), (i + 1) * 100, dtype="uint16") for i in range(4)])
        )
        for i, name in enumerate(["red", "green", "blue", "nir"]):
            dst.set_band_description(i + 1, name)

    with open(path, "rb") as f, open(path, "rb") as g:
        res = client.post(
            "/change",
            files=[
                ("image1", ("a.tif", f, "image/tiff")),
                ("image2", ("b.tif", g, "image/tiff")),
            ],
        )
    body = res.json()
    result = body["result"]

    assert body["metadata"]["isGeoreferenced"] is False
    # No real-world area may be fabricated from pixel counts.
    assert result["changed_area_km2"] is None
    assert result["aligned"] is False
    # And the reason must be stated in the result itself.
    assert any("not georeferenced" in w for w in result["warnings"])


def test_validate_plain_png_is_visual_only_valid(plain_png):
    """A plain PNG is a legitimate visual-only input, not an error."""
    with open(plain_png, "rb") as f:
        res = client.post("/validate", files={"file": ("image.png", f, "image/png")})
    assert res.status_code == 200
    body = res.json()
    assert body["result"]["valid"] is True
    assert body["result"]["is_georeferenced"] is False
    assert body["result"]["integrity"] == "visual_only_valid"
    assert body["metadata"]["isGeoreferenced"] is False
    assert body["metadata"]["crs"] is None


def test_validate_degenerate_transform_is_not_analysis_ready(tmp_path):
    """A CRS with a zero-area footprint must not be published as georeferenced.

    The file still opens, so it is reported as visual-only (pixel-domain work
    remains valid) — but crucially its collapsed zero-area extent and 0.0
    resolution must never reach the response.
    """
    path = tmp_path / "degenerate.tif"
    with rasterio.open(
        path, "w", driver="GTiff", width=4, height=4, count=1, dtype="uint16",
        crs="EPSG:32633", transform=from_origin(100.0, 40.0, 0.0, 0.0),
    ) as dst:
        dst.write(np.ones((1, 4, 4), dtype="uint16"))

    with open(path, "rb") as f:
        res = client.post("/validate", files={"file": ("degenerate.tif", f, "image/tiff")})

    result = res.json()["result"]
    assert result["is_georeferenced"] is False
    assert result["integrity"] == "visual_only_valid"
    # No zero-area "footprint" and no 0.0 resolution may be published.
    assert result["bounds"] is None
    assert result["resolution"] is None


def test_validate_corrupt_file_reports_invalid_with_reason(corrupt_file):
    with open(corrupt_file, "rb") as f:
        res = client.post("/validate", files={"file": ("corrupt.tif", f, "image/tiff")})
    body = res.json()
    assert body["result"]["valid"] is False
    assert body["result"]["integrity"] == "invalid"
    assert body["result"]["errors"]


def test_validate_early_rejection_still_reports_integrity():
    """Pre-decode failures must still carry the integrity contract."""
    res = client.post(
        "/validate", files={"file": ("bad.xyz", b"junk", "application/octet-stream")}
    )
    body = res.json()
    assert body["result"]["valid"] is False
    assert body["result"]["integrity"] == "invalid"
    assert body["result"]["is_georeferenced"] is None
