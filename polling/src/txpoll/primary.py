"""Headline latent polling trend.

The primary estimate is the posterior mean of a daily random walk.
Exponential recency, local regression, and a straight average are comparisons.
"""

from __future__ import annotations

import json
import math
from datetime import date

import numpy as np

from .calibrate import load_calibration
from .dynamic import (
    Z50,
    Z80,
    Z95,
    DynamicPoll,
    change_variance,
    ewma_path,
    fit_latent,
    gaussian_interval,
    leave_one_out_impacts,
    local_linear_fast,
    straight_average_path,
)
from .measurement import Measurement, measure_margin

SLOW_HALF_LIVES = (21, 28, 35, 42)
Z = {
    "p2_5": -Z95,
    "p5": -1.64485363,
    "p10": -Z80,
    "p16": -0.99445788,
    "p25": -Z50,
    "p50": 0.0,
    "p75": Z50,
    "p84": 0.99445788,
    "p90": Z80,
    "p95": 1.64485363,
    "p97_5": Z95,
}


def conservative_half_life(calibration: dict) -> int:
    """Slow comparison. The overall EWMA winner is used only if it is already slow."""
    selected = int(calibration["selected"]["ewmaHalfLife"])
    if selected in SLOW_HALF_LIVES:
        return selected
    rows = [row for row in calibration.get("ewma", []) if int(row["halfLife"]) in SLOW_HALF_LIVES and row.get("raceRmse14") is not None]
    if not rows:
        return 28
    best = min(rows, key=lambda row: row["raceRmse14"])
    return int(best["halfLife"])


def build_dynamic_polls(polls, observations, calibration: dict) -> tuple[list[DynamicPoll], dict[int, Measurement]]:
    by_id = {poll.id: poll for poll in polls}
    selected = calibration["selected"]
    dynamic: list[DynamicPoll] = []
    measured: dict[int, Measurement] = {}
    for obs in observations:
        poll = by_id.get(obs.poll_id)
        if poll is None or poll.field_start is None or poll.field_end is None:
            continue
        mode = json.loads(poll.mode_json or "[]")
        if not isinstance(mode, list):
            mode = [str(mode)]
        reported = poll.design_effect_moe if poll.design_effect_moe is not None else poll.reported_moe
        effective = poll.methodology.effective_sample_size if poll.methodology else None
        measurement = measure_margin(
            obs.share_a,
            obs.share_b,
            poll.sample_size,
            reported,
            effective_sample_size=effective,
            moe_kind=poll.moe_kind,
            sample_type=poll.sample_type,
            mode=mode,
            excess_variance=float(selected["excessVariance"]),
            nonprobability_variance=float(selected["nonprobabilityVariance"]),
            rv_variance=float(selected["rvVariance"]),
            adults_variance=float(selected["adultsVariance"]),
        )
        release = poll.release_date.toordinal() if poll.release_date else poll.field_end.toordinal()
        dynamic.append(
            DynamicPoll(
                poll_id=poll.id,
                pollster=poll.pollster_canonical or poll.pollster,
                margin=float(obs.margin),
                R=measurement.R,
                field_start=poll.field_start.toordinal(),
                field_end=poll.field_end.toordinal(),
                release=release,
                sample_type=poll.sample_type,
            )
        )
        measured[poll.id] = measurement
    dynamic.sort(key=lambda item: (max(item.release, item.field_end), item.poll_id))
    return dynamic, measured


def _information(polls: list[DynamicPoll], as_of: int, dependence_days: int, recent_days: int) -> dict:
    recent = [poll for poll in polls if as_of - recent_days < max(poll.release, poll.field_end) <= as_of]
    parent = list(range(len(recent)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    for left, a in enumerate(recent):
        for right in range(left + 1, len(recent)):
            b = recent[right]
            if a.pollster == b.pollster and abs(max(a.release, a.field_end) - max(b.release, b.field_end)) <= dependence_days:
                parent[find(right)] = find(left)
    clusters: dict[int, float] = {}
    for index, poll in enumerate(recent):
        clusters[find(index)] = clusters.get(find(index), 0.0) + (1.0 / poll.R if poll.R > 0 else 0.0)
    weights = [value for value in clusters.values() if value > 0]
    total = sum(weights)
    effective = (total ** 2) / sum(value ** 2 for value in weights) if weights else 0.0
    average = float(np.mean([math.sqrt(poll.R) for poll in recent])) if recent else None
    return {
        "recentPolls": len(recent),
        "recentPollsters": len({poll.pollster for poll in recent}),
        "effectivePollCount": effective,
        "averageMeasurementSe": average,
        "windowDays": recent_days,
    }


def _changes(fit: dict, polls: list[DynamicPoll], day1: int) -> list[dict]:
    mean = fit["mean"]
    rows = []
    for horizon in (1, 3, 7, 14, 30):
        if horizon >= len(mean):
            continue
        change = float(mean[-1] - mean[-1 - horizon])
        variance = change_variance(fit["var"], fit["gain"], horizon)
        sd = math.sqrt(variance) if math.isfinite(variance) else None
        start = day1 - horizon
        fresh = [poll for poll in polls if start < max(poll.release, poll.field_end) <= day1]
        low, high = (None, None) if sd is None else gaussian_interval(change, sd, Z95)
        rows.append(
            {
                "days": horizon,
                "change": change,
                "sd": sd,
                "low95": low,
                "high95": high,
                "newPolls": len(fresh),
                "newPollsters": len({poll.pollster for poll in fresh}),
            }
        )
    return rows


def _uncertainty(mean: float, sd: float) -> dict:
    summary = {"method": "gaussian_posterior", "n": None, "mean": mean, "median": mean, "sd": sd}
    for key, z in Z.items():
        summary[key] = mean + z * sd
    summary["minimum"] = mean - 4.0 * sd
    summary["maximum"] = mean + 4.0 * sd
    summary["skewness"] = 0.0
    summary["pointEstimate"] = mean
    summary["pointEstimateDefinition"] = (
        "The displayed margin is the posterior mean of the latent polling margin. "
        "The posterior is Gaussian, so the mean and the median are the same number. "
        "The 50%, 80%, and 95% intervals are central posterior intervals. They are not bootstrap percentiles and not a win probability."
    )
    edges = np.linspace(summary["minimum"], summary["maximum"], 13)
    bins = []
    for left, right in zip(edges[:-1], edges[1:]):
        # Probability mass of the normal in the bin, shown as a count out of 400 so the chart scale is familiar.
        mass = _normal_cdf(right, mean, sd) - _normal_cdf(left, mean, sd)
        bins.append({"x0": float(left), "x1": float(right), "count": int(round(400 * mass))})
    summary["histogram"] = bins
    return summary


def _normal_cdf(x: float, mean: float, sd: float) -> float:
    if sd <= 0:
        return 1.0 if x >= mean else 0.0
    return 0.5 * (1.0 + math.erf((x - mean) / (sd * math.sqrt(2.0))))


def _emerging(primary: np.ndarray, fast: np.ndarray, conservative: np.ndarray) -> str | None:
    if len(primary) == 0 or not math.isfinite(float(primary[-1])):
        return None
    fast_now = float(fast[-1]) if len(fast) else float("nan")
    slow_now = float(conservative[-1]) if len(conservative) else float("nan")
    level_gap = math.isfinite(fast_now) and abs(fast_now - float(primary[-1])) >= 2 and math.isfinite(slow_now) and abs(slow_now - float(primary[-1])) <= 1
    move_gap = False
    if len(primary) > 7 and len(fast) > 7 and math.isfinite(float(fast[-1])) and math.isfinite(float(fast[-8])):
        move_gap = abs(float(fast[-1]) - float(fast[-8])) > 2 and abs(float(primary[-1]) - float(primary[-8])) < 0.5
    if level_gap or move_gap:
        return "Possible emerging movement; limited confirmation."
    return None


def lab_view(calibration: dict) -> dict:
    selected = calibration["selected"]
    best = min(calibration["stateSpace"], key=lambda row: row["raceRmse14"])
    rows = [
        {
            "model": "State-space",
            "selected": True,
            "rmse7": best["rmse7"],
            "rmse14": best["rmse14"],
            "rmse28": best["rmse28"],
            "mae": best["mae14"],
            "coverage95": best["coverage95"],
            "logLik14": best.get("logLik14"),
            "residualAutocorr": best["residualAutocorr"],
            "detail": f"q {selected['q']}, excess SD {selected['excessSd']}, firm SD {selected['firmSd']}",
        }
    ]
    for row in calibration["ewma"]:
        rows.append(
            {
                "model": f"EWMA {int(row['halfLife'])}",
                "selected": int(row["halfLife"]) == int(selected["ewmaHalfLife"]),
                "rmse7": row["rmse7"],
                "rmse14": row["rmse14"],
                "rmse28": row["rmse28"],
                "mae": row["mae14"],
                "coverage95": None,
                "logLik14": None,
                "residualAutocorr": None,
                "detail": "Comparison only. Not the primary recency mechanism.",
            }
        )
    for row in calibration.get("comparisons", []):
        rows.append(
            {
                "model": "Local regression" if row["model"] == "localRegression" else "Simple average",
                "selected": False,
                "rmse7": row["rmse7"],
                "rmse14": row["rmse14"],
                "rmse28": row["rmse28"],
                "mae": row["mae14"],
                "coverage95": None,
                "logLik14": None,
                "residualAutocorr": None,
                "detail": "Scored on the same historical checkpoints.",
            }
        )
    q_votes = sorted({item["q"] for item in calibration.get("leaveOneCycle", [])})
    half_votes = sorted({int(item["halfLife"]) for item in calibration.get("leaveOneCycleEwma", [])})
    return {
        "whyQ": calibration["whyQ"],
        "whyHalfLife": calibration["whyHalfLife"],
        "whyHouse": calibration.get("whyHouse"),
        "objective": calibration["objective"],
        "excludedFromObjective": calibration["excludedFromObjective"],
        "dateLimitation": calibration["dateLimitation"],
        "source": calibration["source"],
        "races": calibration["generatedFromRaces"],
        "cycles": calibration["cycles"],
        "selected": selected,
        "leaveOneCycleQ": q_votes,
        "leaveOneCycleHalfLife": half_votes,
        "rows": rows,
        "grid": [
            {
                "q": row["q"],
                "excessSd": row["excessSd"],
                "firmSd": row["firmSd"],
                "raceRmse14": row["raceRmse14"],
                "rmse7": row["rmse7"],
                "rmse14": row["rmse14"],
                "rmse28": row["rmse28"],
                "mae": row["mae14"],
                "coverage95": row["coverage95"],
                "residualAutocorr": row["residualAutocorr"],
            }
            for row in calibration["stateSpace"]
        ],
    }


def fit_primary(polls, observations, as_of: date, ordinals: np.ndarray | None = None) -> dict | None:
    try:
        calibration = load_calibration()
    except FileNotFoundError:
        return None
    dynamic, measured = build_dynamic_polls(polls, observations, calibration)
    if ordinals is not None and len(ordinals):
        day0 = int(ordinals[0])
        day1 = int(ordinals[-1])
    elif dynamic:
        day0 = min(poll.field_start for poll in dynamic)
        day1 = as_of.toordinal()
    else:
        return None
    if day1 < day0:
        day1 = day0
    selected = calibration["selected"]
    q = float(selected["q"])
    fit = fit_latent(
        dynamic,
        day0,
        day1,
        q,
        sigma_house=float(selected["sigmaHouse"]),
        firm_variance=float(selected["firmVariance"]),
        dependence_days=7,
        initial_sd=12.0,
    )
    mean = np.asarray(fit["mean"], dtype=float)
    sd_path = np.sqrt(np.maximum(fit["var"], 0.0))
    now = float(mean[-1])
    now_sd = float(sd_path[-1])
    low50, high50 = gaussian_interval(now, now_sd, Z50)
    low80, high80 = gaussian_interval(now, now_sd, Z80)
    low95, high95 = gaussian_interval(now, now_sd, Z95)
    slow = conservative_half_life(calibration)
    conservative = ewma_path(dynamic, day0, day1, slow)
    fast = local_linear_fast(dynamic, day0, day1, 14.0)
    straight = straight_average_path(dynamic, day0, day1)
    impacts = leave_one_out_impacts(
        dynamic,
        day0,
        day1,
        q,
        sigma_house=float(selected["sigmaHouse"]),
        firm_variance=float(selected["firmVariance"]),
        dependence_days=7,
        initial_sd=12.0,
    )
    return {
        "margin": now,
        "sd": now_sd,
        "low50": low50,
        "high50": high50,
        "low80": low80,
        "high80": high80,
        "low95": low95,
        "high95": high95,
        "mean": mean,
        "sdPath": sd_path,
        "conservative": conservative,
        "fast": fast,
        "straight": straight,
        "conservativeHalfLife": slow,
        "ewmaHalfLife": int(selected["ewmaHalfLife"]),
        "q": q,
        "house": fit["house"],
        "measurements": measured,
        "impacts": {row["pollId"]: row for row in impacts},
        "changes": _changes(fit, dynamic, day1),
        "information": _information(dynamic, day1, 7, 30),
        "emerging": _emerging(mean, fast, conservative),
        "uncertainty": _uncertainty(now, now_sd),
        "lab": lab_view(calibration),
        "populationNote": selected.get("populationNote"),
        "day0": day0,
    }
