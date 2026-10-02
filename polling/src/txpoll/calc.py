"""Transparent polling-margin calculations.

The modeled number is a margin in percentage points, not a win probability.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
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
    return PrecisionEstimate(se_pp, n_eff, estimated, moe, "; ".join(note_parts))


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
    house_effect: float | None = None
    adjusted_margin: float | None = None


def build_weights(
    observations: list[Observation],
    config: dict[str, Any],
    as_of: date,
    *,
    sample_types: set[str] | None = None,
    weight_mode: str = "full",
) -> tuple[list[WeightedPoll], float, str]:
    """weight_mode: full | equal | sample_size."""
    half_life, half_life_label = half_life_for_date(config, as_of)
    tau = float(config["precision"]["tau_pp"])
    selected = []
    for obs in observations:
        if sample_types and (obs.sample_type or "Other") not in sample_types:
            continue
        selected.append(obs)
    if not selected:
        return [], half_life, half_life_label

    as_of_ord = float(as_of.toordinal())
    raw = []
    precision_parts = []
    recency_parts = []
    sample_parts = []
    sponsor_parts = []
    for obs in selected:
        prec = precision_weight(obs.se_margin_pp, tau)
        age = max(0.0, as_of_ord - obs.midpoint)
        rec = recency_weight(age, half_life)
        st_w, st_key = sample_type_weight(obs.sample_type, config)
        sp = sponsorship_weight(obs.sponsor_type, config)
        if weight_mode == "equal":
            prec, rec, st_w, sp = 1.0, 1.0, 1.0, 1.0
        elif weight_mode == "sample_size":
            prec = float(obs.sample_size or 0)
            rec, st_w, sp = 1.0, 1.0, 1.0
        precision_parts.append(prec)
        recency_parts.append(rec)
        sample_parts.append((st_w, st_key))
        sponsor_parts.append(sp)

    pre_cluster = [
        precision_parts[i] * recency_parts[i] * sample_parts[i][0] * sponsor_parts[i]
        for i in range(len(selected))
    ]
    if weight_mode == "full":
        cids = cluster_ids(
            [obs.pollster_canonical for obs in selected],
            [obs.midpoint for obs in selected],
            float(config["clustering"]["window_days"]),
        )
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
    weighted = []
    for i, obs in enumerate(selected):
        weighted.append(
            WeightedPoll(
                observation=obs,
                precision=precision_parts[i],
                recency=recency_parts[i],
                sample_type_factor=sample_parts[i][0],
                sample_type_key=sample_parts[i][1],
                sponsorship=sponsor_parts[i],
                cluster_factor=factors[i],
                cluster_size=counts[cids[i]],
                raw_weight=raw_weights[i],
                normalized_weight=normalized[i],
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
        # Renormalize inside build? The sample already has weights. Re-normalize.
        total = sum(item.raw_weight for item in sample) or 1.0
        resampled = []
        for item in sample:
            resampled.append(
                WeightedPoll(
                    observation=item.observation,
                    precision=item.precision,
                    recency=item.recency,
                    sample_type_factor=item.sample_type_factor,
                    sample_type_key=item.sample_type_key,
                    sponsorship=item.sponsorship,
                    cluster_factor=item.cluster_factor,
                    cluster_size=item.cluster_size,
                    raw_weight=item.raw_weight,
                    normalized_weight=item.raw_weight / total,
                    adjusted_margin=item.adjusted_margin,
                )
            )
        path = series_from_weights(resampled, config, as_of, grid=grid)
        paths.append(path["estimate"])
    stack = np.vstack(paths)
    return {
        "low95": np.nanpercentile(stack, 2.5, axis=0),
        "low80": np.nanpercentile(stack, 10, axis=0),
        "high80": np.nanpercentile(stack, 90, axis=0),
        "high95": np.nanpercentile(stack, 97.5, axis=0),
        "base": base,
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
