"""Choose process noise and the EWMA half-life from older elections.

The objective is the average 14-day future-poll RMSE across historical
gubernatorial general elections. The 2026 Texas governor race is not in
the calibration file and is not part of the objective.

Source: FiveThirtyEight pollster-ratings raw polls, Gov-G rows.
https://raw.githubusercontent.com/fivethirtyeight/data/master/pollster-ratings/raw_polls.csv
That file publishes one date per poll, so each historical poll is a
one-day field window. The live model still uses the full field period.
"""

from __future__ import annotations

import json
import math
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from .config import DATA_DIR
from .dynamic import DynamicPoll, ewma_path, run_filter
from .measurement import measure_margin

RAW_URL = "https://raw.githubusercontent.com/fivethirtyeight/data/master/pollster-ratings/raw_polls.csv"
RAW_PATH = DATA_DIR / "historical" / "raw_polls.csv"
RESULT_PATH = DATA_DIR / "historical" / "calibration.json"

Q_GRID = (0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.50, 0.60, 0.70, 0.85, 1.00)
EXCESS_SD = (0.25, 0.50, 1.0, 1.5, 2.0, 2.5, 3.5)
HOUSE_SD = (1.0, 2.0, 3.0)
FIRM_SD = (1.0, 2.0)
SELECTION_DRAWS = 5000
SELECTION_SEED = 2026
HALF_LIVES = (7, 10, 14, 21, 28, 35, 42)


def _ordinal(value: str) -> int:
    return datetime.strptime(str(value)[:10], "%Y-%m-%d").date().toordinal()


def load_governor_races(path: Path = RAW_PATH) -> list[dict]:
    frame = pd.read_csv(path, low_memory=False)
    frame = frame[frame["type_simple"] == "Gov-G"].copy()
    races = []
    for race_id, group in frame.groupby("race_id"):
        polls = []
        election = None
        location = str(group["location"].iloc[0])
        cycle = int(group["cycle"].iloc[0])
        for row in group.itertuples(index=False):
            if str(row.cand1_party) == "REP" and str(row.cand2_party) == "DEM":
                margin = float(row.cand1_pct) - float(row.cand2_pct)
                p_a, p_b = float(row.cand1_pct), float(row.cand2_pct)
            elif str(row.cand1_party) == "DEM" and str(row.cand2_party) == "REP":
                margin = float(row.cand2_pct) - float(row.cand1_pct)
                p_a, p_b = float(row.cand2_pct), float(row.cand1_pct)
            else:
                continue
            if not math.isfinite(margin):
                continue
            sample = row.samplesize
            sample_n = int(sample) if pd.notna(sample) and float(sample) >= 50 else None
            if sample_n is None:
                continue
            day = _ordinal(row.polldate)
            election = _ordinal(row.electiondate)
            method = "" if pd.isna(row.methodology) else str(row.methodology)
            nonprob = "online" in method.lower() and "live" not in method.lower()
            measured = measure_margin(
                p_a,
                p_b,
                sample_n,
                None,
                sample_type="LV",
                excess_variance=0.0,
                nonprobability_variance=0.0,
                rv_variance=0.0,
            )
            polls.append(
                {
                    "pollster": str(row.pollster),
                    "day": day,
                    "margin": margin,
                    "sampling_variance": measured.sampling_variance,
                    "method_variance": 0.0,
                    "nonprob": nonprob,
                }
            )
        if election is None or len(polls) < 8:
            continue
        polls.sort(key=lambda item: item["day"])
        races.append(
            {
                "id": f"{location}-{cycle}-gov",
                "race_id": int(race_id),
                "cycle": cycle,
                "election": election,
                "polls": polls,
            }
        )
    return races


def _as_polls(rows: list[dict], excess: float) -> list[DynamicPoll]:
    out = []
    for index, row in enumerate(rows):
        out.append(
            DynamicPoll(
                poll_id=index,
                pollster=row["pollster"],
                margin=row["margin"],
                R=row["sampling_variance"] + row["method_variance"] + excess,
                field_start=row["day"],
                field_end=row["day"],
                release=row["day"],
            )
        )
    return out


def _consensus(window: list[DynamicPoll], firm_variance: float) -> float | None:
    """Inverse-variance mean that does not treat repeated polls from one firm as independent."""
    groups: dict[str, list[DynamicPoll]] = {}
    for poll in window:
        groups.setdefault(poll.pollster, []).append(poll)
    total = 0.0
    weight = 0.0
    for group in groups.values():
        precision = sum(1.0 / poll.R for poll in group if poll.R > 0)
        if precision <= 0:
            continue
        mean = sum((poll.margin / poll.R) for poll in group if poll.R > 0) / precision
        variance = firm_variance + 1.0 / precision
        info = 1.0 / variance if variance > 0 else 0.0
        total += info * mean
        weight += info
    if weight <= 0:
        return None
    return total / weight


def _race_errors(race: dict, q: float, excess: float, firm_variance: float) -> dict[str, list[float]]:
    polls = _as_polls(race["polls"], excess)
    election = race["election"]
    errors = {7: [], 14: [], 28: []}
    consensus_errors = {"7to14": [], "14to28": []}
    coverage = {50: [], 80: [], 95: []}
    residuals = []
    loglik = []
    for days_before in (90, 60, 40, 28):
        checkpoint = election - days_before
        known = [poll for poll in polls if poll.release <= checkpoint]
        if len(known) < 3:
            continue
        day0 = min(poll.field_start for poll in known)
        fitted = run_filter(known, day0, checkpoint, q, firm_variance=firm_variance, initial_sd=12.0)
        if len(fitted["mean"]) == 0:
            continue
        now = float(fitted["mean"][-1])
        now_var = float(fitted["var"][-1])
        future = [poll for poll in polls if checkpoint < poll.release <= checkpoint + 28 and poll.release <= election]
        if not future:
            continue
        previous = None
        for horizon in (7, 14, 28):
            window = [poll for poll in future if poll.release <= checkpoint + horizon]
            if not window:
                continue
            gap = float(np.mean([poll.release - checkpoint for poll in window]))
            pred_var = now_var + (q ** 2) * gap
            for poll in window:
                error = poll.margin - now
                errors[horizon].append(error)
                if horizon == 14:
                    scale = math.sqrt(max(pred_var + poll.R + firm_variance, 1e-8))
                    coverage[50].append(1.0 if abs(error) <= 0.67448975 * scale else 0.0)
                    coverage[80].append(1.0 if abs(error) <= 1.28155157 * scale else 0.0)
                    coverage[95].append(1.0 if abs(error) <= 1.95996398 * scale else 0.0)
                    variance = scale ** 2
                    loglik.append(-0.5 * (math.log(2.0 * math.pi * variance) + (error ** 2) / variance))
                    if previous is not None:
                        residuals.append((previous, error))
                    previous = error
        for key, start, end in (("7to14", 7, 14), ("14to28", 14, 28)):
            window = [poll for poll in future if checkpoint + start < poll.release <= checkpoint + end]
            target = _consensus(window, firm_variance)
            if target is not None:
                consensus_errors[key].append(target - now)
    selection_parts = consensus_errors["7to14"] + consensus_errors["14to28"]
    selection = _rmse(selection_parts) if selection_parts else _rmse(errors[14])
    return {
        "errors": errors,
        "consensus": consensus_errors,
        "coverage": coverage,
        "pairs": residuals,
        "loglik": loglik,
        "raceRmse14": _rmse(errors[14]),
        "selection": selection,
        "cycle": race["cycle"],
        "id": race["id"],
    }


def _rmse(values: list[float]) -> float | None:
    if not values:
        return None
    return float(np.sqrt(np.mean(np.square(values))))


def _mae(values: list[float]) -> float | None:
    if not values:
        return None
    return float(np.mean(np.abs(values)))


def _autocorr(pairs: list[tuple[float, float]]) -> float | None:
    if len(pairs) < 8:
        return None
    left = np.array([a for a, _b in pairs], dtype=float)
    right = np.array([b for _a, b in pairs], dtype=float)
    if float(left.std()) == 0 or float(right.std()) == 0:
        return None
    return float(np.corrcoef(left, right)[0, 1])


def score_state_space(races: list[dict], q: float, excess_sd: float, firm_sd: float) -> dict:
    excess = excess_sd ** 2
    firm = firm_sd ** 2
    pooled = {7: [], 14: [], 28: []}
    by_race_14 = []
    selection_scores = []
    coverage = {50: [], 80: [], 95: []}
    pairs = []
    race_scores = []
    loglik = []
    consensus = {"7to14": [], "14to28": []}
    for race in races:
        result = _race_errors(race, q, excess, firm)
        for horizon, values in result["errors"].items():
            pooled[horizon].extend(values)
        for key, values in result["consensus"].items():
            consensus[key].extend(values)
        if result["raceRmse14"] is not None:
            by_race_14.append(result["raceRmse14"])
        if result["selection"] is not None:
            selection_scores.append(result["selection"])
            race_scores.append({"id": result["id"], "cycle": result["cycle"], "rmse": result["selection"]})
        for level, values in result["coverage"].items():
            coverage[level].extend(values)
        pairs.extend(result["pairs"])
        loglik.extend(result["loglik"])
    return {
        "q": q,
        "excessSd": excess_sd,
        "firmSd": firm_sd,
        "rmse7": _rmse(pooled[7]),
        "rmse14": _rmse(pooled[14]),
        "rmse28": _rmse(pooled[28]),
        "mae14": _mae(pooled[14]),
        "consensus7to14": _rmse(consensus["7to14"]),
        "consensus14to28": _rmse(consensus["14to28"]),
        "raceRmse14": float(np.mean(by_race_14)) if by_race_14 else None,
        "selectionScore": float(np.mean(selection_scores)) if selection_scores else None,
        "coverage50": float(np.mean(coverage[50])) if coverage[50] else None,
        "coverage80": float(np.mean(coverage[80])) if coverage[80] else None,
        "coverage95": float(np.mean(coverage[95])) if coverage[95] else None,
        "logLik14": float(np.mean(loglik)) if loglik else None,
        "residualAutocorr": _autocorr(pairs),
        "races": len(selection_scores),
        "raceScores": race_scores,
    }


def score_ewma(races: list[dict], half_life: float, excess_sd: float) -> dict:
    excess = excess_sd ** 2
    pooled = {7: [], 14: [], 28: []}
    by_race = []
    race_scores = []
    for race in races:
        polls = _as_polls(race["polls"], excess)
        election = race["election"]
        race_errors = []
        for days_before in (90, 60, 40, 28):
            checkpoint = election - days_before
            known = [poll for poll in polls if poll.release <= checkpoint]
            if len(known) < 3:
                continue
            day0 = min(poll.release for poll in known)
            path = ewma_path(known, day0, checkpoint, half_life)
            if len(path) == 0 or not math.isfinite(float(path[-1])):
                continue
            now = float(path[-1])
            for horizon in (7, 14, 28):
                window = [poll for poll in polls if checkpoint < poll.release <= checkpoint + horizon and poll.release <= election]
                for poll in window:
                    pooled[horizon].append(poll.margin - now)
                    if horizon == 14:
                        race_errors.append(poll.margin - now)
        if race_errors:
            rmse = _rmse(race_errors)
            by_race.append(rmse)
            race_scores.append({"cycle": race["cycle"], "rmse": rmse})
    return {
        "halfLife": half_life,
        "rmse7": _rmse(pooled[7]),
        "rmse14": _rmse(pooled[14]),
        "rmse28": _rmse(pooled[28]),
        "mae14": _mae(pooled[14]),
        "raceRmse14": float(np.mean(by_race)) if by_race else None,
        "races": len(by_race),
        "raceScores": race_scores,
    }


def _leave_one_cycle(table: list[dict], value_keys: tuple[str, ...]) -> list[dict]:
    """Pick the best row on every cycle except one. One election cannot set the default."""
    cycles = sorted({score["cycle"] for row in table for score in row.get("raceScores", [])})
    chosen = []
    for cycle in cycles:
        best = None
        best_mean = None
        for row in table:
            values = [score["rmse"] for score in row.get("raceScores", []) if score["cycle"] != cycle and score["rmse"] is not None]
            if len(values) < 5:
                continue
            mean = float(np.mean(values))
            if best_mean is None or mean < best_mean:
                best_mean = mean
                best = row
        if best is None:
            continue
        chosen.append({"heldOutCycle": cycle, "raceRmse14": best_mean, **{key: best[key] for key in value_keys}})
    return chosen


def _strip_scores(rows: list[dict]) -> list[dict]:
    return [{key: value for key, value in row.items() if key != "raceScores"} for row in rows]


def _estimate_house_sd(races: list[dict], q: float, excess: float, firm_variance: float) -> float:
    """Between-pollster SD of mean residuals. Pollsters with one poll are left out."""
    means = []
    for race in races:
        polls = [poll for poll in _as_polls(race["polls"], excess) if poll.release <= race["election"]]
        if len(polls) < 4:
            continue
        day0 = min(poll.release for poll in polls)
        day1 = max(poll.release for poll in polls)
        fitted = run_filter(polls, day0, day1, q, firm_variance=firm_variance, initial_sd=12.0)
        buckets: dict[str, list[float]] = {}
        for poll in polls:
            index = poll.release - day0
            if index < 0 or index >= len(fitted["mean"]):
                continue
            buckets.setdefault(poll.pollster, []).append(poll.margin - float(fitted["mean"][index]))
        for values in buckets.values():
            if len(values) >= 2:
                means.append(float(np.mean(values)))
    if len(means) < 8:
        return 2.0
    sd = float(np.std(means, ddof=1))
    return float(min(max(sd, 0.5), 6.0))


def _estimate_method_variance(races: list[dict], q: float, excess: float, firm_variance: float) -> float:
    """Extra variance of online polls beyond live-phone polls, after the shared excess term."""
    live = []
    online = []
    for race in races:
        rows = [row for row in race["polls"] if row["day"] <= race["election"]]
        polls = _as_polls(rows, excess)
        if len(polls) < 4:
            continue
        day0 = min(poll.release for poll in polls)
        day1 = max(poll.release for poll in polls)
        fitted = run_filter(polls, day0, day1, q, firm_variance=firm_variance, initial_sd=12.0)
        for row, poll in zip(rows, polls):
            index = poll.release - day0
            if index < 0 or index >= len(fitted["mean"]):
                continue
            error = poll.margin - float(fitted["mean"][index])
            (online if row["nonprob"] else live).append(error ** 2)
    if len(live) < 30 or len(online) < 30:
        return 0.0
    gap = float(np.mean(online) - np.mean(live))
    return float(max(0.0, min(gap, 16.0)))


def _comparison_scores(races: list[dict], excess_sd: float) -> list[dict]:
    from .calc import local_linear_at

    excess = excess_sd ** 2
    specs = {
        "simpleAverage": {7: [], 14: [], 28: []},
        "localRegression": {7: [], 14: [], 28: []},
    }
    for race in races:
        polls = _as_polls(race["polls"], excess)
        election = race["election"]
        for days_before in (90, 60, 40, 28):
            checkpoint = election - days_before
            known = [poll for poll in polls if poll.release <= checkpoint]
            if len(known) < 3:
                continue
            simple = float(np.mean([poll.margin for poll in known]))
            x = np.array([poll.release for poll in known], dtype=float)
            y = np.array([poll.margin for poll in known], dtype=float)
            w = np.array([1.0 / poll.R for poll in known], dtype=float)
            # Score the level at the newest poll, not a slope projected across empty days.
            local = float(local_linear_at(x, y, w, float(np.max(x)), 14.0))
            future = {
                horizon: [poll for poll in polls if checkpoint < poll.release <= checkpoint + horizon and poll.release <= election]
                for horizon in (7, 14, 28)
            }
            for horizon, window in future.items():
                for poll in window:
                    specs["simpleAverage"][horizon].append(poll.margin - simple)
                    if math.isfinite(local):
                        specs["localRegression"][horizon].append(poll.margin - local)
    rows = []
    for name, pooled in specs.items():
        rows.append(
            {
                "model": name,
                "rmse7": _rmse(pooled[7]),
                "rmse14": _rmse(pooled[14]),
                "rmse28": _rmse(pooled[28]),
                "mae14": _mae(pooled[14]),
            }
        )
    return rows


def _bootstrap_se(values: list[float]) -> float | None:
    if len(values) < 8:
        return None
    rng = np.random.default_rng(SELECTION_SEED)
    array = np.asarray(values, dtype=float)
    n = len(array)
    draws = np.empty(SELECTION_DRAWS)
    for i in range(SELECTION_DRAWS):
        draws[i] = float(array[rng.integers(0, n, n)].mean())
    return float(draws.std(ddof=1))


def _select_q(table: list[dict]) -> dict:
    """Numerical minimum, then the smoothest q inside a one-standard-error band."""
    ranked = [row for row in table if row.get("selectionScore") is not None]
    ranked.sort(key=lambda row: (row["selectionScore"], row["q"]))
    best = ranked[0]
    se = _bootstrap_se([item["rmse"] for item in best.get("raceScores", [])])
    cutoff = best["selectionScore"] if se is None else best["selectionScore"] + se
    same = [
        row
        for row in ranked
        if row["excessSd"] == best["excessSd"] and row["firmSd"] == best["firmSd"] and row["selectionScore"] <= cutoff + 1e-12
    ]
    chosen = min(same, key=lambda row: row["q"])
    higher = [
        row
        for row in ranked
        if row["excessSd"] == chosen["excessSd"]
        and row["firmSd"] == chosen["firmSd"]
        and row["q"] > chosen["q"] + 1e-9
        and row.get("consensus7to14") is not None
    ]
    fast = None
    fast_band: list[float] = []
    if higher:
        higher.sort(key=lambda row: (row["consensus7to14"], row["q"]))
        fast_best = higher[0]
        fast_cutoff = fast_best["consensus7to14"] if se is None else fast_best["consensus7to14"] + se
        fast_band_rows = [row for row in higher if row["consensus7to14"] <= fast_cutoff + 1e-12]
        fast = min(fast_band_rows, key=lambda row: row["q"])
        fast_band = sorted(row["q"] for row in fast_band_rows)
    return {
        "numericalBest": best,
        "scoreSe": se,
        "cutoff": cutoff,
        "band": sorted(row["q"] for row in same),
        "chosen": chosen,
        "fast": fast,
        "fastBand": fast_band,
    }


def _leave_one_race_q(table: list[dict]) -> dict[str, int]:
    ids = sorted({score["id"] for row in table for score in row.get("raceScores", []) if "id" in score})
    counts: dict[str, int] = {}
    for held in ids:
        scored = []
        for row in table:
            values = [score["rmse"] for score in row["raceScores"] if score.get("id") != held]
            if len(values) < 8:
                continue
            scored.append((float(np.mean(values)), float(np.std(values, ddof=1) / math.sqrt(len(values))), row))
        if not scored:
            continue
        scored.sort(key=lambda item: item[0])
        best_mean, se, best_row = scored[0]
        band = [
            row
            for mean, _se, row in scored
            if row["excessSd"] == best_row["excessSd"] and row["firmSd"] == best_row["firmSd"] and mean <= best_mean + se + 1e-12
        ]
        pick = min(band, key=lambda row: row["q"])
        key = f"{pick['q']}"
        counts[key] = counts.get(key, 0) + 1
    return counts


def run_calibration(path: Path = RAW_PATH) -> dict:
    races = load_governor_races(path)
    cycles = sorted({race["cycle"] for race in races})
    state_rows = []
    for q in Q_GRID:
        for excess_sd in EXCESS_SD:
            for firm_sd in FIRM_SD:
                # House-effect scale is applied in the live two-pass fit.
                # The search scores the filter with firm-level dependence and excess variance.
                state_rows.append(score_state_space(races, q, excess_sd, firm_sd))
    state_rows.sort(key=lambda row: (row["selectionScore"] is None, row["selectionScore"] or 1e9, row["q"]))
    choice = _select_q(state_rows)
    best = choice["numericalBest"]
    chosen = choice["chosen"]
    fast_row = choice["fast"]
    race_q_counts = _leave_one_race_q(state_rows)
    cycle_choices = _leave_one_cycle(state_rows, ("q", "excessSd", "firmSd"))
    q_votes = sorted({row["q"] for row in cycle_choices})
    house_sd = _estimate_house_sd(races, chosen["q"], chosen["excessSd"] ** 2, chosen["firmSd"] ** 2)
    method_variance = _estimate_method_variance(races, chosen["q"], chosen["excessSd"] ** 2, chosen["firmSd"] ** 2)
    ewma_rows = [score_ewma(races, half_life, chosen["excessSd"]) for half_life in HALF_LIVES]
    ewma_cycle = _leave_one_cycle(ewma_rows, ("halfLife",))
    ewma_rows.sort(key=lambda row: (row["raceRmse14"] is None, row["raceRmse14"] or 1e9))
    best_ewma = ewma_rows[0]
    comparisons = _comparison_scores(races, chosen["excessSd"])
    payload = {
        "source": "FiveThirtyEight pollster-ratings raw_polls.csv, type_simple Gov-G",
        "url": RAW_URL,
        "generatedFromRaces": len(races),
        "cycles": cycles,
        "excludedFromObjective": "The 2026 Texas gubernatorial polls are not in this file and were not used to choose q or the EWMA half-life.",
        "objective": (
            "For each historical race, RMSE against the measurement-weighted consensus of independent pollsters "
            "in the windows 7–14 and 14–28 days after each checkpoint. "
            "Individual future-poll RMSE, MAE, log likelihood, residual autocorrelation, and 50/80/95 coverage are reported beside that score. "
            "Checkpoints are 90, 60, 40, and 28 days before election day. "
            "When several daily process SDs are within one bootstrap standard error of the best score, the smallest process SD is used."
        ),
        "dateLimitation": "This file has one date per poll. Calibration treats that date as a one-day field window. The live Texas model averages the latent margin across the stored field dates.",
        "selected": {
            "q": chosen["q"],
            "numericalBestQ": best["q"],
            "qBand": choice["band"],
            "selectionScore": chosen["selectionScore"],
            "numericalBestScore": best["selectionScore"],
            "selectionSe": choice["scoreSe"],
            "qFast": None if fast_row is None else fast_row["q"],
            "qFastBand": choice["fastBand"],
            "excessSd": chosen["excessSd"],
            "excessVariance": chosen["excessSd"] ** 2,
            "firmSd": chosen["firmSd"],
            "firmVariance": chosen["firmSd"] ** 2,
            "sigmaHouse": house_sd,
            "ewmaHalfLife": best_ewma["halfLife"],
            "nonprobabilityVariance": method_variance,
            "rvVariance": 0.0,
            "adultsVariance": 0.0,
            "populationNote": (
                "The historical file does not label likely-voter versus registered-voter samples. "
                "No separate population variance was estimated. Registered-voter polls still enter the live model, "
                "and the shared excess variance is the non-sampling term."
            ),
        },
        "whyQ": (
            f"The lowest future-consensus score was daily process SD {best['q']} "
            f"(excess SD {best['excessSd']}, firm-shock SD {best['firmSd']}, score {best['selectionScore']:.2f}). "
            f"A {SELECTION_DRAWS}-draw bootstrap of races put the standard error of that score at "
            f"{choice['scoreSe'] if choice['scoreSe'] is not None else float('nan'):.2f}. "
            f"Process SDs inside that band, at the same excess and firm values, were {choice['band']}. "
            f"The one-standard-error rule selects the smoothest of them, {chosen['q']}. "
            f"Leave-one-cycle numerical minima were {q_votes}. "
            "The 2026 Texas race was not in the objective."
        ),
        "whyFast": (
            None
            if fast_row is None
            else (
                f"Fast latent process SD {fast_row['q']} is the smoothest value above the primary SD "
                f"whose 7-to-14-day consensus RMSE ({fast_row['consensus7to14']:.2f}) is within one standard error "
                f"of the best faster candidate. The band was {choice['fastBand']}."
            )
        ),
        "whyHalfLife": (
            f"EWMA half-life {int(best_ewma['halfLife'])} days had the lowest average 14-day future-poll RMSE "
            f"({best_ewma['raceRmse14']:.2f} points) among 7, 10, 14, 21, 28, 35, and 42. "
            "The primary model does not use this half-life. Older polls lose influence because process noise accumulates."
        ),
        "whyHouse": (
            f"The house-effect prior SD is {house_sd:.2f} points, the between-pollster standard deviation of mean residuals "
            "for pollsters with at least two polls in a race. A pollster with one poll is shrunk toward zero. "
            "This is not a partisan-bias label."
        ),
        "stateSpace": _strip_scores(state_rows),
        "ewma": _strip_scores(ewma_rows),
        "comparisons": comparisons,
        "leaveOneCycle": cycle_choices,
        "leaveOneRaceQ": race_q_counts,
        "leaveOneCycleEwma": ewma_cycle,
    }
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def load_calibration() -> dict:
    if not RESULT_PATH.exists():
        raise FileNotFoundError(
            "Historical calibration has not been run. From polling/, run python -m txpoll.calibrate"
        )
    return json.loads(RESULT_PATH.read_text(encoding="utf-8"))


if __name__ == "__main__":
    result = run_calibration()
    print(result["whyQ"])
    print(result["whyHalfLife"])
