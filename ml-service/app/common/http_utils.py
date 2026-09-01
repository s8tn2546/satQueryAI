"""Shared FastAPI helpers for handling uploaded raster files.

Both spectral-index and area endpoints accept a multipart file upload,
write it to a temporary file, and clean it up afterwards. This module
centralises that flow so the API routes stay small and consistent.
"""

from __future__ import annotations

import logging
import tempfile
from pathlib import Path

from fastapi import UploadFile

from app.schemas.common import ToolOutput

logger = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".tif", ".tiff", ".png", ".jpg", ".jpeg"}
MAX_FILE_SIZE_MB = 500


def validate_upload_ext(filename: str | None) -> str | None:
    """Validate a filename's extension.

    Returns the lowercase extension (e.g. '.tif') if supported,
    otherwise None.
    """
    name = filename or "unknown"
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        return None
    return ext


class UploadError(Exception):
    """Base exception for upload processing errors."""


class InvalidFileError(UploadError):
    """Raised when an uploaded file is not a valid raster."""


class FileTooLargeError(UploadError):
    """Raised when an uploaded file exceeds the size limit."""


async def read_upload_file(file: UploadFile) -> bytes:
    """Read and validate an uploaded file's size."""
    try:
        content = await file.read()
    except Exception as exc:
        raise InvalidFileError(f"Failed to read uploaded file: {exc}") from exc

    if len(content) > MAX_FILE_SIZE_MB * 1024 * 1024:
        raise FileTooLargeError(
            f"File too large: {len(content) / (1024 * 1024):.1f} MB "
            f"(max: {MAX_FILE_SIZE_MB} MB)"
        )
    if len(content) == 0:
        raise InvalidFileError("Uploaded file is empty (0 bytes)")
    return content


def save_to_temp(content: bytes, ext: str) -> Path:
    """Write bytes to a temp file and return its path."""
    suffix = ext if ext else ".tif"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        return Path(tmp.name)


def error_output(
    tool: str,
    message: str,
    *,
    detail: dict | None = None,
    status: str = "failed",
    confidence: float = 0.0,
) -> ToolOutput:
    """Build a structured ToolOutput representing a failure."""
    result: dict = {"error": message}
    if detail:
        result.update(detail)
    return ToolOutput(
        tool=tool,
        status=status,
        result=result,
        evidence={},
        confidence=confidence,
    )
