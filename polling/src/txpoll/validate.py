"""Validation before a poll can enter the model. Warnings are kept; they are not quietly dropped."""

from __future__ import annotations

from datetime import date

from .calc import field_midpoint, parse_date


MAJOR = ("Greg Abbott", "Gina Hinojosa")
SAMPLE_TYPES = {"LV", "RV", "Adults", "Other"}


def validate_poll(record: dict, config: dict, as_of: date | None = None) -> list[dict]:
    messages: list[dict] = []
    as_of = as_of or date.today()
    race = config.get("race") or {}

    def add(level: str, code: str, message: str) -> None:
        messages.append({"level": level, "code": code, "message": message})

    if record.get("state") != race.get("state") or record.get("race") != race.get("office") or int(record.get("cycle") or 0) != int(race.get("cycle") or 0):
        add("error", "wrong_race", "This record is not the configured race (Texas Governor 2026).")

    start, end = parse_date(record.get("field_start")), parse_date(record.get("field_end"))
    if start is None or end is None:
        add("error", "missing_dates", "Field start and field end are both required.")
    elif end < start:
        add("error", "date_order", "Field end is before field start.")
    else:
        if start > as_of or end > as_of:
            add("error", "future_dates", "Field dates are after the as-of date.")
        series_start = parse_date(race.get("series_start"))
        if series_start and end < series_start:
            add("warning", "before_series", "Fieldwork ended before the configured series start (post-nomination).")

    release = parse_date(record.get("release_date"))
    if release and end and release < end:
        add("warning", "release_before_field_end", "Release date is before the field end.")
    if release and release > as_of:
        add("warning", "future_release", "Release date is after the as-of date.")

    n = record.get("sample_size")
    if not n or int(n) <= 0:
        add("error", "missing_n", "Sample size is missing or not positive.")
    elif record.get("sample_size_provenance") and "not extracted" in str(record.get("sample_size_provenance")).lower():
        add("warning", "n_provenance", record["sample_size_provenance"])

    sample_type = record.get("sample_type")
    if sample_type not in SAMPLE_TYPES:
        add("error", "sample_type", f"Sample type {sample_type!r} is not LV, RV, Adults, or Other.")

    if not record.get("pollster"):
        add("error", "pollster", "Pollster is missing.")
    if not (record.get("sources") or []):
        add("error", "source", "At least one source is required.")
    else:
        best = min(int(src.get("tier", 5)) for src in record["sources"])
        if best > 2:
            add("warning", "no_primary_source", "No tier-1 or tier-2 source is attached. Aggregator or news figures only.")

    moe = record.get("design_effect_moe") or record.get("reported_moe")
    rules = config.get("validation") or {}
    if moe is None:
        add("warning", "missing_moe", "No margin of error was stored. Precision will be inferred from sample size if the poll is modeled.")
    else:
        moe = float(moe)
        if moe < float(rules.get("moe_min", 0.4)) or moe > float(rules.get("moe_max", 15)):
            add("warning", "implausible_moe", f"Reported uncertainty {moe} points is outside {rules.get('moe_min')}–{rules.get('moe_max')}.")
        if n and moe < _simple_moe(int(n)) * 0.55:
            add("warning", "moe_tighter_than_srs", "The reported MOE is much tighter than a simple random sample of this size. It may be a credibility interval or a subgroup figure.")

    shares = [row for row in record.get("results") or [] if row.get("result_frame", "headline") == "headline"]
    by_name = {row.get("candidate"): row for row in shares}
    for name in MAJOR:
        row = by_name.get(name)
        if row is None or row.get("percentage") is None:
            add("error", "missing_candidate", f"{name} does not have a numeric headline share.")
        else:
            pct = float(row["percentage"])
            if pct < 0 or pct > 100:
                add("error", "share_range", f"{name} share {pct} is outside 0–100.")

    numeric = [float(row["percentage"]) for row in shares if row.get("percentage") is not None]
    symbols = [row for row in shares if row.get("percentage") is None and row.get("reported_symbol")]
    if numeric:
        total = sum(numeric)
        tolerance = float(rules.get("percentage_sum_tolerance", 1.5))
        if symbols:
            add("info", "non_numeric_remainder", "At least one headline category was published as a symbol rather than a number, so the total cannot be forced to 100.")
        elif abs(total - 100) > tolerance:
            add("warning", "share_total", f"Headline shares sum to {total:.1f}, outside ±{tolerance} of 100.")
        elif abs(total - 100) > 0.05:
            add("info", "rounding", f"Headline shares sum to {total:.1f}. Within the rounding tolerance.")

    if record.get("extraction_warnings"):
        for text in record["extraction_warnings"]:
            add("warning", "extraction", text)

    if field_midpoint(record.get("field_start"), record.get("field_end")) is None and start and end:
        add("error", "midpoint", "Field midpoint could not be calculated.")

    return messages


def has_errors(messages: list[dict]) -> bool:
    return any(item["level"] == "error" for item in messages)


def _simple_moe(n: int) -> float:
    # 1.96 * sqrt(0.25 / n) in percentage points
    return 1.96 * (0.25 / n) ** 0.5 * 100.0


def source_priority(sources: list[dict]) -> dict | None:
    """Lowest tier wins. A PDF at the same tier beats an HTML page."""
    if not sources:
        return None

    def key(src: dict) -> tuple:
        url = (src.get("url") or "").lower()
        pdf = 0 if url.endswith(".pdf") or src.get("source_type") in {"original_pdf", "crosstab"} else 1
        return (int(src.get("tier", 5)), pdf)

    return sorted(sources, key=key)[0]
