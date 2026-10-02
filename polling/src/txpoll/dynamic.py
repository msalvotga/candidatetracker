"""Latent daily polling margin.

x_t = x_(t-1) + eta_t, eta ~ Normal(0, q^2).

A poll is a noisy reading of the average latent margin across its field
dates, not a reading of the midpoint alone and not a win probability.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

Z50 = 0.67448975
Z80 = 1.28155157
Z95 = 1.95996398


@dataclass
class DynamicPoll:
    poll_id: int
    pollster: str
    margin: float
    R: float
    field_start: int
    field_end: int
    release: int
    sample_type: str | None = None


def window_gap_variance(n_days: int, q2: float) -> float:
    """Var(average over the field window minus the latent value on the last field day)."""
    if n_days <= 1 or q2 <= 0:
        return 0.0
    length = n_days - 1
    total = 0.0
    for k in range(1, length + 1):
        coefficient = (length - k + 1) / n_days - 1.0
        total += coefficient ** 2
    return q2 * total


def observation_variance(poll: DynamicPoll, state_day: int, q2: float) -> float:
    """Variance of the poll around the latent state on `state_day`.

    The poll averages the field window. Days after the window, and days
    inside it, add process variance. They do not shift the expected value,
    because the random walk has no drift.
    """
    n_days = max(1, poll.field_end - poll.field_start + 1)
    gap_after = max(0, state_day - poll.field_end)
    return poll.R + window_gap_variance(n_days, q2) + q2 * gap_after


def kalman_observation_variance(
    polls: list[DynamicPoll],
    index: int,
    state_day: int,
    q2: float,
    firm_variance: float,
    dependence_days: int,
) -> tuple[float, int]:
    """Variance passed into the Kalman update, and how many same-firm polls share the window.

    Measurement pieces inside poll.R do not include the firm shock. The firm
    shock is added here, in variance units. A later poll from the same firm
    inside the dependence window gets a larger firm term, so three polls from
    one organization move the state less than three polls from three organizations.
    The field window adds process variance. It does not change the expected
    value, because a driftless random walk is a martingale: the expected
    average of x over the field dates, given the state on the update day,
    equals that state.
    """
    poll = polls[index]
    order = 1
    for earlier in polls[:index]:
        if earlier.pollster != poll.pollster:
            continue
        if abs(poll.release - earlier.release) <= dependence_days or abs(poll.field_end - earlier.field_end) <= dependence_days:
            order += 1
    firm_term = firm_variance * order
    gap = observation_variance(poll, state_day, q2) - poll.R
    return poll.R + firm_term + max(gap, 0.0), order


def run_filter(
    polls: list[DynamicPoll],
    day0: int,
    day1: int,
    q: float,
    *,
    initial_mean: float = 0.0,
    initial_sd: float = 12.0,
    firm_variance: float = 0.0,
    dependence_days: int = 7,
    house: dict[str, float] | None = None,
) -> dict[str, np.ndarray]:
    """Forward filter. Observations enter on the release day, or field end if earlier."""
    n = day1 - day0 + 1
    if n <= 0:
        empty = np.array([])
        return {"mean": empty, "var": empty, "pred_var": empty, "filt_var": empty, "updates": []}
    q2 = q ** 2
    mean = np.zeros(n)
    var = np.zeros(n)
    pred_var = np.zeros(n)
    filt_var = np.zeros(n)
    updates: list[dict] = []
    m = float(initial_mean)
    p = float(initial_sd ** 2)
    by_day: dict[int, list[int]] = {}
    for index, poll in enumerate(polls):
        day = max(poll.release, poll.field_end)
        if day < day0:
            day = day0
        if day > day1:
            continue
        by_day.setdefault(day, []).append(index)
    for i, day in enumerate(range(day0, day1 + 1)):
        if i:
            p = p + q2
        pred_var[i] = p
        for index in by_day.get(day, []):
            poll = polls[index]
            house_effect = float((house or {}).get(poll.pollster, 0.0))
            y = poll.margin - house_effect
            r, order = kalman_observation_variance(polls, index, day, q2, firm_variance, dependence_days)
            prior_mean = m
            prior_var = p
            gain = p / (p + r) if (p + r) > 0 else 0.0
            innovation = y - m
            m = m + gain * innovation
            p = (1.0 - gain) * p
            updates.append(
                {
                    "pollId": poll.poll_id,
                    "pollster": poll.pollster,
                    "day": day,
                    "margin": poll.margin,
                    "houseEffect": house_effect,
                    "expected": prior_mean,
                    "innovation": innovation,
                    "observationVariance": r,
                    "observationSd": math.sqrt(max(r, 0.0)),
                    "priorSd": math.sqrt(max(prior_var, 0.0)),
                    "gain": gain,
                    "before": prior_mean,
                    "after": m,
                    "update": m - prior_mean,
                    "firmOrder": order,
                }
            )
        mean[i] = m
        var[i] = p
        filt_var[i] = p
    return {"mean": mean, "var": var, "pred_var": pred_var, "filt_var": filt_var, "day0": day0, "updates": updates}


def smooth(filtered: dict[str, np.ndarray], q: float) -> dict[str, np.ndarray]:
    """RTS smoother. Also returns lag-one multipliers used for change variances."""
    mean = np.asarray(filtered["mean"], dtype=float).copy()
    filt_var = np.asarray(filtered["filt_var"], dtype=float)
    pred_var = np.asarray(filtered["pred_var"], dtype=float)
    n = len(mean)
    if n == 0:
        return {"mean": mean, "var": filt_var, "gain": np.array([])}
    smooth_mean = mean.copy()
    smooth_var = filt_var.copy()
    gain = np.zeros(n)
    for i in range(n - 2, -1, -1):
        if pred_var[i + 1] <= 1e-12:
            continue
        c = filt_var[i] / pred_var[i + 1]
        gain[i] = c
        # Random walk: the one-step prediction equals the previous filtered mean.
        smooth_mean[i] = filtered["mean"][i] + c * (smooth_mean[i + 1] - filtered["mean"][i])
        smooth_var[i] = filt_var[i] + c ** 2 * (smooth_var[i + 1] - pred_var[i + 1])
    return {"mean": smooth_mean, "var": np.maximum(smooth_var, 0.0), "gain": gain}


def change_variance(smooth_var: np.ndarray, gain: np.ndarray, horizon: int) -> float:
    """Posterior variance of x_T - x_(T-h)."""
    n = len(smooth_var)
    if n == 0 or horizon <= 0 or horizon >= n:
        return float("nan")
    end = n - 1
    start = end - horizon
    cov = float(smooth_var[end])
    for t in range(end - 1, start - 1, -1):
        cov *= float(gain[t])
    # cov walked from the end back `horizon` steps is Cov(x_start, x_end)
    # only if each step multiplies by C_t where Cov(x_t, x_{t+1}) = C_t P_{t+1}.
    # Walking P_end * C_{end-1} * C_{end-2} * ... * C_start = Cov(x_start, x_end).
    variance = float(smooth_var[end] + smooth_var[start] - 2.0 * cov)
    return max(variance, 0.0)


def gaussian_interval(mean: float, sd: float, z: float) -> tuple[float, float]:
    return mean - z * sd, mean + z * sd


def ewma_path(polls: list[DynamicPoll], day0: int, day1: int, half_life: float) -> np.ndarray:
    """Comparison only. A poll enters on its release day and then decays."""
    n = day1 - day0 + 1
    path = np.full(n, np.nan)
    if half_life <= 0 or n <= 0:
        return path
    log_decay = math.log(0.5) / half_life
    weighted = 0.0
    weight = 0.0
    by_day: dict[int, list[DynamicPoll]] = {}
    for poll in polls:
        by_day.setdefault(max(poll.release, poll.field_end), []).append(poll)
    for i, day in enumerate(range(day0, day1 + 1)):
        if i:
            decay = math.exp(log_decay)
            weighted *= decay
            weight *= decay
        for poll in by_day.get(day, []):
            precision = 1.0 / poll.R if poll.R > 0 else 0.0
            weighted += precision * poll.margin
            weight += precision
        if weight > 0:
            path[i] = weighted / weight
    return path


def local_linear_fast(polls: list[DynamicPoll], day0: int, day1: int, bandwidth: float) -> np.ndarray:
    """Fast diagnostic. Local line on field midpoints, precision 1/R, no recency multiplier."""
    from .calc import local_linear_at

    n = day1 - day0 + 1
    if not polls or n <= 0:
        return np.full(n, np.nan)
    x = np.array([(p.field_start + p.field_end) / 2.0 for p in polls], dtype=float)
    y = np.array([p.margin for p in polls], dtype=float)
    w = np.array([1.0 / p.R if p.R > 0 else 0.0 for p in polls], dtype=float)
    grid = np.arange(day0, day1 + 1, dtype=float)
    fitted = np.array([local_linear_at(x, y, w, float(g), bandwidth) for g in grid])
    last = float(np.max(x))
    held = local_linear_at(x, y, w, last, bandwidth)
    return np.where(grid > last + 1e-6, held, fitted)


def straight_average_path(polls: list[DynamicPoll], day0: int, day1: int) -> np.ndarray:
    """Equal-weight mean of polls released by that day. No precision or decay."""
    n = day1 - day0 + 1
    path = np.full(n, np.nan)
    ordered = sorted(polls, key=lambda poll: max(poll.release, poll.field_end))
    total = 0.0
    count = 0
    cursor = 0
    for i, day in enumerate(range(day0, day1 + 1)):
        while cursor < len(ordered) and max(ordered[cursor].release, ordered[cursor].field_end) <= day:
            total += ordered[cursor].margin
            count += 1
            cursor += 1
        if count:
            path[i] = total / count
    return path


def house_effects_hierarchical(
    polls: list[DynamicPoll],
    latent_on_release: list[float],
    sigma_house: float,
) -> dict[str, dict[str, float | int | None]]:
    """Partial pooling. Few polls stay near zero. This is not a bias label."""
    buckets: dict[str, list[tuple[float, float]]] = {}
    for poll, fitted in zip(polls, latent_on_release):
        if fitted is None or not math.isfinite(fitted):
            continue
        buckets.setdefault(poll.pollster, []).append((poll.margin - fitted, poll.R))
    prior = sigma_house ** 2
    out: dict[str, dict[str, float | int | None]] = {}
    for name, rows in buckets.items():
        precision = 0.0 if prior <= 0 else 1.0 / prior
        weighted = 0.0
        for residual, variance in rows:
            info = 1.0 / variance if variance > 0 else 0.0
            precision += info
            weighted += info * residual
        estimate = weighted / precision if precision else 0.0
        sd = math.sqrt(1.0 / precision) if precision else None
        data_precision = precision - (0.0 if prior <= 0 else 1.0 / prior)
        out[name] = {
            "polls": len(rows),
            "estimate": estimate,
            "se": sd,
            "shrinkage": (data_precision / precision) if precision else None,
        }
    return out


def fit_latent(
    polls: list[DynamicPoll],
    day0: int,
    day1: int,
    q: float,
    *,
    sigma_house: float = 2.0,
    firm_variance: float = 4.0,
    dependence_days: int = 7,
    initial_sd: float = 12.0,
) -> dict:
    """Two-pass fit. House effects are shrunk, then the filter is run again."""
    first = run_filter(
        polls, day0, day1, q, initial_sd=initial_sd, firm_variance=firm_variance, dependence_days=dependence_days
    )
    smoothed = smooth(first, q)
    fitted = []
    for poll in polls:
        day = min(max(max(poll.release, poll.field_end), day0), day1)
        fitted.append(float(smoothed["mean"][day - day0]))
    effects = house_effects_hierarchical(polls, fitted, sigma_house)
    house = {name: float(row["estimate"] or 0.0) for name, row in effects.items()}
    # A one-poll house effect is already shrunk by the prior. Keep it in the
    # second pass; the prior stops it from equaling that one residual.
    second = run_filter(
        polls,
        day0,
        day1,
        q,
        initial_sd=initial_sd,
        firm_variance=firm_variance,
        dependence_days=dependence_days,
        house=house,
    )
    final = smooth(second, q)
    # Add the posterior uncertainty of each pollster's house effect into today's variance
    # only as a display note. The second-pass observations were shifted by the point
    # estimate; remaining house uncertainty is approximately the prior for unseen firms
    # and the posterior sd for firms in the data. Use the mean posterior variance of
    # firms that contributed, weighted equally, as a small addition if any firms exist.
    extra = 0.0
    if effects:
        ses = [float(row["se"]) ** 2 for row in effects.values() if row["se"] is not None]
        if ses:
            extra = float(np.mean(ses)) / max(len(effects), 1)
    final_var = np.maximum(final["var"] + extra, 0.0)
    field_average: dict[int, float] = {}
    for poll in polls:
        indexes = [day - day0 for day in range(poll.field_start, poll.field_end + 1) if day0 <= day <= day1]
        if not indexes:
            continue
        field_average[poll.poll_id] = float(np.mean(final["mean"][indexes]))
    return {
        "filtered": second,
        "mean": final["mean"],
        "var": final_var,
        "gain": final["gain"],
        "house": effects,
        "updates": second.get("updates") or [],
        "fieldAverage": field_average,
        "day0": day0,
        "day1": day1,
    }


def leave_one_out_impacts(
    polls: list[DynamicPoll],
    day0: int,
    day1: int,
    q: float,
    **kwargs,
) -> list[dict]:
    """How much today's latent mean moves when each poll is removed."""
    full = fit_latent(polls, day0, day1, q, **kwargs)
    today = float(full["mean"][-1]) if len(full["mean"]) else float("nan")
    rows = []
    for poll in polls:
        kept = [item for item in polls if item.poll_id != poll.poll_id]
        if not kept:
            after = float("nan")
        else:
            alt = fit_latent(kept, day0, day1, q, **kwargs)
            after = float(alt["mean"][-1]) if len(alt["mean"]) else float("nan")
        rows.append(
            {
                "pollId": poll.poll_id,
                "pollster": poll.pollster,
                "margin": poll.margin,
                "measurementSe": math.sqrt(poll.R),
                "withPoll": today,
                "withoutPoll": after,
                "impact": today - after if math.isfinite(today) and math.isfinite(after) else None,
            }
        )
    return rows
