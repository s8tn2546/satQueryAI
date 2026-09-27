"""Visual Question Answering (VQA) tool.

Loads a satellite image, runs VQA inference with a VLM, and returns the answer.

Two answer shapes are supported, chosen by the question:

- A closed, factual question ("Is there water?", "How many fields?") is
  answered with a short direct phrase, matching the RSVQA benchmark format
  (Section 9): "yes" | "no" | "3" | "farmland".
- An open, analytical question ("What can you tell me about this scene?")
  receives a structured Earth-observation report, so the answer is genuinely
  useful rather than a single token.

The prompt is what selects the shape; the generation budget is a ceiling, not a
target, so short answers stay short.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from app.models.vlm_loader import DEFAULT_VQA_MODEL, VLMUnavailableError, run_vqa
from app.preprocessing.loader import ImageLoadError, load_image_as_pil
from app.tools.roi_crop import aoi_scope, attach_aoi

logger = logging.getLogger(__name__)

# Open-ended questions that must never be treated as closed, even though they
# may contain an auxiliary verb ("What CAN you tell me about this scene?").
_OPEN_ENDED = re.compile(
    r"\b(?:what can (?:you|we) (?:tell|see|describe)|tell me about|"
    r"describe|analyz|analys|explain|summar|overview|assessment|"
    r"what do you see|what is (?:going on|happening|visible)|"
    r"interpret|compare|evaluate|characteri[sz]e)\b",
    re.IGNORECASE,
)

# Closed-form questions that must stay short: yes/no, counting, or a single
# named class.
_CLOSED_QUESTION = re.compile(
    r"^\s*(?:is|are|does|do|did|was|were|can|has|have|should|will|would)\b",
    re.IGNORECASE,
)
_SHORT_VALUE_REQUEST = re.compile(
    r"^\s*(?:how many|how much|what (?:is|was) the (?:ndvi|ndwi|value|area))\b",
    re.IGNORECASE,
)

_EO_SECTIONS = (
    ("Land cover", "surface types visibly present"),
    ("Hydrology", "water bodies, channels, flooding, or bare ground"),
    ("Urban density", "built-up extent and road network"),
    ("Vegetation health", "density, condition and stress of vegetation"),
)

_EO_REPORT_RULES = (
    "Report only what is visible in this image.",
    "Never invent percentages, area figures, class names, or counts.",
    'If a section has no supporting evidence, write "not determinable from this image".',
    "Separate direct observation from inference; label anything inferred as an inference.",
    "Do not claim ground truth or field verification.",
)


def wants_structured_report(question: str) -> bool:
    """True when the question is open-ended enough to warrant a full report.

    Open-ended phrasing wins outright, so a question like "What can you tell me
    about this scene?" is never mistaken for a yes/no question. Otherwise a
    leading auxiliary or a specific-value request is treated as closed, and
    anything unrecognised defaults to a report: an over-long answer is a far
    smaller failure than an uninformative one.
    """
    q = (question or "").strip()
    if not q:
        return False
    if _OPEN_ENDED.search(q):
        return True
    if _SHORT_VALUE_REQUEST.match(q):
        return False
    if _CLOSED_QUESTION.match(q):
        return False
    return True


def build_eo_vqa_prompt(question: str, aoi_scope_label: str | None = None) -> str:
    """Compose the VLM prompt for a question.

    Preserves the AOI scope in the prompt so the model describes only what it
    was shown, and does not imply a polygon-precise cut when the crop was a
    rectangular window.
    """
    q = (question or "").strip()

    if not wants_structured_report(q):
        return (
            f"{q}\n\n"
            "Answer with a single short lowercase word or phrase and nothing else. "
            "Do not explain."
        )

    sections = "\n".join(f"- {name}: {detail}." for name, detail in _EO_SECTIONS)
    rules = "\n".join(f"- {r}" for r in _EO_REPORT_RULES)

    scope_line = ""
    if aoi_scope_label:
        scope_line = (
            f"\nScope note: you are looking at {aoi_scope_label}. Describe only that "
            "region, and do not claim an accuracy finer than the window supports."
        )

    return (
        "You are an Earth-observation analyst interpreting a satellite image.\n\n"
        f"Question: {q}\n"
        f"{scope_line}\n\n"
        "Answer under these headings:\n"
        f"{sections}\n\n"
        "Rules:\n"
        f"{rules}\n\n"
        "Keep the whole answer under 250 words."
    )


def _scope_label(scope: Any) -> str | None:
    """Human-readable description of the AOI scope actually applied."""
    if scope is None or getattr(scope, "aoi_applied", False) is not True:
        return None
    original = getattr(scope, "original_dimensions", None)
    analyzed = getattr(scope, "analyzed_dimensions", None)
    if original and analyzed:
        return (
            f"a {analyzed['width']}x{analyzed['height']} pixel window cropped from a "
            f"{original['width']}x{original['height']} pixel scene (rectangular window, "
            "not a polygon mask)"
        )
    return "a rectangular window cropped from a larger scene"


class VQAError(Exception):
    pass


def compute_vqa(
    image_path: str | Path,
    question: str,
    *,
    model_name: str = DEFAULT_VQA_MODEL,
    adapter_path: str | None = None,
    aoi: Any = None,
    aoi_crs: Any = None,
) -> dict:
    """Run VQA on a single image, restricted to an AOI when one is given.

    A VLM answers about a rectangular image, so the AOI is applied as its pixel
    bounding window. The scope is reported as ``raster_window`` (never
    ``raster_window+mask``) so a reader is never told that polygon-level
    clipping happened when it did not: pixels inside the window but outside a
    non-rectangular AOI are still visible to the model.

    Args:
        image_path: Path to the input image (GeoTIFF, TIFF, PNG, or JPEG)
        question:   Question text (plain English)
        model_name: HuggingFace model ID; defaults to the configured VQA model
            (Qwen/Qwen2-VL-2B-Instruct via DEFAULT_VQA_MODEL)
        adapter_path: Optional path to LoRA adapter checkpoint
        aoi: optional GeoJSON Polygon/MultiPolygon (or JSON string) region of
            interest. When absent the whole image is shown to the model.
        aoi_crs: optional explicit CRS of the AOI coordinates. A bare GeoJSON
            geometry follows RFC 7946 (WGS84); the resolved CRS is reported in
            ``result["aoi"]``.

    Returns:
        {
            "answer":   str  — short phrase for a closed question, or a
                      structured EO report for an open one
            "question": str  — echoed back for evidence
            "answer_mode": str — "closed" or "structured"
            "confidence": float
            "aoi":      dict — AOI reporting (aoiScope = "raster_window")
        }

    Raises:
        VQAError: On image load failure or inference failure
        RoiCropError: When the AOI cannot be applied to the image.
        VLMUnavailableError: When real VLM inference is unavailable
            (missing dependencies/weights); callers should use the labeled
            offline placeholder instead of treating this as a model answer.
    """
    with aoi_scope(image_path, aoi, aoi_crs=aoi_crs, apply_mask=False) as scope:
        result = _run_vqa(
            scope.raster_path,
            question,
            model_name=model_name,
            adapter_path=adapter_path,
            scope_label=_scope_label(scope),
        )
    return attach_aoi(result, scope)


def _run_vqa(
    image_path: Path,
    question: str,
    *,
    model_name: str,
    adapter_path: str | None,
    scope_label: str | None = None,
) -> dict:
    """Load the (already AOI-scoped) image and run VLM inference on it."""
    try:
        pil_image = load_image_as_pil(Path(image_path))
    except ImageLoadError as exc:
        raise VQAError(f"Failed to load image: {exc}") from exc
    except Exception as exc:
        raise VQAError(f"Unexpected error loading image: {exc}") from exc

    if pil_image.mode != "RGB":
        pil_image = pil_image.convert("RGB")

    structured = wants_structured_report(question)
    prompt = build_eo_vqa_prompt(question, scope_label)

    try:
        answer, confidence = run_vqa(
            pil_image,
            prompt,
            model_name=model_name,
            adapter_path=adapter_path,
            max_new_tokens=256 if structured else 64,
        )
    except VLMUnavailableError:
        raise
    except Exception as exc:
        raise VQAError(f"VQA inference failed: {exc}") from exc

    return {
        "answer": answer,
        "question": question,
        "answer_mode": "structured" if structured else "closed",
        "confidence": confidence,
    }
