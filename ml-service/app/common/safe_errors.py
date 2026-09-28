"""Client-safe exception message helpers.

Raw ``str(exc)`` can leak host filesystem paths, temporary-file locations and
upstream URLs (some of which embed credentials). These helpers preserve the
exception's own description while scrubbing anything that could disclose
internal infrastructure, so API responses stay useful without advertising the
service's layout.
"""

from __future__ import annotations

import re

_DEFAULT_FALLBACK = "An internal error occurred."
_MAX_LEN = 250

# Absolute-path shapes seen on macOS/Linux (project, venv, temp dirs) and
# Windows drive paths. Missing content is never revealed; only the path is.
_PATH_PATTERNS = (
    r"(?:/(?:Users|home|tmp|var|app|data|opt|root|cwd|workspace|venv|lib))"
    r"[\\/][^\s,;)'\"]*",
    r"[A-Za-z]:[\\/][^\s,;)'\"]*",
)
_URL_PATTERN = r"https?://[^\s,;)'\"]*"


def safe_error(
    exc: BaseException,
    *,
    fallback: str = _DEFAULT_FALLBACK,
    max_len: int = _MAX_LEN,
) -> str:
    """Return a redacted, truncated message for an exception.

    Preserves the exception's own wording (so controlled messages survive
    unchanged) while replacing absolute paths and URLs with ``[path]``/``[url]``
    markers. Falls back to a generic message when nothing readable remains.
    """
    raw = str(exc) or ""
    message = raw.strip().replace("\n", " ")
    if not message or message.lower().startswith("the server encountered"):
        return fallback
    for pattern in _PATH_PATTERNS:
        message = re.sub(pattern, "[path]", message)
    message = re.sub(_URL_PATTERN, "[url]", message)
    message = re.sub(r"\s+", " ", message).strip()
    if len(message) > max_len:
        message = message[: max_len - 1].rstrip() + "\u2026"
    return message or fallback