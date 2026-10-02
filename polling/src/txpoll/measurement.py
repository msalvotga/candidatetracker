"""Measurement variance of an Abbott-minus-Hinojosa margin.

A reported margin of error belongs to one candidate share. It is not the
margin of error of the difference. The sampling piece is the multinomial
variance of that difference. Non-sampling pieces are added on top, so a
large sample cannot drive the measurement variance to zero.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .calc import n_eff_from_moe, variance_margin_proportion


@dataclass
class Measurement:
    sampling_variance: float
    excess_variance: float
    method_variance: float
    population_variance: float
    total_variance: float
    sampling_se: float
    total_se: float
    n_eff: float | None
    n_eff_status: str
    sampling_status: str
    moe_status: str
    note: str

    @property
    def R(self) -> float:
        return self.total_variance


def _status_rank(kind: str | None) -> str:
    text = (kind or "").lower()
    if "credibility" in text or "equivalent" in text or "nonprobability" in text or "non-probability" in text:
        return "credibility"
    if "design" in text:
        return "design_effect"
    return "sampling"


def is_nonprobability(moe_kind: str | None, mode: list[str] | None = None) -> bool:
    if _status_rank(moe_kind) == "credibility":
        return True
    joined = " ".join(mode or []).lower()
    if "online" in joined and "live" not in joined and "telephone" not in joined:
        return True
    return False


def measure_margin(
    share_a_pp: float,
    share_b_pp: float,
    sample_size: int | None,
    reported_moe: float | None,
    *,
    effective_sample_size: float | None = None,
    moe_kind: str | None = None,
    sample_type: str | None = None,
    mode: list[str] | None = None,
    z: float = 1.96,
    excess_variance: float = 4.0,
    nonprobability_variance: float = 2.25,
    rv_variance: float = 2.25,
    adults_variance: float = 4.0,
    other_population_variance: float = 4.0,
) -> Measurement:
    """Return R = sampling + excess + method + population, in points squared."""
    p_a = float(share_a_pp) / 100.0
    p_b = float(share_b_pp) / 100.0
    if p_a < 0 or p_b < 0 or p_a + p_b <= 0:
        raise ValueError("Candidate shares are not usable proportions")

    n_eff = None
    n_status = "missing"
    moe_status = "missing"
    sampling_status = "ESTIMATED"
    notes: list[str] = []

    if effective_sample_size and effective_sample_size > 0:
        n_eff = float(effective_sample_size)
        n_status = "REPORTED"
        sampling_status = "DERIVED"
        notes.append("n_eff was reported. Sampling variance of the margin is derived from the shares and that n_eff.")
    elif reported_moe and reported_moe > 0 and _status_rank(moe_kind) != "credibility":
        n_eff = n_eff_from_moe(float(reported_moe), 0.5, z)
        n_status = "ESTIMATED"
        sampling_status = "DERIVED"
        moe_status = "REPORTED"
        notes.append(
            "The reported MOE is treated as the 95% interval of one share near 50%, not as the MOE of the margin. "
            "n_eff is estimated from it, and the margin variance is then derived from the two shares."
        )
    elif sample_size and sample_size > 0:
        n_eff = float(sample_size)
        n_status = "ESTIMATED"
        sampling_status = "ESTIMATED"
        notes.append("No usable probability-sample MOE. n_eff is set equal to N, so the design effect is assumed to be 1.")
    else:
        raise ValueError("No sample size or margin of error")

    sampling_variance = variance_margin_proportion(p_a, p_b, n_eff) * 10000.0
    if reported_moe and reported_moe > 0 and _status_rank(moe_kind) == "credibility":
        moe_status = "REPORTED"
        notes.append(
            "The published figure is a credibility interval or a non-probability equivalent. "
            "It is stored and is not used as a classical margin of error."
        )

    method_variance = nonprobability_variance if is_nonprobability(moe_kind, mode) else 0.0
    if method_variance:
        notes.append("Non-probability or credibility-interval methodology adds method variance.")

    population = sample_type or "Other"
    if population == "LV":
        population_variance = 0.0
    elif population == "RV":
        population_variance = rv_variance
        notes.append("Registered-voter sample adds population variance. It is not dropped and it is not rescaled into a two-way ballot.")
    elif population == "Adults":
        population_variance = adults_variance
    else:
        population_variance = other_population_variance

    total = sampling_variance + excess_variance + method_variance + population_variance
    return Measurement(
        sampling_variance=sampling_variance,
        excess_variance=excess_variance,
        method_variance=method_variance,
        population_variance=population_variance,
        total_variance=total,
        sampling_se=math.sqrt(max(sampling_variance, 0.0)),
        total_se=math.sqrt(max(total, 1e-8)),
        n_eff=n_eff,
        n_eff_status=n_status,
        sampling_status=sampling_status,
        moe_status=moe_status if reported_moe else "missing",
        note=" ".join(notes),
    )
