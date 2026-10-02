"""Transparent polling-margin calculations.

The modeled number is a margin in percentage points, not a win probability.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from typing import Any

import numpy as np


def parse_date(value: date | datetime | str | None) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def field_midpoint(start: date | str | None, end: date | str | None) -> float | None:
    """Return the midpoint as a Python ordinal plus a fraction of a day.

    June 3 through June 4 is 3.5, not a silently rounded calendar date.
    """
    start_d = parse_date(start)
    end_d = parse_date(end)
    if start_d is None and end_d is None:
        return None
    if start_d is None:
        return float(end_d.toordinal())
    if end_d is None:
        return float(start_d.toordinal())
    if end_d < start_d:
        return None
    return start_d.toordinal() + (end_d.toordinal() - start_d.toordinal()) / 2.0


def ordinal_to_iso(value: float) -> str:
    whole = int(math.floor(value))
    return date.fromordinal(whole).isoformat()


def margin_pp(share_a: float, share_b: float) -> float:
    """Abbott minus Hinojosa when those are the configured candidates, in percentage points."""
    return float(share_a) - float(share_b)


def se_proportion_from_moe(moe_pp: float, z: float = 1.96) -> float:
    """Convert a percentage-point margin of error into the standard error of a proportion."""
    if moe_pp is None or z <= 0:
        raise ValueError("MOE and z must be positive")
    return (float(moe_pp) / 100.0) / float(z)


def n_eff_from_moe(moe_pp: float, proportion: float = 0.5, z: float = 1.96) -> float:
    """Invert MOE ≈ z * sqrt(p(1-p) / n_eff). Record the result as estimated."""
    se = se_proportion_from_moe(moe_pp, z)
    p = min(max(float(proportion), 0.01), 0.99)
    return (p * (1.0 - p)) / (se ** 2)


def variance_margin_proportion(p_a: float, p_b: float, n_eff: float) -> float:
    """Multinomial approximation Var(p_a - p_b) ≈ [p_a + p_b - (p_a - p_b)^2] / n_eff."""
    if n_eff <= 0:
        raise ValueError("n_eff must be positive")
    return (p_a + p_b - (p_a - p_b) ** 2) / n_eff


@dataclass
class PrecisionEstimate:
    se_margin_pp: float
    n_eff: float | None
    n_eff_estimated: bool
    moe_used: float | None
    note: str
    design_effect: float | None = None
    design_effect_estimated: bool = False
    sampling_variance_pp: float = 0.0


def estimate_margin_precision(
    share_a_pp: float,
    share_b_pp: float,
    sample_size: int | None,
    reported_moe: float | None,
    design_effect_moe: float | None,
    effective_sample_size: float | None,
    *,
    prefer_design_effect_moe: bool = True,
    z: float = 1.96,
    moe_inversion_proportion: float = 0.5,
) -> PrecisionEstimate:
    p_a = float(share_a_pp) / 100.0
    p_b = float(share_b_pp) / 100.0
    moe = None
    if prefer_design_effect_moe and design_effect_moe:
        moe = float(design_effect_moe)
        moe_note = "design-effect MOE"
    elif reported_moe:
        moe = float(reported_moe)
        moe_note = "reported MOE"
    else:
        moe_note = "no MOE"

    n_eff = None
    estimated = False
    note_parts = [moe_note]

    if effective_sample_size and effective_sample_size > 0:
        n_eff = float(effective_sample_size)
        note_parts.append("n_eff taken from the source")
    elif moe:
        n_eff = n_eff_from_moe(moe, moe_inversion_proportion, z)
        estimated = True
        note_parts.append(
            f"n_eff inverted from {moe_note} assuming a {moe_inversion_proportion:.2f} proportion"
        )
    elif sample_size and sample_size > 0:
        n_eff = float(sample_size)
        estimated = True
        note_parts.append("n_eff set equal to sample size because design effect is unknown")

    if n_eff is None or n_eff <= 0 or p_a < 0 or p_b < 0:
        raise ValueError("Cannot estimate margin precision without shares and a sample size or MOE")

    var = variance_margin_proportion(p_a, p_b, n_eff)
    se_pp = math.sqrt(max(var, 0.0)) * 100.0
    design_effect = None
    design_estimated = False
    if sample_size and sample_size > 0 and n_eff:
        design_effect = float(sample_size) / float(n_eff)
        design_estimated = estimated
        if moe is None:
            note_parts.append("No MOE was reported. n_eff was set equal to N, so the design effect is treated as 1")
        elif design_estimated:
            note_parts.append("design effect estimated as sample size / n_eff")
        else:
            note_parts.append("design effect is sample size / reported n_eff")
    elif moe is None:
        note_parts.append("No MOE was reported")
    return PrecisionEstimate(
        se_pp,
        n_eff,
        estimated,
        moe,
        "; ".join(note_parts),
        design_effect,
        design_estimated,
        se_pp ** 2,
    )


def precision_weight(se_margin_pp: float, tau_pp: float) -> float:
    return 1.0 / (se_margin_pp ** 2 + tau_pp ** 2)


def recency_weight(age_days: float, half_life_days: float) -> float:
    if half_life_days <= 0:
        raise ValueError("half_life_days must be positive")
    if age_days < 0:
        age_days = 0
    return 0.5 ** (age_days / half_life_days)


def half_life_for_date(config: dict[str, Any], as_of: date) -> tuple[float, str]:
    recency = config["recency"]
    base = float(recency["half_life_days"])
    adaptive = recency.get("adaptive") or {}
    if not adaptive.get("enabled"):
        return base, "fixed half-life"
    election = parse_date(config["race"]["election_date"])
    if election is None:
        return base, "fixed half-life; election date missing"
    days_out = (election - as_of).days
    chosen = base
    label = "fixed half-life"
    for band in adaptive.get("bands") or []:
        if days_out >= int(band["min_days_out"]):
            chosen = float(band["half_life_days"])
            label = f"adaptive half-life ({days_out} days before election)"
            break
    return chosen, label


def sample_type_weight(sample_type: str | None, config: dict[str, Any]) -> tuple[float, str]:
    weights = config["sample_type"]["weights"]
    key = sample_type or "Other"
    if key not in weights:
        key = "Other"
    return float(weights[key]), key


def sponsorship_weight(sponsor_type: str | None, config: dict[str, Any]) -> float:
    table = config["sponsorship_weights"]
    return float(table.get(sponsor_type or "unknown", table.get("unknown", 0.85)))


def source_completeness_code(*, tiers: list[int], has_methodology: bool, has_crosstabs: bool) -> str:
    """Document how the poll was sourced. This is not a sponsor or ideology score."""
    has_original = any(int(tier) <= 1 for tier in tiers)
    has_publication = any(int(tier) in {2, 4} for tier in tiers)
    if has_original and (has_methodology or has_crosstabs):
        return "original_with_methodology_or_crosstabs"
    if has_original:
        return "original_topline_limited_methodology"
    if has_publication:
        return "institutional_or_media_publication"
    return "aggregator_only"


def source_completeness_weight(code: str | None, config: dict[str, Any]) -> float:
    table = config["source_completeness"]
    key = code or "aggregator_only"
    if key not in table:
        key = "aggregator_only"
    return float(table[key])


SOURCE_COMPLETENESS_LABELS = {
    "original_with_methodology_or_crosstabs": "Original pollster source with methodology or crosstabs",
    "original_topline_limited_methodology": "Original pollster topline with limited methodology",
    "institutional_or_media_publication": "Institutional or media publication with poll details",
    "aggregator_only": "Aggregator-only result; original source not resolved",
}


def nearest_same_pollster_gap(names: list[str], midpoints: list[float]) -> list[float | None]:
    gaps: list[float | None] = []
    for index, name in enumerate(names):
        best = None
        for other_index, other in enumerate(names):
            if other_index == index or other != name:
                continue
            gap = abs(midpoints[index] - midpoints[other_index])
            if best is None or gap < best:
                best = gap
        gaps.append(best)
    return gaps


DRAW_PERCENTILES = (
    ("p2_5", 2.5),
    ("p5", 5.0),
    ("p10", 10.0),
    ("p16", 16.0),
    ("p25", 25.0),
    ("p50", 50.0),
    ("p75", 75.0),
    ("p84", 84.0),
    ("p90", 90.0),
    ("p95", 95.0),
    ("p97_5", 97.5),
)


def summarize_draws(draws) -> dict[str, Any]:
    """Percentile summary. Draws are not clipped, winsorized, or bounded."""
    values = np.asarray(draws, dtype=float)
    values = values[np.isfinite(values)]
    if len(values) == 0:
        return {"n": 0, "method": "percentile"}
    mean = float(values.mean())
    sd = float(values.std(ddof=0))
    skew = 0.0 if sd == 0 else float(np.mean(((values - mean) / sd) ** 3))
    summary: dict[str, Any] = {
        "n": int(len(values)),
        "mean": mean,
        "median": float(np.percentile(values, 50)),
        "sd": sd,
        "minimum": float(values.min()),
        "maximum": float(values.max()),
        "skewness": skew,
        "method": "percentile",
        "interval80": "10th to 90th percentile of the cluster-bootstrap draws",
        "interval95": "2.5th to 97.5th percentile of the cluster-bootstrap draws",
    }
    for name, percentile in DRAW_PERCENTILES:
        summary[name] = float(np.percentile(values, percentile))
    return summary


def histogram_bins(draws, bins: int = 16) -> list[dict[str, float | int]]:
    values = np.asarray(draws, dtype=float)
    values = values[np.isfinite(values)]
    if len(values) == 0:
        return []
    counts, edges = np.histogram(values, bins=bins)
    return [
        {"x0": float(edges[i]), "x1": float(edges[i + 1]), "count": int(counts[i])}
        for i in range(len(counts))
    ]


def cluster_ids(pollster: list[str], midpoints: list[float], window_days: float) -> list[int]:
    """Connected components: same pollster and gaps of at most window_days."""
    order = sorted(range(len(pollster)), key=lambda i: (pollster[i], midpoints[i]))
    cluster = [-1] * len(pollster)
    next_id = 0
    previous = None
    for index in order:
        if previous is None or pollster[index] != pollster[previous] or midpoints[index] - midpoints[previous] > window_days:
            current = next_id
            next_id += 1
        else:
            current = cluster[previous]
        cluster[index] = current
        previous = index
    return cluster


def cluster_adjustments(cluster: list[int], method: str, cap_multiple: float, raw_weights: list[float]) -> list[float]:
    counts: dict[int, int] = {}
    for item in cluster:
        counts[item] = counts.get(item, 0) + 1
    if method == "cap":
        factors = []
        totals: dict[int, float] = {}
        for i, cid in enumerate(cluster):
            totals[cid] = totals.get(cid, 0.0) + raw_weights[i]
        for i, cid in enumerate(cluster):
            cap = cap_multiple * max(raw_weights[j] for j, c in enumerate(cluster) if c == cid)
            scale = min(1.0, cap / totals[cid]) if totals[cid] else 1.0
            factors.append(scale)
        return factors
    return [1.0 / math.sqrt(counts[cid]) for cid in cluster]


def normalize(weights: list[float]) -> list[float]:
    total = float(sum(weights))
    if total <= 0:
        return [0.0 for _ in weights]
    return [w / total for w in weights]


def tricube(distance: np.ndarray, bandwidth: float) -> np.ndarray:
    u = np.abs(distance) / bandwidth
    return np.where(u < 1.0, (1.0 - u**3) ** 3, 0.0)


def local_linear_at(x: np.ndarray, y: np.ndarray, w: np.ndarray, x0: float, bandwidth: float) -> float:
    kern = tricube(x - x0, bandwidth)
    ww = w * kern
    if not np.isfinite(ww).all() or float(ww.sum()) <= 0:
        return float("nan")
    if int(np.sum(ww > 0)) == 1:
        return float(y[ww > 0][0])
    design = np.column_stack([np.ones(len(x)), x - x0])
    scale = np.sqrt(ww)
    beta, *_ = np.linalg.lstsq(design * scale[:, None], y * scale, rcond=None)
    return float(beta[0])


def local_linear_grid(
    x: np.ndarray,
    y: np.ndarray,
    w: np.ndarray,
    grid: np.ndarray,
    bandwidth: float,
) -> np.ndarray:
    return np.array([local_linear_at(x, y, w, float(x0), bandwidth) for x0 in grid])


def active_half_life_label(config: dict[str, Any], as_of: date) -> str:
    _value, label = half_life_for_date(config, as_of)
    return label


@dataclass
class Observation:
    poll_id: int
    external_key: str
    pollster: str
    pollster_canonical: str
    sponsor: str | None
    sponsor_type: str
    midpoint: float
    field_label: str
    release_date: str | None
    sample_size: int | None
    sample_type: str | None
    reported_moe: float | None
    ballot_configuration: str | None
    share_a: float
    share_b: float
    other_pp: float | None
    undecided_pp: float | None
    margin: float
    se_margin_pp: float
    n_eff: float | None
    n_eff_estimated: bool
    precision_note: str
    source_label: str
    review_status: str
    source_completeness: str = "aggregator_only"
    same_sample_note: str = ""
    design_effect: float | None = None
    design_effect_estimated: bool = False
    sampling_variance_pp: float = 0.0
    warnings: list[str] = field(default_factory=list)


@dataclass
class WeightedPoll:
    observation: Observation
    precision: float
    recency: float
    sample_type_factor: float
    sample_type_key: str
    sponsorship: float
    cluster_factor: float
    cluster_size: int
    raw_weight: float
    normalized_weight: float
    source_quality: float = 1.0
    source_quality_code: str = ""
    sponsor_table: float = 1.0
    outlier_factor: float = 1.0
    age_days: float = 0.0
    base_half_life: float = 0.0
    effective_half_life: float = 0.0
    sampling_variance: float = 0.0
    variance_floor: float = 0.0
    total_variance: float = 0.0
    precision_share: float = 0.0
    nearest_gap_days: float | None = None
    house_effect: float | None = None
    adjusted_margin: float | None = None


def build_weights(
    observations: list[Observation],
    config: dict[str, Any],
    as_of: date,
    *,
    sample_types: set[str] | None = None,
    weight_mode: str = "full",
    quality: str = "source",
) -> tuple[list[WeightedPoll], float, str]:
    """weight_mode: full | equal | sample_size.

    quality:
      source — source-completeness multiplier, no sponsor multiplier (the default)
      sponsor — legacy sponsor-type multiplier, no source-completeness multiplier
      both — source completeness and, only if configured, sponsor type
      none — neither multiplier
    """
    half_life, half_life_label = half_life_for_date(config, as_of)
    base_half_life = float(config["recency"]["half_life_days"])
    tau = float(config["precision"]["tau_pp"])
    outlier_factor = float(config.get("outliers", {}).get("multiplier", 1.0))
    apply_sponsor = bool(config.get("sponsorship_weights", {}).get("apply_in_default_model"))
    selected = []
    for obs in observations:
        if sample_types and (obs.sample_type or "Other") not in sample_types:
            continue
        selected.append(obs)
    if not selected:
        return [], half_life, half_life_label

    as_of_ord = float(as_of.toordinal())
    precision_parts = []
    recency_parts = []
    sample_parts = []
    source_parts = []
    sponsor_applied = []
    sponsor_table = []
    ages = []
    variances = []
    for obs in selected:
        prec = precision_weight(obs.se_margin_pp, tau)
        age = max(0.0, as_of_ord - obs.midpoint)
        rec = recency_weight(age, half_life)
        st_w, st_key = sample_type_weight(obs.sample_type, config)
        source = source_completeness_weight(obs.source_completeness, config)
        sponsor = sponsorship_weight(obs.sponsor_type, config)
        if quality == "sponsor":
            use_source, use_sponsor = False, True
        elif quality == "none":
            use_source, use_sponsor = False, False
        else:
            use_source, use_sponsor = True, apply_sponsor
        if weight_mode == "equal":
            prec, rec, st_w, source, sponsor = 1.0, 1.0, 1.0, 1.0, 1.0
            use_source = use_sponsor = False
        elif weight_mode == "sample_size":
            prec = float(obs.sample_size or 0)
            rec, st_w, source, sponsor = 1.0, 1.0, 1.0, 1.0
            use_source = use_sponsor = False
        precision_parts.append(prec)
        recency_parts.append(rec)
        sample_parts.append((st_w, st_key))
        source_parts.append(source if use_source else 1.0)
        sponsor_applied.append(sponsor if use_sponsor else 1.0)
        sponsor_table.append(sponsor)
        ages.append(age)
        sampling = obs.sampling_variance_pp or (obs.se_margin_pp ** 2)
        variances.append((sampling, tau ** 2, sampling + tau ** 2))

    pre_cluster = [
        precision_parts[i] * recency_parts[i] * sample_parts[i][0] * source_parts[i] * sponsor_applied[i] * outlier_factor
        for i in range(len(selected))
    ]
    names = [obs.pollster_canonical for obs in selected]
    midpoints = [obs.midpoint for obs in selected]
    gaps = nearest_same_pollster_gap(names, midpoints)
    if weight_mode == "full":
        cids = cluster_ids(names, midpoints, float(config["clustering"]["window_days"]))
        factors = cluster_adjustments(
            cids,
            str(config["clustering"]["method"]),
            float(config["clustering"].get("cap_multiple", 1.5)),
            pre_cluster,
        )
    else:
        cids = list(range(len(selected)))
        factors = [1.0] * len(selected)
    counts: dict[int, int] = {}
    for cid in cids:
        counts[cid] = counts.get(cid, 0) + 1
    raw_weights = [pre_cluster[i] * factors[i] for i in range(len(selected))]
    normalized = normalize(raw_weights)
    precision_total = sum(precision_parts) or 1.0
    weighted = []
    for i, obs in enumerate(selected):
        weighted.append(
            WeightedPoll(
                observation=obs,
                precision=precision_parts[i],
                recency=recency_parts[i],
                sample_type_factor=sample_parts[i][0],
                sample_type_key=sample_parts[i][1],
                sponsorship=sponsor_applied[i],
                cluster_factor=factors[i],
                cluster_size=counts[cids[i]],
                raw_weight=raw_weights[i],
                normalized_weight=normalized[i],
                source_quality=source_parts[i],
                source_quality_code=obs.source_completeness,
                sponsor_table=sponsor_table[i],
                outlier_factor=outlier_factor if weight_mode == "full" else 1.0,
                age_days=ages[i],
                base_half_life=base_half_life,
                effective_half_life=half_life,
                sampling_variance=variances[i][0],
                variance_floor=variances[i][1],
                total_variance=variances[i][2],
                precision_share=precision_parts[i] / precision_total,
                nearest_gap_days=gaps[i],
                adjusted_margin=obs.margin,
            )
        )
    return weighted, half_life, half_life_label


def series_from_weights(
    weighted: list[WeightedPoll],
    config: dict[str, Any],
    as_of: date,
    *,
    margin_attr: str = "adjusted_margin",
    grid: np.ndarray | None = None,
) -> dict[str, Any]:
    if not weighted and grid is None:
        return {"dates": [], "estimate": []}
    x = np.array([item.observation.midpoint for item in weighted], dtype=float) if weighted else np.array([])
    y = np.array(
        [getattr(item, margin_attr) if getattr(item, margin_attr) is not None else item.observation.margin for item in weighted],
        dtype=float,
    ) if weighted else np.array([])
    w = np.array([max(item.normalized_weight, 1e-12) for item in weighted], dtype=float) if weighted else np.array([])
    if grid is None:
        start = int(math.floor(float(x.min())))
        end = as_of.toordinal()
        if end < start:
            end = start
        grid = np.arange(start, end + 1, dtype=float)
    else:
        grid = np.asarray(grid, dtype=float)
    bandwidth = float(config["trend"]["bandwidth_days"])
    if not weighted:
        estimate = np.full(len(grid), np.nan)
    else:
        estimate = local_linear_grid(x, y, w, grid, bandwidth)
        # Local-linear slope at the right edge is not a forecast. Hold the
        # fitted value on the newest field midpoint for every later day.
        last_midpoint = float(np.max(x))
        held = local_linear_at(x, y, w, last_midpoint, bandwidth)
        estimate = np.where(grid > last_midpoint + 1e-6, held, estimate)
    return {
        "dates": [date.fromordinal(int(g)).isoformat() for g in grid],
        "ordinals": grid,
        "estimate": estimate,
        "x": x,
        "y": y,
        "w": w,
    }


def cluster_bootstrap(
    weighted: list[WeightedPoll],
    config: dict[str, Any],
    as_of: date,
    *,
    draws: int | None = None,
    seed: int | None = None,
) -> dict[str, np.ndarray]:
    """Resample pollsters with replacement so repeated polls are not independent."""
    base = series_from_weights(weighted, config, as_of)
    if not weighted:
        return {"low80": np.array([]), "high80": np.array([]), "low95": np.array([]), "high95": np.array([]), "base": base}
    grid = base["ordinals"]
    rng = np.random.default_rng(config["trend"].get("bootstrap_seed", 2026) if seed is None else seed)
    n_draws = int(draws if draws is not None else config["trend"].get("bootstrap_draws", 400))
    groups: dict[str, list[int]] = {}
    for i, item in enumerate(weighted):
        groups.setdefault(item.observation.pollster_canonical, []).append(i)
    names = list(groups)
    paths = []
    for _ in range(n_draws):
        drawn = rng.choice(len(names), size=len(names), replace=True)
        indexes: list[int] = []
        for name_index in drawn:
            indexes.extend(groups[names[int(name_index)]])
        sample = [weighted[i] for i in indexes]
        # Renormalize the already computed raw weights. Do not clip the margins.
        total = sum(item.raw_weight for item in sample) or 1.0
        resampled = [replace(item, normalized_weight=item.raw_weight / total) for item in sample]
        path = series_from_weights(resampled, config, as_of, grid=grid)
        paths.append(path["estimate"])
    stack = np.vstack(paths)
    current = stack[:, -1]
    return {
        "low95": np.nanpercentile(stack, 2.5, axis=0),
        "low80": np.nanpercentile(stack, 10, axis=0),
        "high80": np.nanpercentile(stack, 90, axis=0),
        "high95": np.nanpercentile(stack, 97.5, axis=0),
        "base": base,
        "currentDraws": current,
        "drawSummary": summarize_draws(current),
        "histogram": histogram_bins(current),
        "intervalMethod": "percentile",
    }


def house_effects(
    weighted: list[WeightedPoll],
    trend_at_midpoint: list[float],
    config: dict[str, Any],
) -> dict[str, dict[str, float | int | None | str]]:
    """Shrink pollster mean residuals toward zero. One poll is not a house effect."""
    minimum = int(config["house_effects"]["minimum_polls"])
    k = float(config["house_effects"]["shrinkage_k"])
    buckets: dict[str, list[tuple[float, float]]] = {}
    for item, fitted in zip(weighted, trend_at_midpoint):
        if fitted is None or not math.isfinite(fitted):
            continue
        residual = item.observation.margin - fitted
        buckets.setdefault(item.observation.pollster_canonical, []).append((residual, item.raw_weight))
    results: dict[str, dict[str, float | int | None | str]] = {}
    for name, rows in buckets.items():
        n = len(rows)
        residuals = np.array([r for r, _w in rows], dtype=float)
        raw = float(residuals.mean())
        sd = float(residuals.std(ddof=1)) if n > 1 else None
        if n < minimum:
            results[name] = {
                "polls": n,
                "estimate": None,
                "raw_mean": raw,
                "se": None,
                "label": f"Not estimated ({n} poll{'s' if n != 1 else ''}; need {minimum})",
            }
            continue
        shrink = n / (n + k)
        estimate = raw * shrink
        se = None if sd is None else (sd / math.sqrt(n)) / math.sqrt(shrink) if shrink else None
        # The division by sqrt(shrink) widens the interval because shrinkage
        # does not create information. If shrink is 0, se stays None.
        if se is not None and shrink > 0:
            se = (sd / math.sqrt(n)) * math.sqrt((n + k) / n)
        direction = "Abbott" if estimate >= 0 else "Hinojosa"
        results[name] = {
            "polls": n,
            "estimate": estimate,
            "raw_mean": raw,
            "se": se,
            "shrinkage": shrink,
            "label": f"{estimate:+.1f} {direction}",
        }
    return results


def apply_house_effects(weighted: list[WeightedPoll], effects: dict[str, dict[str, Any]]) -> None:
    for item in weighted:
        effect = effects.get(item.observation.pollster_canonical, {}).get("estimate")
        item.house_effect = float(effect) if effect is not None else 0.0
        item.adjusted_margin = item.observation.margin - item.house_effect


def standardized_residual(residual: float, se_margin_pp: float, tau_pp: float) -> float:
    scale = math.sqrt(se_margin_pp ** 2 + tau_pp ** 2)
    if scale <= 0:
        return float("inf")
    return residual / scale


def kalman_local_level(
    observations: list[tuple[float, float, float]],
    grid: np.ndarray,
    process_sd: float,
    initial_mean: float,
    initial_sd: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Random-walk latent margin. observations are (ordinal, margin, observation_sd).

    Returns smoothed mean and smoothed standard deviation on `grid`.
    This interval is uncertainty about the polling trend, not a win probability.
    """
    if len(grid) == 0:
        return np.array([]), np.array([])
    process_var = process_sd ** 2
    by_day: dict[int, list[tuple[float, float]]] = {}
    for ordinal, margin, sd in observations:
        by_day.setdefault(int(round(ordinal)), []).append((margin, max(sd, 1e-6)))

    n = len(grid)
    filt_mean = np.zeros(n)
    filt_var = np.zeros(n)
    pred_mean = np.zeros(n)
    pred_var = np.zeros(n)
    mean = initial_mean
    var = initial_sd ** 2
    for i, day in enumerate(grid):
        if i > 0:
            gap = float(grid[i] - grid[i - 1])
            var = var + process_var * max(gap, 1.0)
        pred_mean[i] = mean
        pred_var[i] = var
        for margin, sd in by_day.get(int(day), []):
            obs_var = sd ** 2
            gain = var / (var + obs_var)
            mean = mean + gain * (margin - mean)
            var = (1.0 - gain) * var
        filt_mean[i] = mean
        filt_var[i] = var

    smooth_mean = filt_mean.copy()
    smooth_var = filt_var.copy()
    for i in range(n - 2, -1, -1):
        if pred_var[i + 1] <= 0:
            continue
        gain = filt_var[i] / pred_var[i + 1]
        smooth_mean[i] = filt_mean[i] + gain * (smooth_mean[i + 1] - pred_mean[i + 1])
        smooth_var[i] = filt_var[i] + gain ** 2 * (smooth_var[i + 1] - pred_var[i + 1])
    smooth_sd = np.sqrt(np.maximum(smooth_var, 0.0))
    return smooth_mean, smooth_sd


def leader_text(margin: float | None, config: dict[str, Any]) -> str:
    if margin is None or not math.isfinite(margin):
        return "Unavailable"
    band = float(config["margin"].get("even_band_pp", 0.5))
    a = config["margin"]["candidate_a"].split()[-1]
    b = config["margin"]["candidate_b"].split()[-1]
    if abs(margin) < band:
        return "Approximately even"
    if margin > 0:
        return f"{a} +{margin:.1f}"
    return f"{b} +{abs(margin):.1f}"
