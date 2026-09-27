"""Tests for structured EO VQA prompting and the VLM token budgets.

These are pure unit tests: the prompt builder and the confidence heuristic must
be correct without loading model weights.
"""

from __future__ import annotations

import pytest

from app.models.vlm_loader import (
    CAPTION_PROMPT,
    _vqa_confidence,
    run_caption,
    run_vqa,
)
from app.tools.vqa import build_eo_vqa_prompt, compute_vqa, wants_structured_report


class TestClosedVsStructured:
    @pytest.mark.parametrize(
        "question",
        [
            "Is there water in this image?",
            "are the fields flooded",
            "Does the area contain a road network?",
            "How many fields are visible?",
            "what is the NDVI value",
        ],
    )
    def test_closed_questions_get_no_report(self, question):
        assert wants_structured_report(question) is False

    @pytest.mark.parametrize(
        "question",
        [
            "What can you tell me about this scene?",
            "Analyze the land cover here",
            "Describe the image",
        ],
    )
    def test_open_questions_get_a_report(self, question):
        assert wants_structured_report(question) is True

    def test_empty_question_is_not_structured(self):
        assert wants_structured_report("") is False
        assert wants_structured_report("   ") is False


class TestPromptContent:
    def test_closed_prompt_requires_a_short_answer(self):
        prompt = build_eo_vqa_prompt("Is there water?")
        assert "single short lowercase word or phrase" in prompt
        assert "Is there water?" in prompt
        # A closed question must not drag in report structure.
        assert "Land cover" not in prompt

    def test_structured_prompt_keeps_the_question_and_the_sections(self):
        prompt = build_eo_vqa_prompt("What can you tell me about this scene?")
        assert "What can you tell me about this scene?" in prompt
        for heading in ("Land cover", "Hydrology", "Urban density", "Vegetation health"):
            assert heading in prompt

    def test_structured_prompt_forbids_fabrication(self):
        prompt = build_eo_vqa_prompt("Analyze this scene")
        assert "Never invent percentages, area figures, class names, or counts." in prompt
        assert "not determinable from this image" in prompt
        assert "Do not claim ground truth or field verification." in prompt

    def test_structured_prompt_caps_length(self):
        assert "under 250 words" in build_eo_vqa_prompt("Describe this scene")

    def test_aoi_scope_note_is_included_and_is_honest(self):
        label = "a 256x256 pixel window cropped from a 1024x1024 pixel scene (rectangular window, not a polygon mask)"
        prompt = build_eo_vqa_prompt("What can you see here?", label)
        assert "Scope note" in prompt
        assert "256x256" in prompt
        assert "not a polygon mask" in prompt
        assert "Describe only that region" in prompt

    def test_no_aoi_means_no_scope_note(self):
        prompt = build_eo_vqa_prompt("What can you see here?")
        assert "Scope note" not in prompt

    def test_caption_prompt_is_structured_and_anti_hallucination(self):
        assert "Land cover" in CAPTION_PROMPT
        assert "Hydrology" in CAPTION_PROMPT
        assert "Urban density" in CAPTION_PROMPT
        assert "Vegetation health" in CAPTION_PROMPT
        assert "Never invent percentages" in CAPTION_PROMPT
        assert "not determinable from this image" in CAPTION_PROMPT


class TestTokenBudgets:
    def test_vqa_budget_is_above_the_old_20_token_cap(self):
        import inspect

        default = inspect.signature(run_vqa).parameters["max_new_tokens"].default
        assert default >= 256

    def test_caption_budget_is_above_the_old_60_token_cap(self):
        import inspect

        default = inspect.signature(run_caption).parameters["max_new_tokens"].default
        assert default >= 512

    def test_closed_questions_are_budgeted_lower_than_reports(self, plain_png, monkeypatch):
        """A yes/no question must not be given the 256-token report budget."""
        from app.tools.vqa import compute_vqa

        captured: list[tuple[str, int, str]] = []

        def fake_run_vqa(image, question, model_name=None, adapter_path=None, max_new_tokens=256):
            captured.append((question, max_new_tokens, "yes"))
            return "yes", 0.8

        monkeypatch.setattr("app.tools.vqa.run_vqa", fake_run_vqa)

        compute_vqa(plain_png, "Is there water?")
        compute_vqa(plain_png, "What can you tell me about this scene?")

        closed_prompt, closed_tokens, _ = captured[0]
        report_prompt, report_tokens, _ = captured[1]

        assert closed_tokens < report_tokens
        assert report_tokens >= 256
        assert "single short lowercase word or phrase" in closed_prompt
        assert "Land cover" in report_prompt

    def test_answer_mode_is_reported(self, plain_png, monkeypatch):
        from app.tools.vqa import compute_vqa

        monkeypatch.setattr("app.tools.vqa.run_vqa", lambda *a, **k: ("yes", 0.8))

        assert compute_vqa(plain_png, "Is there water?")["answer_mode"] == "closed"
        assert compute_vqa(plain_png, "Describe this scene")["answer_mode"] == "structured"

    def test_aoi_scope_reaches_the_prompt(self, georeferenced_raster, monkeypatch):
        """The model is told it sees a window, not a polygon-masked scene."""
        from app.tools.vqa import compute_vqa

        captured: list[str] = []
        monkeypatch.setattr(
            "app.tools.vqa.run_vqa",
            lambda image, question, **k: (captured.append(question), ("yes", 0.8))[1],
        )

        # Left half of the fixture raster (EPSG:32643, 10x10 px, 10 m pixels).
        aoi = {
            "type": "Polygon",
            "coordinates": [[[500000, 4599950], [500050, 4599950], [500050, 4600000], [500000, 4600000], [500000, 4599950]]],
        }
        compute_vqa(georeferenced_raster, "What can you see here?", aoi=aoi, aoi_crs=32643)

        assert captured, "VQA prompt was never built"
        assert "Scope note" in captured[0]
        assert "not a polygon mask" in captured[0]


class TestConfidenceHeuristic:
    def test_empty_answer_has_no_confidence(self):
        assert _vqa_confidence("") == 0.0

    def test_binary_answers_are_highest(self):
        assert _vqa_confidence("yes") == 0.8
        assert _vqa_confidence("No") == 0.8

    def test_short_phrase_is_mid_confidence(self):
        assert _vqa_confidence("farmland") == 0.7

    def test_long_report_confidence_does_not_inherit_crisp_answer_confidence(self):
        """A long report asserts more without extra verification."""
        short_report = _vqa_confidence("word " * 30)
        long_report = _vqa_confidence("word " * 120)
        assert short_report < 0.7
        assert long_report < short_report
        assert 0.0 < long_report < 0.6
