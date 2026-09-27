"""End-to-end AOI tests for the HTTP endpoints.

The AOI must genuinely constrain the analysis, not merely be echoed back: these
tests assert that measurements differ from the whole-scene result, that the
response states what was actually applied, and that an unusable AOI fails
loudly instead of silently returning an unscoped number.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def _aoi(aoi: dict) -> dict:
    """Form payload for an AOI, sent the way the backend sends it."""
    return {"aoi_geometry": json.dumps(aoi)}


# --------------------------------------------------------------------------- #
# NDVI                                                                         #
# --------------------------------------------------------------------------- #


class TestNdviAoi:
    def test_aoi_restricts_the_measurement(self, multiband_raster, small_central_aoi):
        with open(multiband_raster, "rb") as f:
            whole = client.post("/ndvi", files={"file": ("m.tif", f, "image/tiff")}).json()
        with open(multiband_raster, "rb") as f:
            scoped = client.post(
                "/ndvi", files={"file": ("m.tif", f, "image/tiff")}, data=_aoi(small_central_aoi)
            ).json()

        assert whole["status"] == scoped["status"] == "success"
        # A 3x3 AOI on a 10x10 raster must analyze far fewer pixels.
        assert scoped["result"]["valid_pixel_count"] == 9
        assert whole["result"]["valid_pixel_count"] == 100
        assert scoped["result"]["total_pixel_count"] < whole["result"]["total_pixel_count"]

    def test_aoi_report_is_returned(self, multiband_raster, central_aoi):
        with open(multiband_raster, "rb") as f:
            body = client.post(
                "/ndvi", files={"file": ("m.tif", f, "image/tiff")}, data=_aoi(central_aoi)
            ).json()

        assert body["status"] == "success"
        aoi = body["result"]["aoi"]
        assert aoi["aoiApplied"] is True
        assert aoi["aoiStatus"] == "applied"
        assert aoi["aoiScope"] == "raster_window+mask"
        assert aoi["isGeoreferenced"] is True
        assert aoi["aoiMaskedPixels"] == 36
        assert aoi["aoiCrs"] == "EPSG:32643"
        assert aoi["aoiCrsSource"] == "explicit"
        assert aoi["originalDimensions"] == {"width": 10, "height": 10}
        assert aoi["analyzedDimensions"] == {"width": 6, "height": 6}
        # Also surfaced in the response metadata, next to the raw request.
        assert body["metadata"]["aoi"]["aoiApplied"] is True
        assert body["metadata"]["aoi_geometry"]["type"] == "Polygon"

    def test_no_aoi_leaves_behaviour_unchanged(self, multiband_raster):
        with open(multiband_raster, "rb") as f:
            body = client.post("/ndvi", files={"file": ("m.tif", f, "image/tiff")}).json()
        assert body["result"]["aoi"]["aoiPresent"] is False
        assert body["result"]["aoi"]["aoiApplied"] is False
        assert body["result"]["valid_pixel_count"] == 100
        assert body["result"]["mean"] == pytest.approx(0.6, abs=1e-6)
        assert "aoi_geometry" not in body["metadata"]

    def test_aoi_outside_raster_fails_with_a_reason(self, multiband_raster, outside_aoi):
        with open(multiband_raster, "rb") as f:
            body = client.post(
                "/ndvi", files={"file": ("m.tif", f, "image/tiff")}, data=_aoi(outside_aoi)
            ).json()

        assert body["status"] == "failed"
        assert body["confidence"] == 0.0
        assert "does not intersect" in body["result"]["error"]
        report = body["metadata"]["aoi"]
        assert report["aoiApplied"] is False
        assert report["aoiStatus"] == "rejected_outside_raster"
        # The requested geometry is still echoed so the request is traceable.
        assert body["metadata"]["aoi_geometry"]["type"] == "Polygon"

    def test_invalid_aoi_geometry_fails(self, multiband_raster):
        with open(multiband_raster, "rb") as f:
            body = client.post(
                "/ndvi",
                files={"file": ("m.tif", f, "image/tiff")},
                data={"aoi_geometry": json.dumps({"type": "Point", "coordinates": [1, 2]})},
            ).json()
        assert body["status"] == "failed"
        assert "Unsupported AOI geometry type" in body["result"]["error"]
        assert body["metadata"]["aoi"]["aoiStatus"] == "rejected_invalid_geometry"

    def test_malformed_aoi_json_fails(self, multiband_raster):
        with open(multiband_raster, "rb") as f:
            body = client.post(
                "/ndvi",
                files={"file": ("m.tif", f, "image/tiff")},
                data={"aoi_geometry": "{not json"},
            ).json()
        assert body["status"] == "failed"
        assert "not valid JSON" in body["result"]["error"]

    def test_unparseable_aoi_crs_fails(self, multiband_raster, central_aoi):
        with open(multiband_raster, "rb") as f:
            body = client.post(
                "/ndvi",
                files={"file": ("m.tif", f, "image/tiff")},
                data={**_aoi(central_aoi), "aoi_crs": "not-a-crs"},
            ).json()
        assert body["status"] == "failed"
        assert "could not be parsed" in body["result"]["error"]
        assert body["metadata"]["aoi"]["aoiStatus"] == "rejected_crs_mismatch"

    def test_aoi_crs_field_overrides_the_rfc7946_default(self, multiband_raster):
        """UTM coordinates with an explicit aoi_crs work; without it they cannot."""
        utm_aoi = {
            "type": "Polygon",
            "coordinates": [[[500020.0, 4599920.0], [500080.0, 4599920.0],
                             [500080.0, 4599980.0], [500020.0, 4599980.0],
                             [500020.0, 4599920.0]]],
        }
        with open(multiband_raster, "rb") as f:
            explicit = client.post(
                "/ndvi",
                files={"file": ("m.tif", f, "image/tiff")},
                data={**_aoi(utm_aoi), "aoi_crs": "EPSG:32643"},
            ).json()
        assert explicit["status"] == "success"
        assert explicit["result"]["aoi"]["aoiCrs"] == "EPSG:32643"
        assert explicit["result"]["aoi"]["aoiCrsSource"] == "explicit"
        assert explicit["result"]["aoi"]["crsTransformed"] is False

        with open(multiband_raster, "rb") as f:
            assumed = client.post(
                "/ndvi", files={"file": ("m.tif", f, "image/tiff")}, data=_aoi(utm_aoi)
            ).json()
        # Read as WGS84 degrees, it is nowhere near the raster: no silent crop.
        assert assumed["status"] == "failed"
        assert assumed["metadata"]["aoi"]["aoiStatus"] == "rejected_outside_raster"

    def test_bare_wgs84_aoi_works_on_a_wgs84_raster(
        self, geographic_raster, geographic_central_aoi
    ):
        with open(geographic_raster, "rb") as f:
            body = client.post(
                "/ndvi",
                files={"file": ("g.tif", f, "image/tiff")},
                data={**_aoi(geographic_central_aoi), "red_band": "1", "nir_band": "1"},
            ).json()
        # red == nir -> rejected, but only AFTER the AOI was applied.
        assert body["status"] == "failed"
        assert "same band index" in body["result"]["error"]

    def test_non_georeferenced_image_refuses_to_be_clipped(self, plain_png, central_aoi):
        with open(plain_png, "rb") as f:
            body = client.post(
                "/ndvi",
                files={"file": ("p.png", f, "image/png")},
                data={**_aoi(central_aoi), "red_band": "1", "nir_band": "1"},
            ).json()
        assert body["status"] == "failed"
        report = body["metadata"]["aoi"]
        assert report["aoiStatus"] == "not_applied_raster_not_georeferenced"
        assert report["isGeoreferenced"] is False
        assert report["aoiApplied"] is False
        assert "NOT performed" in body["result"]["error"]

    def test_non_georeferenced_image_still_works_without_an_aoi(self, plain_png):
        with open(plain_png, "rb") as f:
            body = client.post(
                "/ndvi",
                files={"file": ("p.png", f, "image/png")},
                data={"red_band": "1", "nir_band": "2"},
            ).json()
        assert body["status"] == "success"
        assert body["result"]["aoi"]["aoiPresent"] is False


# --------------------------------------------------------------------------- #
# NDWI                                                                         #
# --------------------------------------------------------------------------- #


class TestNdwiAoi:
    def test_aoi_restricts_the_measurement(self, multiband_raster, small_central_aoi):
        with open(multiband_raster, "rb") as f:
            body = client.post(
                "/ndwi", files={"file": ("m.tif", f, "image/tiff")}, data=_aoi(small_central_aoi)
            ).json()
        assert body["status"] == "success"
        assert body["result"]["valid_pixel_count"] == 9
        assert body["result"]["aoi"]["aoiApplied"] is True

    def test_outside_aoi_fails(self, multiband_raster, outside_aoi):
        with open(multiband_raster, "rb") as f:
            body = client.post(
                "/ndwi", files={"file": ("m.tif", f, "image/tiff")}, data=_aoi(outside_aoi)
            ).json()
        assert body["status"] == "failed"
        assert body["metadata"]["aoi"]["aoiStatus"] == "rejected_outside_raster"


# --------------------------------------------------------------------------- #
# Area                                                                         #
# --------------------------------------------------------------------------- #


class TestAreaAoi:
    def test_area_is_measured_inside_the_aoi_only(self, nodata_raster, small_central_aoi):
        with open(nodata_raster, "rb") as f:
            whole = client.post("/area", files={"file": ("a.tif", f, "image/tiff")}).json()
        with open(nodata_raster, "rb") as f:
            scoped = client.post(
                "/area", files={"file": ("a.tif", f, "image/tiff")}, data=_aoi(small_central_aoi)
            ).json()

        # Whole scene: 36 valid px at 10 m -> 3600 m2. AOI: 9 px -> 900 m2.
        assert whole["result"]["area_m2"] == pytest.approx(3600.0, abs=0.01)
        assert scoped["result"]["area_m2"] == pytest.approx(900.0, abs=0.01)
        assert scoped["result"]["valid_pixel_count"] == 9
        assert scoped["result"]["aoi"]["aoiApplied"] is True
        assert scoped["result"]["aoi"]["aoiScope"] == "raster_window+mask"

    def test_outside_aoi_fails(self, nodata_raster, outside_aoi):
        with open(nodata_raster, "rb") as f:
            body = client.post(
                "/area", files={"file": ("a.tif", f, "image/tiff")}, data=_aoi(outside_aoi)
            ).json()
        assert body["status"] == "failed"
        assert body["metadata"]["aoi"]["aoiStatus"] == "rejected_outside_raster"

    def test_geographic_crs_refusal_keeps_the_aoi_report(self, geographic_raster):
        """The AOI is applied first, then the degrees-vs-metres refusal is honest."""
        aoi = {
            "type": "Polygon",
            "coordinates": [[[72.0002, 18.9992], [72.0008, 18.9992],
                             [72.0008, 18.9998], [72.0002, 18.9998],
                             [72.0002, 18.9992]]],
        }
        with open(geographic_raster, "rb") as f:
            body = client.post(
                "/area", files={"file": ("g.tif", f, "image/tiff")}, data=_aoi(aoi)
            ).json()
        assert body["status"] == "failed"
        assert "geographic" in body["result"]["error"].lower()
        assert body["metadata"]["aoi"]["aoiApplied"] is True
        assert body["metadata"]["aoi"]["analyzedDimensions"]["width"] >= 6


# --------------------------------------------------------------------------- #
# Change                                                                       #
# --------------------------------------------------------------------------- #


class TestChangeAoi:
    def test_aoi_restricts_the_changed_pixel_count(
        self, change_known_pair, whole_scene_aoi, top_left_aoi
    ):
        p1, p2 = change_known_pair
        data = {"threshold": "50"}

        with open(p1, "rb") as a, open(p2, "rb") as b:
            whole = client.post(
                "/change",
                files={"image1": ("a.tif", a, "image/tiff"), "image2": ("b.tif", b, "image/tiff")},
                data=data,
            ).json()
        with open(p1, "rb") as a, open(p2, "rb") as b:
            scoped = client.post(
                "/change",
                files={"image1": ("a.tif", a, "image/tiff"), "image2": ("b.tif", b, "image/tiff")},
                data={**data, **_aoi(whole_scene_aoi)},
            ).json()
        with open(p1, "rb") as a, open(p2, "rb") as b:
            excluded = client.post(
                "/change",
                files={"image1": ("a.tif", a, "image/tiff"), "image2": ("b.tif", b, "image/tiff")},
                data={**data, **_aoi(top_left_aoi)},
            ).json()

        assert whole["result"]["changed_pixels"] == 9
        assert scoped["result"]["changed_pixels"] == 9
        # The changed 3x3 block lies outside the top-left 2x2 AOI.
        assert excluded["status"] == "success"
        assert excluded["result"]["changed_pixels"] == 0
        assert excluded["result"]["aoi"]["aoiApplied"] is True

    def test_both_dates_are_reported_as_clipped(self, change_known_pair, central_aoi):
        p1, p2 = change_known_pair
        with open(p1, "rb") as a, open(p2, "rb") as b:
            body = client.post(
                "/change",
                files={"image1": ("a.tif", a, "image/tiff"), "image2": ("b.tif", b, "image/tiff")},
                data={**_aoi(central_aoi), "threshold": "50"},
            ).json()
        assert body["status"] == "success"
        aoi = body["result"]["aoi"]
        assert aoi["aoiApplied"] is True
        assert aoi["aoiScope"] == "raster_window+mask"
        assert [img["image"] for img in aoi["images"]] == ["image1", "image2"]
        for image in aoi["images"]:
            assert image["aoiApplied"] is True
            assert image["aoiMaskedPixels"] == 36

    def test_aoi_outside_only_one_date_fails(
        self, change_known_pair, small_central_aoi, outside_aoi
    ):
        """AOI is intersected with each date; it must not clip only one of them."""
        p1, p2 = change_known_pair
        multi = {
            "type": "MultiPolygon",
            "crs": "EPSG:32643",
            "coordinates": [
                small_central_aoi["coordinates"],
                outside_aoi["coordinates"],
            ],
        }
        with open(p1, "rb") as a, open(p2, "rb") as b:
            body = client.post(
                "/change",
                files={"image1": ("a.tif", a, "image/tiff"), "image2": ("b.tif", b, "image/tiff")},
                data=_aoi(multi),
            ).json()
        assert body["status"] == "success"
        # The disjoint far-away part is clipped away; only the near block remains.
        assert body["result"]["aoi"]["images"][0]["aoiBounds"]["west"] == pytest.approx(500020.0)


# --------------------------------------------------------------------------- #
# VQA / caption (window-only, and honest when offline)                         #
# --------------------------------------------------------------------------- #


class TestVlmAoi:
    def test_offline_vqa_does_not_claim_aoi_scoped_analysis(self, plain_png, central_aoi):
        with open(plain_png, "rb") as f:
            body = client.post(
                "/vqa",
                files={"image": ("p.png", f, "image/png")},
                data={"question": "Is there water?", **_aoi(central_aoi)},
            ).json()
        if body["metadata"].get("mock"):
            report = body["metadata"]["aoi"]
            assert report["aoiApplied"] is False
            assert report["aoiStatus"] == "not_applied_offline_placeholder"
            assert "not applied" in report["reason"]

    def test_offline_caption_does_not_claim_aoi_scoped_analysis(self, plain_png, central_aoi):
        with open(plain_png, "rb") as f:
            body = client.post(
                "/caption",
                files={"image": ("p.png", f, "image/png")},
                data=_aoi(central_aoi),
            ).json()
        if body["metadata"].get("mock"):
            report = body["metadata"]["aoi"]
            assert report["aoiApplied"] is False
            assert report["aoiStatus"] == "not_applied_offline_placeholder"

    def test_vqa_rejects_an_aoi_on_a_non_georeferenced_image(self, plain_png, central_aoi):
        with open(plain_png, "rb") as f:
            body = client.post(
                "/vqa",
                files={"image": ("p.png", f, "image/png")},
                data={"question": "Is there water?", **_aoi(central_aoi)},
            ).json()
        assert body["status"] == "failed"
        assert body["metadata"]["aoi"]["aoiStatus"] == "not_applied_raster_not_georeferenced"


# --------------------------------------------------------------------------- #
# Optical-SAR fusion                                                          #
# --------------------------------------------------------------------------- #


class TestFusionAoi:
    def test_aoi_is_applied_to_both_modalities(
        self, fusion_paired_rasters, small_central_aoi
    ):
        optical, sar = fusion_paired_rasters
        with open(optical, "rb") as o, open(sar, "rb") as s:
            body = client.post(
                "/optical-sar",
                files={"optical_image": ("o.tif", o, "image/tiff"), "sar_image": ("s.tif", s, "image/tiff")},
                data=_aoi(small_central_aoi),
            ).json()
        assert body["status"] == "success"
        aoi = body["result"]["aoi"]
        assert aoi["aoiApplied"] is True
        assert aoi["aoiScope"] == "raster_window+mask"
        assert [img["image"] for img in aoi["images"]] == ["optical", "sar"]
        for image in aoi["images"]:
            assert image["aoiMaskedPixels"] == 9
            assert image["analyzedDimensions"] == {"width": 3, "height": 3}

    def test_outside_aoi_fails(self, fusion_paired_rasters, outside_aoi):
        optical, sar = fusion_paired_rasters
        with open(optical, "rb") as o, open(sar, "rb") as s:
            body = client.post(
                "/optical-sar",
                files={"optical_image": ("o.tif", o, "image/tiff"), "sar_image": ("s.tif", s, "image/tiff")},
                data=_aoi(outside_aoi),
            ).json()
        assert body["status"] == "failed"
        assert body["metadata"]["aoi"]["aoiStatus"] == "rejected_outside_raster"


# --------------------------------------------------------------------------- #
# Contract preservation                                                        #
# --------------------------------------------------------------------------- #


class TestToolOutputContract:
    def test_top_level_keys_are_unchanged(self, multiband_raster, small_central_aoi):
        with open(multiband_raster, "rb") as f:
            without = client.post("/ndvi", files={"file": ("m.tif", f, "image/tiff")}).json()
        with open(multiband_raster, "rb") as f:
            with_aoi = client.post(
                "/ndvi", files={"file": ("m.tif", f, "image/tiff")}, data=_aoi(small_central_aoi)
            ).json()
        assert set(without) == set(with_aoi) == {"tool", "status", "result", "evidence", "confidence", "metadata"}
        # The AOI block is additive: it does not displace existing result keys.
        assert set(without["result"]) - {"aoi"} <= set(with_aoi["result"])


# --------------------------------------------------------------------------- #
# VQA / caption window scope: the image handed to the VLM is a plain window,  #
# never polygon-masked. `_run_vqa` / `_run_caption` are stubbed so the test   #
# can inspect the file the model would actually receive (real weights are not #
# available in CI).                                                          #
# --------------------------------------------------------------------------- #


class TestVlmWindowScope:
    def test_vqa_hands_the_model_an_unmasked_window(self, georeferenced_raster, small_central_aoi, monkeypatch):
        import rasterio

        from app.tools import vqa as vqa_tool

        seen = {}

        def fake_run_vqa(image_path, question, model_name=None, adapter_path=None):
            with rasterio.open(image_path) as ds:
                seen["width"], seen["height"] = ds.width, ds.height
                seen["masked"] = int((ds.dataset_mask() > 0).sum())
            return {"answer": "water", "question": question, "confidence": 0.9}

        monkeypatch.setattr(vqa_tool, "_run_vqa", fake_run_vqa)

        result = vqa_tool.compute_vqa(georeferenced_raster, "water?", aoi=small_central_aoi)

        # A 3x3 AOI on a 10x10 raster -> a 3x3 window, fully unmasked.
        assert (seen["width"], seen["height"]) == (3, 3)
        assert seen["masked"] == 9, "VQA must receive a plain window, not a polygon mask"
        assert result["aoi"]["aoiScope"] == "raster_window"
        assert result["aoi"]["aoiApplied"] is True
        assert result["aoi"]["aoiMaskedPixels"] is None

    def test_caption_hands_the_model_an_unmasked_window(self, georeferenced_raster, small_central_aoi, monkeypatch):
        import rasterio

        from app.tools import caption as caption_tool

        seen = {}

        def fake_run_caption(image_path, model_name=None, adapter_path=None):
            with rasterio.open(image_path) as ds:
                seen["width"], seen["height"] = ds.width, ds.height
                seen["masked"] = int((ds.dataset_mask() > 0).sum())
            return {"caption": "a cropped tile", "confidence": 0.9}

        monkeypatch.setattr(caption_tool, "_run_caption", fake_run_caption)

        result = caption_tool.compute_caption(georeferenced_raster, aoi=small_central_aoi)

        assert (seen["width"], seen["height"]) == (3, 3)
        assert seen["masked"] == 9, "caption must receive a plain window, not a polygon mask"
        assert result["aoi"]["aoiScope"] == "raster_window"
        assert result["aoi"]["aoiMaskedPixels"] is None

    def test_vlm_window_scope_differs_from_the_masked_analysis_scope(
        self, georeferenced_raster, central_aoi
    ):
        """One AOI must yield two honestly different scopes, not one vague claim."""
        from app.tools.roi_crop import SCOPE_MASKED, SCOPE_WINDOW, aoi_scope as aoi_scope_cm

        with aoi_scope_cm(georeferenced_raster, central_aoi) as masked:
            assert masked.scope == SCOPE_MASKED
            assert masked.aoi_masked_pixels == 36
        with aoi_scope_cm(georeferenced_raster, central_aoi, apply_mask=False) as window:
            assert window.scope == SCOPE_WINDOW
            assert window.aoi_masked_pixels is None
