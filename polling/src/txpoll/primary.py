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
        prob_pos, prob_neg = _direction_probability(change, sd)
        rows.append(
            {
                "days": horizon,
                "change": change,
                "sd": sd,
                "low95": low,
                "high95": high,
                "probPositive": prob_pos,
                "probNegative": prob_neg,
                "newPolls": len(fresh),
                "newPollsters": len({poll.pollster for poll in fresh}),
            }
        )
    return rows


def _direction_probability(change: float, sd: float | None) -> tuple[float | None, float | None]:
    """Posterior probability the latent margin moved up or down. Not a win probability."""
    if sd is None or not math.isfinite(sd) or sd <= 0 or not math.isfinite(change):
        return None, None
    prob_pos = 0.5 * (1.0 + math.erf((change / sd) / math.sqrt(2.0)))
    return prob_pos, 1.0 - prob_pos


def simulate_margin(mean: float, sd: float, runs: int = 100_000, seed: int = 2026) -> dict | None:
    """Draw the current polling margin. A positive draw is an Abbott lead in that draw.

    This is not a simulated election and not a probability that either candidate wins.
    """
    if not math.isfinite(mean) or not math.isfinite(sd) or sd < 0 or runs < 1:
        return None
    rng = np.random.default_rng(seed)
    draws = rng.normal(mean, max(sd, 0.0), size=runs)
    abbott = int(np.sum(draws > 0))
    hinojosa = int(np.sum(draws < 0))
    ties = int(runs - abbott - hinojosa)
    return {
        "runs": runs,
        "seed": seed,
        "abbottLeads": abbott,
        "hinojosaLeads": hinojosa,
        "ties": ties,
        "abbottShare": abbott / runs,
        "hinojosaShare": hinojosa / runs,
        "note": (
            "Each run draws one value from the posterior of today's latent polling margin. "
            "A lead means that draw is positive for Abbott. It is not a simulated election and not a probability that either candidate wins."
        ),
    }


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


def _movement_alert(changes: list[dict], polls: list[DynamicPoll], updates: list[dict], day1: int) -> str | None:
    """Corroborated movement in the primary latent margin. The fast model cannot trigger this."""
    row = next((item for item in changes if item["days"] == 14), None)
    if row is None or row.get("probPositive") is None:
        return None
    if row["probPositive"] >= 0.80:
        direction = 1.0
    elif row["probNegative"] >= 0.80:
        direction = -1.0
    else:
        return None
    recent = [poll for poll in polls if day1 - 14 < max(poll.release, poll.field_end) <= day1]
    if len({poll.pollster for poll in recent}) < 2:
        return None
    if _information(polls, day1, 7, 14)["effectivePollCount"] < 1.5:
        return None
    agreeing = {
        update["pollster"]
        for update in updates
        if day1 - 14 < update["day"] <= day1 and update["innovation"] * direction > 0
    }
    if len(agreeing) < 2:
        return None
    return "Recent polling provides some evidence of movement in the estimated polling margin, but confirmation remains limited."


def lab_view(calibration: dict) -> dict:
    selected = calibration["selected"]
    matching = [
        row
        for row in calibration["stateSpace"]
        if row["q"] == selected["q"] and row["excessSd"] == selected["excessSd"] and row["firmSd"] == selected["firmSd"]
    ]
    best = matching[0] if matching else min(calibration["stateSpace"], key=lambda row: row.get("selectionScore") or row["raceRmse14"])
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


def _decorate_impacts(impacts: list[dict], fit: dict, measured: dict[int, Measurement], firm_variance: float) -> list[dict]:
    updates = {row["pollId"]: row for row in fit.get("updates") or []}
    averages = fit.get("fieldAverage") or {}
    rows = []
    for impact in impacts:
        update = updates.get(impact["pollId"]) or {}
        measurement = measured.get(impact["pollId"])
        sampling_se = None if measurement is None else measurement.sampling_se
        excess_sd = None if measurement is None else math.sqrt(max(measurement.excess_variance, 0.0))
        population_sd = None
        if measurement is not None:
            population_sd = math.sqrt(max(measurement.population_variance + measurement.method_variance, 0.0))
        order = int(update.get("firmOrder") or 1)
        rows.append(
            {
                **impact,
                "samplingSe": sampling_se,
                "excessSd": excess_sd,
                "firmShockSd": math.sqrt(max(firm_variance, 0.0)),
                "firmTermSd": math.sqrt(max(firm_variance * order, 0.0)),
                "populationModeSd": population_sd,
                "varianceFloorSd": 0.0,
                "finalObservationSd": update.get("observationSd"),
                "expectedField": averages.get(impact["pollId"]),
                "kalmanExpected": update.get("expected"),
                "innovation": update.get("innovation"),
                "priorSd": update.get("priorSd"),
                "gain": update.get("gain"),
                "before": update.get("before"),
                "after": update.get("after"),
                "update": update.get("update"),
                "houseEffect": update.get("houseEffect"),
                "firmOrder": order,
            }
        )
    return rows


def _audit(calibration: dict, fit: dict, polls: list[DynamicPoll], measured, margin: float, sd: float, changes: list[dict]) -> dict:
    selected = calibration["selected"]
    updates = fit.get("updates") or []
    return {
        "processSd": selected.get("q"),
        "numericalBestQ": selected.get("numericalBestQ"),
        "qBand": selected.get("qBand") or [],
        "selectionScore": selected.get("selectionScore"),
        "numericalBestScore": selected.get("numericalBestScore"),
        "selectionSe": selected.get("selectionSe"),
        "whyQ": calibration.get("whyQ"),
        "excessSd": selected.get("excessSd"),
        "firmSd": selected.get("firmSd"),
        "houseSd": selected.get("sigmaHouse"),
        "qFast": selected.get("qFast"),
        "whyFast": calibration.get("whyFast"),
        "polls": len(polls),
        "pollsters": len({poll.pollster for poll in polls}),
        "margin": margin,
        "sd": sd,
        "fieldDates": (
            "A multi-day poll is not placed on its midpoint inside the filter. "
            "The update uses the release day, or the last field day if that is later. "
            "Because the random walk has no drift, the expected average of the latent margin over the field dates equals the latent state on that update day. "
            "Disagreement inside the field window is added as process variance. The midpoint is only a chart label."
        ),
        "recency": "The primary model does not multiply polls by an exponential recency weight. The EWMA half-life is a comparison model.",
        "sampleType": (
            "Likely-voter and registered-voter multipliers are weights in the local-linear comparison. "
            "They are not in the primary observation variance. "
            "The historical file does not identify sample type, so no extra registered-voter variance was estimated."
        ),
        "varianceFloor": (
            "The 2-point variance floor is tau in the comparison model's precision weight, 1 / (sampling SE² + tau²). "
            "It is not added to the primary model's observation variance. "
            "The primary non-sampling term is the calibrated excess variance."
        ),
        "pollsterDependence": (
            "Every poll's observation variance includes the firm-shock variance. "
            "A later poll from the same firm within 7 days includes that shock again, once per poll in the window, so the later poll adds less information."
        ),
        "bootstrap": (
            "The primary 50/80/95 intervals are the Gaussian state posterior. They do not depend on bootstrap draws. "
            "Bootstrap draws apply only to the local-linear comparison."
        ),
        "houseEffects": "House effects are normal, centered at zero, and shrunk by the historical prior. They are not a partisan-bias label.",
        "updates": [
            {
                "pollId": row["pollId"],
                "pollster": row["pollster"],
                "margin": row["margin"],
                "innovation": row["innovation"],
                "observationSd": row["observationSd"],
                "gain": row["gain"],
                "before": row["before"],
                "after": row["after"],
                "priorSd": row["priorSd"],
            }
            for row in updates
        ],
        "changes": changes,
        "measurementCount": len(measured),
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
    q_fast = float(selected.get("qFast") or q)
    fast_fit = fit if abs(q_fast - q) < 1e-9 else fit_latent(
        dynamic,
        day0,
        day1,
        q_fast,
        sigma_house=float(selected["sigmaHouse"]),
        firm_variance=float(selected["firmVariance"]),
        dependence_days=7,
        initial_sd=12.0,
    )
    fast = np.asarray(fast_fit["mean"], dtype=float)
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
    changes = _changes(fit, dynamic, day1)
    impact_rows = _decorate_impacts(impacts, fit, measured, float(selected["firmVariance"]))
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
        "impacts": {row["pollId"]: row for row in impact_rows},
        "changes": changes,
        "information": _information(dynamic, day1, 7, 30),
        "emerging": _movement_alert(changes, dynamic, fit.get("updates") or [], day1),
        "uncertainty": _uncertainty(now, now_sd),
        "simulation": simulate_margin(now, now_sd),
        "lab": lab_view(calibration),
        "populationNote": selected.get("populationNote"),
        "day0": day0,
        "qFast": q_fast,
        "audit": _audit(calibration, fit, dynamic, measured, now, now_sd, changes),
    }
