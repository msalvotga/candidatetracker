"""Search-provider interface. Missing API keys skip search; they do not invent results."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from ..config import load_yaml, search_api_key


@dataclass
class SearchHit:
    title: str
    url: str
    snippet: str
    provider: str
    query: str


class SearchNotConfigured(RuntimeError):
    pass


def search(query: str) -> list[SearchHit]:
    provider, key = search_api_key()
    if not key:
        raise SearchNotConfigured(
            f"No API key for the {provider} search provider. Set it in .env. Discovery search was skipped."
        )
    if provider == "brave":
        return _brave(query, key)
    if provider == "bing":
        return _bing(query, key)
    if provider == "serpapi":
        return _serpapi(query, key)
    raise SearchNotConfigured(f"Unknown search provider {provider}")


def planned_queries() -> list[str]:
    config = load_yaml("search_queries.yaml")
    queries = list(config.get("queries") or [])
    if config.get("search_known_domains"):
        sources = load_yaml("sources.yaml")
        for pollster in sources.get("pollsters") or []:
            domain = (pollster.get("domains") or [None])[0]
            if domain:
                queries.append(f"site:{domain} Texas governor poll 2026")
    return queries


def _brave(query: str, key: str) -> list[SearchHit]:
    limit = int(load_yaml("search_queries.yaml").get("results_per_query") or 8)
    response = httpx.get(
        "https://api.search.brave.com/res/v1/web/search",
        params={"q": query, "count": limit},
        headers={"X-Subscription-Token": key, "Accept": "application/json"},
        timeout=30,
    )
    response.raise_for_status()
    hits = []
    for item in (response.json().get("web") or {}).get("results") or []:
        hits.append(SearchHit(item.get("title") or "", item.get("url") or "", item.get("description") or "", "brave", query))
    return hits


def _bing(query: str, key: str) -> list[SearchHit]:
    limit = int(load_yaml("search_queries.yaml").get("results_per_query") or 8)
    response = httpx.get(
        "https://api.bing.microsoft.com/v7.0/search",
        params={"q": query, "count": limit},
        headers={"Ocp-Apim-Subscription-Key": key},
        timeout=30,
    )
    response.raise_for_status()
    hits = []
    for item in (response.json().get("webPages") or {}).get("value") or []:
        hits.append(SearchHit(item.get("name") or "", item.get("url") or "", item.get("snippet") or "", "bing", query))
    return hits


def _serpapi(query: str, key: str) -> list[SearchHit]:
    response = httpx.get(
        "https://serpapi.com/search.json",
        params={"q": query, "api_key": key, "engine": "google", "num": 8},
        timeout=30,
    )
    response.raise_for_status()
    hits = []
    for item in response.json().get("organic_results") or []:
        hits.append(SearchHit(item.get("title") or "", item.get("link") or "", item.get("snippet") or "", "serpapi", query))
    return hits
