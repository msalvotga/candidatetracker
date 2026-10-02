"""Duplicate and syndication detection.

A high score means two records should become one observation. Sources are kept.
The model uses the canonical record only.
"""

from __future__ import annotations

import re
from datetime import date


def _tokens(name: str | None) -> set[str]:
    if not name:
        return set()
    parts = re.split(r"[^a-z0-9]+", name.lower())
    stop = {"poll", "polling", "college", "university", "the", "of", "and", "survey", "news"}
    return {p for p in parts if p and p not in stop}


def name_overlap(left: str | None, right: str | None) -> float:
    a, b = _tokens(left), _tokens(right)
    if not a or not b:
        return 0.0
    if a <= b or b <= a:
        return 1.0
    return len(a & b) / len(a | b)


def similarity(left: dict, right: dict) -> tuple[float, list[str]]:
    """Score in 0..1 from pollster, sponsor, field dates, sample, and shares."""
    score = 0.0
    reasons: list[str] = []
    pollster = name_overlap(left.get("pollster_canonical") or left.get("pollster"), right.get("pollster_canonical") or right.get("pollster"))
    if pollster >= 0.99:
        score += 0.30
        reasons.append("same pollster")
    elif pollster >= 0.34:
        score += 0.18
        reasons.append("related pollster name")

    sponsor = name_overlap(left.get("sponsor"), right.get("sponsor"))
    if sponsor >= 0.5:
        score += 0.10
        reasons.append("related sponsor")

    if _dates_close(left, right, days=2):
        score += 0.25
        reasons.append("field dates match")
    elif _dates_overlap(left, right):
        score += 0.12
        reasons.append("field dates overlap")

    n1, n2 = left.get("sample_size"), right.get("sample_size")
    if n1 and n2:
        gap = abs(n1 - n2) / max(n1, n2)
        if gap <= 0.02:
            score += 0.15
            reasons.append("sample size matches")
        elif gap <= 0.08:
            score += 0.08
            reasons.append("sample size is close")

    if left.get("sample_type") and left.get("sample_type") == right.get("sample_type"):
        score += 0.08
        reasons.append("same sample type")

    share = _share_gap(left, right)
    if share is not None and share <= 1.0:
        score += 0.12
        reasons.append("candidate shares match")
    elif share is not None and share <= 2.0:
        score += 0.06
        reasons.append("candidate shares are close")

    return round(min(score, 1.0), 3), reasons


def _as_date(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def _dates_close(left: dict, right: dict, days: int) -> bool:
    pairs = [("field_start", "field_start"), ("field_end", "field_end")]
    seen = False
    for a, b in pairs:
        da, db = _as_date(left.get(a)), _as_date(right.get(b))
        if da is None or db is None:
            return False
        seen = True
        if abs((da - db).days) > days:
            return False
    return seen


def _dates_overlap(left: dict, right: dict) -> bool:
    a1, a2 = _as_date(left.get("field_start")), _as_date(left.get("field_end"))
    b1, b2 = _as_date(right.get("field_start")), _as_date(right.get("field_end"))
    if not all([a1, a2, b1, b2]):
        return False
    return a1 <= b2 and b1 <= a2


def _share(record: dict, candidate: str) -> float | None:
    for row in record.get("results") or []:
        if row.get("candidate") == candidate and row.get("percentage") is not None and row.get("result_frame", "headline") == "headline":
            return float(row["percentage"])
    return None


def _share_gap(left: dict, right: dict) -> float | None:
    gaps = []
    for candidate in ("Greg Abbott", "Gina Hinojosa"):
        a, b = _share(left, candidate), _share(right, candidate)
        if a is None or b is None:
            return None
        gaps.append(abs(a - b))
    return max(gaps) if gaps else None


def should_link(left: dict, right: dict, threshold: float = 0.72) -> tuple[bool, float, list[str]]:
    """Automatic merges require both a high score and fieldwork that is actually the same window.

    The same pollster can publish a similar margin a month later. That is a new poll.
    """
    score, reasons = similarity(left, right)
    dates_ok = _dates_close(left, right, days=3) or _dates_overlap(left, right)
    if not dates_ok:
        reasons = [*reasons, "field dates are not close enough to treat these as one survey"]
    return score >= threshold and dates_ok, score, reasons


def choose_canonical(records: list[dict]) -> str:
    """Prefer an approved record with the best (lowest) source tier, then a primary URL."""

    def key(record: dict) -> tuple:
        tiers = [src.get("tier", 5) for src in record.get("sources") or []]
        best = min(tiers) if tiers else 5
        approved = 0 if record.get("approved_for_model") else 1
        return (approved, best, record.get("external_key") or "")

    return sorted(records, key=key)[0]["external_key"]
