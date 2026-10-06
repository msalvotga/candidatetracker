"""Parse the Texas Politics Project gubernatorial tracker table.

The tracker is an index. A row becomes an archive record, not a model input,
until someone includes it.
"""

from __future__ import annotations

import re
from datetime import date

from bs4 import BeautifulSoup

TRACKER_URL = "https://texaspolitics.utexas.edu/blog/texas-2026-gubernatorial-poll-tracker"

_FAMILIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("fox", ("fox",)),
    ("siena", ("siena", "new york times", "ny times", "nyt")),
    ("marist", ("marist",)),
    ("tsu", ("tsu", "texas southern")),
    ("yougov", ("yougov",)),
    ("emerson", ("emerson",)),
    ("tpor", ("tpor", "texas public opinion")),
    ("big-data", ("big data",)),
    ("cygnal", ("cygnal",)),
    ("houston", ("university of houston",)),
    ("recon", ("recon",)),
    ("mason", ("mason-dixon", "mason dixon", "mason")),
    ("aarp", ("aarp", "fabrizio")),
    ("univision", ("univision", "televisa")),
    ("tpp", ("texas politics project", "university of texas")),
    ("quantus", ("quantus",)),
)

_CANONICAL = {
    "fox": "Fox News",
    "siena": "New York Times / Siena",
    "marist": "Marist Poll",
    "tsu": "Texas Southern University / YouGov",
    "yougov": "YouGov",
    "emerson": "Emerson College Polling",
    "tpor": "Texas Public Opinion Research",
    "big-data": "Big Data Poll",
    "cygnal": "Cygnal",
    "houston": "University of Houston",
    "recon": "ReconMR",
    "mason": "Mason-Dixon",
    "aarp": "AARP Texas",
    "univision": "YouGov / Univision",
    "tpp": "University of Texas / Texas Politics Project",
    "quantus": "Quantus Insights",
}


def poll_family(name: str | None) -> str | None:
    text = (name or "").lower().replace("–", " ")
    for family, needles in _FAMILIES:
        if any(needle in text for needle in needles):
            return family
    return None


def parse_tpp_polls(html: str, year: int = 2026) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    parsed = []
    for table in soup.find_all("table"):
        headers = [cell.get_text(" ", strip=True).lower() for cell in table.find_all("th")]
        if not headers or "abbott" not in " ".join(headers):
            continue
        for tr in table.find_all("tr"):
            cells = [cell.get_text(" ", strip=True) for cell in tr.find_all("td")]
            if len(cells) < 7 or cells[0].lower() == "poll":
                continue
            start, end = _field_dates(cells[1], year)
            extras, other_text = _parse_remainder(cells[7] if len(cells) > 7 else "")
            pollster = cells[0]
            family = poll_family(pollster)
            parsed.append(
                {
                    "pollster": pollster,
                    "canonical": _CANONICAL.get(family or "", pollster),
                    "family": family,
                    "field_start": start.isoformat() if start else None,
                    "field_end": end.isoformat() if end else None,
                    "sample_size": _first_number(cells[2], integer=True),
                    "sample_type": _sample_type(cells[3]),
                    "reported_moe": _first_number(cells[4]),
                    "abbott": _first_number(cells[5]),
                    "hinojosa": _first_number(cells[6]),
                    "extras": extras,
                    "other_text": other_text,
                    "ballot": _ballot(extras),
                    "spread": cells[8] if len(cells) > 8 else "",
                }
            )
    return parsed


def same_survey(existing: dict, row: dict) -> bool:
    """True when a tracker row is a poll already in the archive."""
    same_dates = bool(existing.get("field_start") and existing.get("field_end") and existing.get("field_start") == row.get("field_start") and existing.get("field_end") == row.get("field_end"))
    same_family = bool(existing.get("family") and existing.get("family") == row.get("family"))
    same_n = existing.get("sample_size") is not None and row.get("sample_size") is not None and int(existing["sample_size"]) == int(row["sample_size"])
    same_shares = _near(existing.get("abbott"), row.get("abbott")) and _near(existing.get("hinojosa"), row.get("hinojosa"))
    if same_dates and (same_family or same_n):
        return True
    if same_family and same_shares and (same_n or not existing.get("field_start")):
        return True
    return False


def _near(left, right) -> bool:
    if left is None or right is None:
        return False
    return abs(float(left) - float(right)) < 0.05


def _sample_type(text: str) -> str | None:
    token = text.strip().upper()
    if token in {"LV", "RV"}:
        return token
    if "ADULT" in token:
        return "Adults"
    return None


def _first_number(text: str, integer: bool = False):
    match = re.search(r"(\d*\.?\d+)", text.replace(",", ""))
    if not match or match.group(1) in {"", "."}:
        return None
    value = float(match.group(1))
    if integer:
        return int(value)
    return value


def _field_dates(text: str, year: int) -> tuple[date | None, date | None]:
    numbers = [int(item) for item in re.findall(r"\d+", text)]
    if len(numbers) < 4:
        return None, None
    start_month, start_day, end_month, end_day = numbers[:4]
    end_year = year + 1 if end_month < start_month else year
    try:
        return date(year, start_month, start_day), date(end_year, end_month, end_day)
    except ValueError:
        return None, None


def _parse_remainder(text: str) -> tuple[list[dict], str]:
    raw = " ".join(text.split())
    if not raw or raw.lower() in {"n/a", "na", "—", "-", "none"}:
        return [], raw
    parts = [part.strip(" .") for part in re.split(r"[;]", raw) if part.strip()]
    if len(parts) == 1 and "," in raw:
        parts = [part.strip(" .") for part in raw.split(",") if part.strip()]
    extras = []
    for part in parts:
        match = re.search(r"(\d*\.?\d+)\s*%?", part)
        if not match or match.group(1) in {"", "."}:
            continue
        value = float(match.group(1))
        label = part[: match.start()].strip(" :,-") or part
        low = label.lower()
        combined = ("/" in low or "someone else/dk" in low or ("someone" in low and "dk" in low) or ("other" in low and "undecided" in low))
        if "dixon" in low:
            extras.append({"candidate": "Pat Dixon", "party": "Libertarian", "percentage": value, "result_type": "other", "combined": False})
        elif combined:
            extras.append({"candidate": "Someone else / don't know", "percentage": value, "result_type": "other", "combined": True})
        elif any(word in low for word in ("undecided", "unsure", "dk", "don't know", "dont know")):
            extras.append({"candidate": "Undecided", "percentage": value, "result_type": "undecided", "combined": False})
        elif "wouldn" in low or "would not" in low:
            extras.append({"candidate": "Wouldn't vote", "percentage": value, "result_type": "would_not_vote", "combined": False})
        else:
            extras.append({"candidate": "Other", "percentage": value, "result_type": "other", "combined": False})
    return extras, raw


def _ballot(extras: list[dict]) -> str:
    combined = any(item.get("combined") for item in extras)
    has_dixon = any("dixon" in item["candidate"].lower() for item in extras)
    has_undecided = any(item["result_type"] == "undecided" for item in extras)
    if not extras:
        return "two_candidate_remainder_unpublished"
    if combined and has_dixon:
        return "multi_candidate_undecided_permitted"
    if combined:
        return "two_candidate_remainder_combined"
    if has_dixon:
        return "three_candidate_undecided_permitted"
    if has_undecided:
        return "two_candidate_undecided_permitted"
    return "two_candidate_plus_someone_else"
