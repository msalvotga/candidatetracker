"""Subgroup label normalization. Original wording is never discarded."""

from __future__ import annotations

from .config import load_yaml


def mapping_index() -> dict[tuple[str, str], dict]:
    raw = load_yaml("subgroup_mappings.yaml")
    index: dict[tuple[str, str], dict] = {}
    for dimension, rows in (raw.get("dimensions") or {}).items():
        for row in rows:
            index[(dimension, row["original"].casefold())] = row
    return index


def normalize_subgroup(dimension: str, original: str, index: dict | None = None) -> dict:
    index = index if index is not None else mapping_index()
    found = index.get((dimension, original.casefold()))
    if found:
        return {
            "subgroup_original": original,
            "subgroup_normalized": found["normalized"],
            "compatible_group": found.get("compatible_group"),
            "mapped": True,
        }
    return {
        "subgroup_original": original,
        "subgroup_normalized": original,
        "compatible_group": f"unmapped:{dimension}:{original.casefold()}",
        "mapped": False,
    }
