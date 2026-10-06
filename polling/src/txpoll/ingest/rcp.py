"""Read individual polls from a RealClearPolling page.

The RCP average row is discarded. It is never a poll and never a model input.
"""

from __future__ import annotations

from bs4 import BeautifulSoup

from .tpp import _field_dates, poll_family

_CANONICAL = {
    "yougov": "YouGov",
    "siena": "New York Times / Siena",
    "fox": "Fox News",
    "big-data": "Big Data Poll",
    "tpor": "Texas Public Opinion Research",
    "marist": "Marist Poll",
    "tsu": "Texas Southern University / YouGov",
    "emerson": "Emerson College Polling",
    "recon": "ReconMR",
    "mason": "Mason-Dixon",
    "aarp": "AARP Texas",
    "univision": "YouGov / Univision",
    "tpp": "University of Texas / Texas Politics Project",
    "quantus": "Quantus Insights",
    "cygnal": "Cygnal",
    "houston": "University of Houston",
}


def parse_rcp_polls(html: str, year: int = 2026) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    best: list[dict] = []
    for table in soup.find_all("table"):
        headers = [cell.get_text(" ", strip=True).lower() for cell in table.find_all("th")]
        if "pollster" not in " ".join(headers) or "abbott" not in " ".join(headers):
            continue
        rows = []
        seen = set()
        for tr in table.find_all("tr"):
            cells = [cell.get_text(" ", strip=True) for cell in tr.find_all("td")]
            if len(cells) < 6:
                continue
            pollster = cells[0].replace("*", "").strip()
            if not pollster or "average" in pollster.lower() or pollster.lower().startswith("rcp"):
                continue
            start, end = _field_dates(cells[1], year)
            sample_size, sample_type = _sample(cells[2])
            key = (pollster.lower(), start.isoformat() if start else None, end.isoformat() if end else None, sample_size)
            if key in seen:
                continue
            seen.add(key)
            family = poll_family(pollster)
            link = tr.find("a")
            href = (link.get("href") or "").strip() if link else ""
            if href.startswith("/"):
                href = "https://www.realclearpolling.com" + href
            rows.append(
                {
                    "pollster": pollster,
                    "canonical": _CANONICAL.get(family or "", pollster),
                    "family": family,
                    "field_start": start.isoformat() if start else None,
                    "field_end": end.isoformat() if end else None,
                    "sample_size": sample_size,
                    "sample_type": sample_type,
                    "reported_moe": _moe(cells[3]),
                    "abbott": _share(cells[4]),
                    "hinojosa": _share(cells[5]),
                    "extras": [],
                    "other_text": "",
                    "ballot": "two_candidate_remainder_unpublished",
                    "spread": cells[6] if len(cells) > 6 else "",
                    "document_url": href if href.startswith("http") else None,
                    "publisher": "RealClearPolling",
                }
            )
        if len(rows) > len(best):
            best = rows
    return best


def _sample(text: str) -> tuple[int | None, str | None]:
    token = text.replace(",", "").strip()
    number = ""
    for char in token:
        if char.isdigit():
            number += char
        elif number:
            break
    size = int(number) if number else None
    upper = token.upper()
    kind = "LV" if "LV" in upper else "RV" if "RV" in upper else None
    return size, kind


def _moe(text: str) -> float | None:
    cleaned = text.replace("—", "").replace("-", "").strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def _share(text: str) -> float | None:
    cleaned = text.replace("%", "").strip()
    if not cleaned or cleaned in {"—", "-"}:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None
