"""Decode and re-encode image output so metadata and trailing payloads are discarded."""

from __future__ import annotations

import io
import warnings

from .contract import ContractError

MAX_IMAGE_BYTES = 1024 * 1024
MAX_IMAGE_EDGE = 4096
MAX_IMAGE_PIXELS = 16_777_216


def canonicalize_image(data: bytes, kind: str) -> bytes:
    if kind not in {"png", "jpeg"}:
        raise ContractError("INVALID_IMAGE", "Image kind is unsupported.")
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ContractError("INVALID_IMAGE", "Image exceeds its input byte limit.")
    try:
        from PIL import Image, UnidentifiedImageError
    except ImportError as error:
        raise ContractError("INVALID_IMAGE", "Image decoder is unavailable.") from error
    try:
        Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            with Image.open(io.BytesIO(data)) as image:
                image.verify()
            with Image.open(io.BytesIO(data)) as image:
                image.load()
                expected = "PNG" if kind == "png" else "JPEG"
                if image.format != expected:
                    raise ContractError("INVALID_IMAGE", "Image content does not match its declared kind.")
                width, height = image.size
                if (
                    width < 1 or height < 1
                    or width > MAX_IMAGE_EDGE or height > MAX_IMAGE_EDGE
                    or width * height > MAX_IMAGE_PIXELS
                ):
                    raise ContractError("INVALID_IMAGE", "Image dimensions exceed their safety limit.")
                clean = image.convert("RGBA" if kind == "png" and "A" in image.getbands() else "RGB")
                output = io.BytesIO()
                if kind == "png":
                    clean.save(output, format="PNG", optimize=False, compress_level=6)
                else:
                    clean.save(output, format="JPEG", quality=90, optimize=False, progressive=False)
    except ContractError:
        raise
    except (OSError, ValueError, UnidentifiedImageError) as error:
        raise ContractError("INVALID_IMAGE", "Image could not be decoded safely.") from error
    encoded = output.getvalue()
    if len(encoded) > MAX_IMAGE_BYTES:
        raise ContractError("INVALID_IMAGE", "Canonical image exceeds its output byte limit.")
    return encoded
