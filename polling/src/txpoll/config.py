"""Load YAML defaults and deep-merge database overrides. Credentials stay in the environment."""

from __future__ import annotations

import os
from copy import deepcopy
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = ROOT.parent
CONFIG_DIR = ROOT / "config"
DATA_DIR = ROOT / "data"

load_dotenv(REPO_ROOT / ".env")
load_dotenv(ROOT / ".env")


def load_yaml(name: str) -> dict[str, Any]:
    path = CONFIG_DIR / name
    with path.open(encoding="utf-8") as handle:
        data = yaml.safe_load(handle) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{name} must be a mapping")
    return data


def deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    merged = deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def database_url() -> str:
    configured = os.environ.get("POLLING_DATABASE_URL", "").strip()
    if configured:
        return configured
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{(DATA_DIR / 'txpoll.sqlite').as_posix()}"


def search_api_key(provider: str | None = None) -> tuple[str, str]:
    """Return (provider, key). Key may be empty when discovery search is not configured."""
    chosen = (provider or os.environ.get("POLLING_SEARCH_PROVIDER") or load_yaml("search_queries.yaml").get("provider") or "brave")
    chosen = str(chosen).strip().lower()
    env_names = {
        "brave": "BRAVE_SEARCH_API_KEY",
        "bing": "BING_SEARCH_API_KEY",
        "serpapi": "SERPAPI_API_KEY",
    }
    env_name = env_names.get(chosen, "BRAVE_SEARCH_API_KEY")
    return chosen, os.environ.get(env_name, "").strip()
