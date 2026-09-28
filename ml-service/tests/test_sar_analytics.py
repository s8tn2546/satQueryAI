"""SAR-specific analytics tests.

These cover the SAR hardening contract: value-representation detection is
evidence-only (never guessed from magnitude), polarization resolution comes
from explicit band descriptions (never from position), physical VV/VH ratios
are withheld unless a linear representation is known, and the fusion layer
reports per-polarization statistics, coverage and relationship honestly.

All rasters here are synthetic and clearly labelled as such; no real
satellite data is required.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.tools.fusion import FusionValidationError, run_optical_sar_fusion
from app.tools.sar_analytics import (
    REP_DB,
    REP_LINEAR_AMPLITUDE,
    REP_LINEAR_POWER,
    REP_UNKNOWN,
    SarValidationError,
    band_stats,
    classify_sar_representation,
    relationship_metrics,
    require_polarizations,
    resolve_sar_polarizations,
)


# --------------------------------------------------------------------------- #
# resolve_sar_polarizations                                                    #
# --------------------------------------------------------------------------- #


class TestResolvePolarizations:
    def test_plain_vv_vh_descriptions(self):
        pol = resolve_sar_polarizations(["VV", "VH"], 2)
        assert pol["vv"] == 1
        assert pol["vh"] == 2
        assert pol["hh"] is None and pol["hv"] is None
        assert pol["composite"] == []
        assert pol["unidentified"] == []
        assert pol["method"] == "descriptions"

    def test_prefixed_and_suffixed_descriptions(self):
        pol = resolve_sar_polarizations(["sigma0_VV_db", "gamma0_VH"], 2)
        assert pol["vv"] == 1
        assert pol["vh"] == 2

    def test_composite_descriptions_are_never_single_pols(self):
        pol = resolve_sar_polarizations(["VV+VH"], 1)
        assert pol["composite"] == [1]
        assert pol["vv"] is None and pol["vh"] is None

    def test_double_polarization_composite(self):
        pol = resolve_sar_polarizations(["VVVH"], 1)
        assert pol["composite"] == [1]

    def test_duplicate_polarization_keeps_first_occurrence(self):
        pol = resolve_sar_polarizations(["VV", "VV", "VH"], 3)
        assert pol["vv"] == 1
        assert pol["vh"] == 3

    def test_unlabelled_bands_are_unidentified_not_guessed(self):
        pol = resolve_sar_polarizations(["", "nonsense", "VV"], 3)
        assert pol["unidentified"] == [1, 2]
        assert pol["vv"] == 3

    def test_no_descriptions_at_all(self):
        pol = resolve_sar_polarizations([], 3)
        assert pol["method"] == "none"
        assert pol["unidentified"] == []

    def test_description_with_unit_parens(self):
        pol = resolve_sar_polarizations(["VV (dB)", "VH (dB)"], 2)
        assert pol["vv"] == 1 and pol["vh"] == 2


# --------------------------------------------------------------------------- #
# classify_sar_representation                                                  #
# --------------------------------------------------------------------------- #


class TestClassifyRepresentation:
    def test_no_evidence_is_unknown_not_determined(self):
        rep = classify_sar_representation({}, path=None, declared=None)
        assert rep["value"] == REP_UNKNOWN
        assert rep["determined"] is False
        assert rep["basis"] == "none"
        assert any("unknown/unverified" in w for w in rep["warnings"])

    def test_caller_declared_db(self):
        rep = classify_sar_representation({"descriptions": []}, path=None, declared="db")
        assert rep["value"] == REP_DB
        assert rep["basis"] == "caller-declared"

    def test_caller_declared_power_and_amplitude(self):
        assert classify_sar_representation({}, declared="power")["value"] == REP_LINEAR_POWER
        assert classify_sar_representation({}, declared="amplitude")["value"] == REP_LINEAR_AMPLITUDE

    def test_caller_declared_unknown_is_no_evidence(self):
        rep = classify_sar_representation({}, path=None, declared="unknown")
        assert rep["value"] == REP_UNKNOWN
        assert rep["determined"] is False

    def test_file_tags_are_evidence(self, tmp_path):
        import rasterio
        from rasterio.crs import CRS
        from rasterio.transform import from_origin

        path = tmp_path / "tagged.tif"
        with rasterio.open(
            path, "w", driver="GTiff", width=2, height=2, count=1,
            dtype="float32", crs=CRS.from_epsg(32643),
            transform=from_origin(500000, 4600000, 10, 10),
        ) as dst:
            dst.write(np.zeros((2, 2), dtype=np.float32), 1)
            dst.update_tags(UNITS="dB", REPRESENTATION="backscatter dB")

        rep = classify_sar_representation({"descriptions": []}, path=str(path))
        assert rep["value"] == REP_DB
        assert rep["basis"] == "file-metadata-tags"
        assert rep["units"] == "dB (backscatter)"

    def test_band_description_suffix_is_evidence(self):
        rep = classify_sar_representation(
            {"descriptions": ["sigma0_VV_dB", "VH"]}, path=None
        )
        assert rep["value"] == REP_DB
        assert rep["basis"] == "band-description"

    def test_sigma0_alone_is_ambiguous(self):
        rep = classify_sar_representation(
            {"descriptions": ["sigma0_VV", "sigma0_VH"]}, path=None
        )
        assert rep["value"] == REP_UNKNOWN
        assert rep["determined"] is False

    def test_conflicting_claims_resolve_to_unknown(self, tmp_path):
        import rasterio
        from rasterio.crs import CRS
        from rasterio.transform import from_origin

        path = tmp_path / "conflict.tif"
        with rasterio.open(
            path, "w", driver="GTiff", width=2, height=2, count=1,
            dtype="float32", crs=CRS.from_epsg(32643),
            transform=from_origin(500000, 4600000, 10, 10),
        ) as dst:
            dst.write(np.zeros((2, 2), dtype=np.float32), 1)
            dst.update_tags(UNITS="dB")

        rep = classify_sar_representation(
            {"descriptions": []}, path=str(path), declared="power"
        )
        assert rep["value"] == REP_UNKNOWN
        assert rep["determined"] is False
        assert rep["basis"] == "conflicting-claims"
        assert any("contradict" in w for w in rep["warnings"])

    def test_caller_declared_corroborates_file_tags(self, tmp_path):
        import rasterio
        from rasterio.crs import CRS
        from rasterio.transform import from_origin

        path = tmp_path / "corroborate.tif"
        with rasterio.open(
            path, "w", driver="GTiff", width=2, height=2, count=1,
            dtype="float32", crs=CRS.from_epsg(32643),
            transform=from_origin(500000, 4600000, 10, 10),
        ) as dst:
            dst.write(np.zeros((2, 2), dtype=np.float32), 1)
            dst.update_tags(UNITS="dB")

        rep = classify_sar_representation(
            {"descriptions": []}, path=str(path), declared="dB"
        )
        assert rep["value"] == REP_DB
        assert rep["basis"] == "caller-declared (corroborated by file metadata)"


# --------------------------------------------------------------------------- #
# band_stats / relationship_metrics / require_polarizations                    #
# --------------------------------------------------------------------------- #


class TestBandStats:
    def test_constant_array(self):
        s = band_stats(np.full((10,), 1.5), np.ones(10, dtype=bool))
        assert s["mean"] == pytest.approx(1.5)
        assert s["min"] == pytest.approx(1.5)
        assert s["max"] == pytest.approx(1.5)
        assert s["std"] == pytest.approx(0.0)
        assert s["count"] == 10

    def test_nan_excluded(self):
        vals = np.array([1.0, np.nan, 3.0, np.inf])
        valid = np.ones(4, dtype=bool)
        s = band_stats(vals, valid)
        assert s["count"] == 2
        assert s["mean"] == pytest.approx(2.0)

    def test_empty_valid_safe(self):
        s = band_stats(np.ones(5), np.zeros(5, dtype=bool))
        assert s["count"] == 0


class TestRelationshipMetrics:
    def _rep(self, value):
        return {"value": value, "units": "x", "basis": "test", "determined": True}

    def test_linear_amplitude_ratio_is_meaningful(self):
        vv = np.array([1.0, 1.0, 1.0, 1.0])
        vh = np.array([2.0, 2.0, 2.0, 2.0])
        r = relationship_metrics(vv, vh, np.ones(4, dtype=bool),
                                 self._rep(REP_LINEAR_AMPLITUDE))
        assert r["vv_vh_ratio"]["meaningful"] is True
        assert r["vv_vh_ratio"]["value"] == pytest.approx(0.5)

    def test_dB_ratio_is_withheld_with_reason(self):
        vv = np.array([1.0, 2.0, 3.0, 4.0])
        vh = np.array([4.0, 3.0, 2.0, 1.0])
        r = relationship_metrics(vv, vh, np.ones(4, dtype=bool), self._rep(REP_DB))
        assert r["vv_vh_ratio"]["meaningful"] is False
        assert r["vv_vh_ratio"]["value"] is None
        assert "not a physically meaningful" in r["vv_vh_ratio"]["reason"]

    def test_unknown_representation_withholds_ratio(self):
        vv = np.array([1.0, 2.0, 3.0, 4.0])
        vh = np.array([4.0, 3.0, 2.0, 1.0])
        r = relationship_metrics(vv, vh, np.ones(4, dtype=bool), self._rep(REP_UNKNOWN))
        assert r["vv_vh_ratio"]["value"] is None
        assert r["vv_vh_ratio"]["meaningful"] is False

    def test_pearson_reports_association_in_native_space(self):
        vv = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        vh = vv * 2.0 + 1.0
        r = relationship_metrics(vv, vh, np.ones(5, dtype=bool), self._rep(REP_DB))
        assert r["vv_vh_pearson"]["value"] == pytest.approx(1.0)
        assert r["vv_vh_pearson"]["pixels"] == 5
        assert "association" in r["vv_vh_pearson"]["interpretation"].lower()

    def test_missing_polarization_explains_withdrawal(self):
        r = relationship_metrics(None, None, np.ones(4, dtype=bool), self._rep(REP_UNKNOWN))
        assert r["vv_vh_ratio"]["value"] is None
        assert "absent" in r["vv_vh_ratio"]["reason"]


class TestRequirePolarizations:
    def test_ok_when_present(self):
        pol = {"vv": 1, "vh": 2, "hh": None, "hv": None}
        require_polarizations(pol, ["VV", "vh"])  # should not raise

    def test_raises_naming_missing_and_available(self):
        pol = {"vv": 1, "vh": 2, "hh": None, "hv": None}
        with pytest.raises(SarValidationError) as exc:
            require_polarizations(pol, ["HH", "VV"])
        message = str(exc.value)
        assert "HH" in message
        assert "VV" in message

    def test_ignores_unknown_names(self):
        pol = {"vv": 1, "vh": None, "hh": None, "hv": None}
        require_polarizations(pol, ["VV", "XY"])  # unknown name is not required


# --------------------------------------------------------------------------- #
# End-to-end fusion with SAR-specific fixtures                                 #
# --------------------------------------------------------------------------- #


class TestFusionSarHardening:
    def test_dB_tagged_sar_reports_representation_and_polarizations(
        self, fusion_sar_db_tagged_pair
    ):
        optical, sar = fusion_sar_db_tagged_pair
        res = run_optical_sar_fusion(optical, sar)
        assert res["sar"]["representation"] == REP_DB
        assert res["sar"]["representation_basis"] == "file-metadata-tags"
        assert res["sar"]["units"] == "dB (backscatter)"
        assert res["sar"]["polarization"] in ("VV", "VH")
        assert res["representation"]["determined"] is True
        # The 10x10 scenes fully overlap: VV and VH both valid everywhere.
        assert res["polarization"]["vv"]["available"] is True
        assert res["polarization"]["vh"]["available"] is True
        assert res["polarization"]["vv"]["pixels"] == 100
        assert res["polarization"]["vh"]["pixels"] == 100
        # dB values: ratio withheld, association still reported.
        assert res["metrics"]["relationship"]["vv_vh_ratio"]["value"] is None
        assert res["metrics"]["relationship"]["vv_vh_ratio"]["meaningful"] is False
        assert res["metrics"]["relationship"]["vv_vh_pearson"]["pixels"] == 100
        assert res["metrics"]["relationship"]["vv_vh_pearson"]["value"] is not None
        assert res["coverage"]["aoi_scoped"] is False
        assert res["coverage"]["sar_validation_ratio"] == pytest.approx(1.0)

    def test_amplitude_tagged_sar_exposes_linear_ratio(self, fusion_sar_amplitude_tagged_pair):
        optical, sar = fusion_sar_amplitude_tagged_pair
        res = run_optical_sar_fusion(optical, sar)
        assert res["sar"]["representation"] == REP_LINEAR_AMPLITUDE
        ratio = res["metrics"]["relationship"]["vv_vh_ratio"]
        assert ratio["meaningful"] is True
        assert ratio["value"] == pytest.approx(0.5)

    def test_ambiguous_sigma0_description_is_unknown_without_badger(
        self, fusion_sar_ambiguous_pair
    ):
        optical, sar = fusion_sar_ambiguous_pair
        res = run_optical_sar_fusion(optical, sar)
        assert res["sar"]["representation"] == REP_UNKNOWN
        assert res["representation"]["determined"] is False
        assert res["representation"]["basis"] == "none"
        assert any("unknown/unverified" in w for w in res["representation"]["warnings"])
        # sigma0_VV / sigma0_VH still resolve as polarizations from names.
        assert res["polarization"]["vv"]["available"] is True
        assert res["polarization"]["vh"]["available"] is True

    def test_bare_vv_vh_stays_unknown_not_fabricated(self, fusion_sar_bare_pair):
        optical, sar = fusion_sar_bare_pair
        res = run_optical_sar_fusion(optical, sar)
        assert res["sar"]["representation"] == REP_UNKNOWN
        assert res["sar"]["units"] == "native raster values (unit unverified)"
        assert res["sar"]["units"] == "native raster values (unit unverified)"
        assert "dB" not in res["sar"]["units"]

    def test_required_polarizations_enforced(self, fusion_sar_bare_pair):
        optical, sar = fusion_sar_bare_pair
        with pytest.raises(FusionValidationError) as exc:
            run_optical_sar_fusion(optical, sar, sar_polarizations="VV,HH")
        message = str(exc.value)
        assert "HH" in message
        assert "VV" in message

    def test_missing_required_polarization_is_not_guessed(self, sar_vv_only_raster, fusion_paired_rasters):
        # VV-only SAR cannot satisfy a VH requirement even though a VH band
        # exists in the paired fixture; here we use a true single-band SAR.
        res = run_optical_sar_fusion(
            _paired_optical(fusion_paired_rasters), sar_vv_only_raster
        )
        assert res["polarization"]["vv"]["available"] is True
        assert res["polarization"]["vh"]["available"] is False

    def test_all_nan_sar_fails_honestly(self, fusion_sar_nan_pair):
        optical, sar = fusion_sar_nan_pair
        with pytest.raises(FusionValidationError) as exc:
            run_optical_sar_fusion(optical, sar)
        assert "no sar statistics" in str(exc.value).lower()

    def test_complex_slc_sar_is_rejected(self, fusion_sar_complex_pair):
        optical, sar = fusion_sar_complex_pair
        with pytest.raises(FusionValidationError) as exc:
            run_optical_sar_fusion(optical, sar)
        assert "complex" in str(exc.value).lower()

    def test_composite_band_reported_not_claimed_as_single_pol(self, fusion_sar_composite_pair):
        optical, sar = fusion_sar_composite_pair
        res = run_optical_sar_fusion(optical, sar)
        assert res["sar"]["polarization"] == "composite"
        assert res["coverage"]["polarization_composite_bands"] == [1]
        assert res["polarization"]["vv"]["available"] is False
        assert res["polarization"]["vh"]["available"] is False


def _paired_optical(pair):
    return pair[0]