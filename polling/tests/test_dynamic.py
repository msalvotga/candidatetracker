"""Measurement variance, field windows, and pollster dependence."""

from __future__ import annotations

import math
import unittest

import numpy as np

from txpoll.dynamic import (
    DynamicPoll,
    change_variance,
    fit_latent,
    kalman_observation_variance,
    run_filter,
    smooth,
    window_gap_variance,
)
from txpoll.measurement import measure_margin


class MeasurementTests(unittest.TestCase):
    def test_margin_variance_is_not_the_reported_moe(self):
        measured = measure_margin(48, 44, 1000, 3.0, moe_kind="sampling_error", sample_type="LV", excess_variance=0)
        reported_se = 3.0 / 1.96
        self.assertGreater(abs(measured.sampling_se - reported_se), 0.2)
        self.assertEqual(measured.sampling_status, "DERIVED")
        self.assertEqual(measured.n_eff_status, "ESTIMATED")
        self.assertEqual(measured.moe_status, "REPORTED")

    def test_credibility_interval_is_not_a_classical_moe(self):
        classical = measure_margin(48, 44, 1000, 3.0, moe_kind="sampling_error", sample_type="LV", excess_variance=1, nonprobability_variance=4)
        credibility = measure_margin(
            48, 44, 1000, 3.0, moe_kind="credibility_interval", sample_type="LV", excess_variance=1, nonprobability_variance=4
        )
        self.assertIn("not used as a classical", credibility.note)
        self.assertEqual(credibility.moe_status, "REPORTED")
        self.assertGreater(credibility.method_variance, 0)
        self.assertGreater(credibility.total_variance, classical.total_variance)

    def test_excess_variance_stops_a_huge_sample_from_dominating(self):
        huge = measure_margin(50, 50, 100000, None, sample_type="LV", excess_variance=0.25)
        ordinary = measure_margin(50, 50, 800, 3.5, moe_kind="sampling_error", sample_type="LV", excess_variance=0.25)
        self.assertGreater(huge.total_variance, huge.sampling_variance)
        precision_ratio = ordinary.total_variance / huge.total_variance
        sample_ratio = 100000 / 800
        self.assertLess(precision_ratio, sample_ratio)

    def test_low_moe_has_smaller_variance_than_high_moe(self):
        low = measure_margin(50, 46, 1200, 2.5, moe_kind="sampling_error", sample_type="LV", excess_variance=0.25)
        high = measure_margin(50, 46, 400, 6.0, moe_kind="sampling_error", sample_type="LV", excess_variance=0.25)
        self.assertLess(low.total_variance, high.total_variance)


class DynamicTests(unittest.TestCase):
    def test_field_window_adds_variance(self):
        self.assertGreater(window_gap_variance(7, 0.25), 0)
        self.assertEqual(window_gap_variance(1, 0.25), 0)

    def test_change_variance_of_an_unobserved_random_walk(self):
        filtered = run_filter([], 0, 40, q=0.2, initial_sd=0.0)
        smoothed = smooth(filtered, 0.2)
        variance = change_variance(smoothed["var"], smoothed["gain"], 10)
        self.assertAlmostEqual(variance, 10 * 0.04, places=6)

    def test_a_later_poll_from_the_same_firm_has_a_larger_observation_variance(self):
        polls = [DynamicPoll(i, "A", 4.0, 9.0, 10 + i, 10 + i, 10 + i) for i in range(3)]
        first, first_order = kalman_observation_variance(polls, 0, 10, 0.04, 4.0, 7)
        third, third_order = kalman_observation_variance(polls, 2, 12, 0.04, 4.0, 7)
        self.assertEqual(first_order, 1)
        self.assertEqual(third_order, 3)
        self.assertGreater(third, first)
        self.assertAlmostEqual(first, 9.0 + 4.0)

    def test_three_independent_pollsters_move_the_state_more_than_one_firm(self):
        def polls(names):
            return [
                DynamicPoll(i, name, 8.0, 4.0, 10 + i, 10 + i, 10 + i)
                for i, name in enumerate(names)
            ]

        one = fit_latent(polls(["A", "A", "A"]), 0, 20, q=0.2, sigma_house=0.01, firm_variance=9.0, initial_sd=8)
        three = fit_latent(polls(["A", "B", "C"]), 0, 20, q=0.2, sigma_house=0.01, firm_variance=9.0, initial_sd=8)
        self.assertGreater(float(one["var"][-1]), float(three["var"][-1]))
        self.assertGreater(abs(float(three["mean"][-1])), abs(float(one["mean"][-1])) * 0.5)

    def test_precise_polls_can_move_the_state_without_a_daily_cap(self):
        polls = [DynamicPoll(i, f"P{i}", 12.0, 0.5, 5 + 3 * i, 5 + 3 * i, 5 + 3 * i) for i in range(6)]
        fit = fit_latent(polls, 0, 30, q=0.4, sigma_house=1.0, firm_variance=0.0, initial_sd=8)
        self.assertGreater(float(fit["mean"][-1]), 6.0)

    def test_gaussian_interval_is_not_clipped_to_the_polls(self):
        polls = [DynamicPoll(1, "A", 1.0, 25.0, 10, 12, 12)]
        fit = fit_latent(polls, 0, 15, q=0.15, sigma_house=1.0, firm_variance=0.0, initial_sd=12)
        mean = float(fit["mean"][-1])
        sd = math.sqrt(float(fit["var"][-1]))
        self.assertGreater(mean + 1.95996398 * sd, 1.0)
        self.assertLess(mean - 1.95996398 * sd, 1.0)
        self.assertTrue(np.isfinite(fit["mean"]).all())


if __name__ == "__main__":
    unittest.main()
