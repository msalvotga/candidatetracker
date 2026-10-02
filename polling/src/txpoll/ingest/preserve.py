from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from pathlib import Path

from ..config import DATA_DIR


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def raw_dir(when: datetime | None = None) -> Path:
    when = when or datetime.now(timezone.utc)
    path = DATA_DIR / "raw" / f"{when.year:04d}" / f"{when.month:02d}" / f"{when.day:02d}"
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_raw(name: str, payload: bytes, when: datetime | None = None) -> tuple[Path, str]:
    digest = sha256_bytes(payload)
    folder = raw_dir(when)
    safe = "".join(ch if ch.isalnum() or ch in ".-_" else "_" for ch in name)[:80]
    path = folder / f"{digest[:12]}_{safe}"
    if not path.exists():
        path.write_bytes(payload)
    return path, digest
