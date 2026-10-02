"""Watch known pages. A changed hash is a new version, never an overwrite of history."""

from __future__ import annotations

from datetime import datetime, timezone

import httpx
from bs4 import BeautifulSoup

from ..config import load_yaml
from .preserve import sha256_bytes, write_raw


def fetch_watch_pages() -> list[dict]:
    sources = load_yaml("sources.yaml")
    found = []
    headers = {"User-Agent": "TexasGovernorPollTrend/0.1 (local research archive)"}
    for source in sources.get("discovery") or []:
        url = source.get("url")
        if not url:
            continue
        item = {"source": source, "ok": False, "url": url}
        try:
            response = httpx.get(url, headers=headers, timeout=30, follow_redirects=True)
            response.raise_for_status()
            payload = response.content
            path, digest = write_raw("page.html", payload, datetime.now(timezone.utc))
            item.update(ok=True, hash=digest, path=str(path), status_code=response.status_code)
            if source.get("parser") == "tpp_governor_table":
                item["rows"] = parse_tpp_table(response.text)
                if not item["rows"]:
                    item["note"] = "Page downloaded but the poll table was not found. Queued for manual review. OCR is not used."
        except Exception as exc:  # network and parse failures stay in the queue
            item["error"] = str(exc)
        found.append(item)
    return found


def parse_tpp_table(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    rows = []
    for table in soup.find_all("table"):
        headers = [cell.get_text(" ", strip=True).lower() for cell in table.find_all("th")]
        if not headers or "abbott" not in " ".join(headers):
            continue
        for tr in table.find_all("tr"):
            cells = [cell.get_text(" ", strip=True) for cell in tr.find_all("td")]
            if len(cells) < 6:
                continue
            rows.append({"cells": cells, "headers": headers})
    return rows
