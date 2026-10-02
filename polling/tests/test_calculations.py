"""Synthetic polls with known inputs. These do not use the historical archive."""

from __future__ import annotations

import math
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path

from txpoll.calc import (
    cluster_ids,
    estimate_margin_precision,
    field_midpoint,
    margin_pp,
    n_eff_from_moe,
    precision_weight,
    recency_weight,
    sample_type_weight,
    se_proportion_from_moe,
    standardized_residual,
    variance_margin_proportion,
)
from txpoll.config import load_yaml
from txpoll.dedupe import choose_canonical, similarity
from txpoll.subgroups import normalize_subgroup
from txpoll.validate import source_priority, validate_poll


class CalculationTests(unittest.TestCase):
    def test_margin_is_abbott_minus_hinojosa(self):
        self.assertEqual(margin_pp(52, 47), 5)
        self.assertEqual(margin_pp(46, 49), -3)

    def test_midpoint_keeps_the_half_day(self):
        self.assertEqual(field_midpoint("2026-06-03", "2026-06-04"), date(2026, 6, 3).toordinal() + 0.5)
        self.assertIsNone(field_midpoint("2026-06-04", "2026-06-03"))

    def test_moe_conversion_and_margin_variance(self):
        se = se_proportion_from_moe(1.96)
        self.assertAlmostEqual(se, 0.01)
        n_eff = n_eff_from_moe(3.0, 0.5)
        # MOE 3 points at p=0.5 is about n=1067.
        self.assertAlmostEqual(n_eff, (1.96**2) * 0.25 / (0.03**2), places=4)
        var = variance_margin_proportion(0.52, 0.47, 1000)
        self.assertAlmostEqual(var, (0.52 + 0.47 - 0.05**2) / 1000)
        estimate = estimate_margin_precision(52, 47, 1000, 3.0, None, None)
        self.assertTrue(estimate.n_eff_estimated)
        self.assertGreater(estimate.se_margin_pp, 0)

    def test_variance_floor_stops_a_huge_poll_from_dominating(self):
        small = estimate_margin_precision(50, 45, 800, 3.5, None, None)
        huge = estimate_margin_precision(50, 45, 20000, 0.7, None, None)
        tau = 2.0
        ratio = precision_weight(huge.se_margin_pp, tau) / precision_weight(small.se_margin_pp, tau)
        self.assertLess(ratio, 4)

    def test_recency_half_life(self):
        self.assertAlmostEqual(recency_weight(0, 21), 1)
        self.assertAlmostEqual(recency_weight(21, 21), 0.5)
        self.assertAlmostEqual(recency_weight(42, 21), 0.25)

    def test_sample_type_multipliers(self):
        config = load_yaml("model.yaml")
        self.assertEqual(sample_type_weight("LV", config)[0], 1.0)
        self.assertEqual(sample_type_weight("RV", config)[0], 0.8)
        self.assertEqual(sample_type_weight("Adults", config)[0], 0.5)

    def test_duplicate_detection_links_syndicated_copies(self):
        base = {
            "pollster_canonical": "ReconMR",
            "sponsor": "ReconMR",
            "field_start": "2026-09-08",
            "field_end": "2026-09-11",
            "sample_size": 614,
            "sample_type": "LV",
            "results": [
                {"candidate": "Greg Abbott", "percentage": 45},
                {"candidate": "Gina Hinojosa", "percentage": 49},
            ],
        }
        alias = dict(base, pollster_canonical="Siena / ReconMR", pollster="Siena College")
        other = dict(base, field_start="2026-06-19", field_end="2026-06-27", sample_size=656, pollster_canonical="New York Times / Siena")
        same_score, same_reasons = similarity(base, alias)
        different_score, _reasons = similarity(base, other)
        self.assertGreaterEqual(same_score, 0.72)
        self.assertIn("field dates match", same_reasons)
        self.assertLess(different_score, 0.72)

    def test_a_later_poll_from_the_same_pollster_is_not_the_same_survey(self):
        from txpoll.dedupe import should_link

        august = {
            "pollster_canonical": "Emerson College Polling",
            "sponsor": "Nexstar Media",
            "field_start": "2026-08-09",
            "field_end": "2026-08-10",
            "sample_size": 1000,
            "sample_type": "LV",
            "results": [
                {"candidate": "Greg Abbott", "percentage": 49},
                {"candidate": "Gina Hinojosa", "percentage": 45},
            ],
        }
        september = dict(august, field_start="2026-09-12", field_end="2026-09-14")
        september["results"] = [
            {"candidate": "Greg Abbott", "percentage": 49},
            {"candidate": "Gina Hinojosa", "percentage": 46},
        ]
        link, _score, reasons = should_link(august, september)
        self.assertFalse(link)
        self.assertTrue(any("field dates" in reason for reason in reasons))

    def test_source_priority_prefers_the_original_pdf(self):
        chosen = source_priority(
            [
                {"tier": 3, "url": "https://aggregator.example/tracker", "source_type": "aggregator"},
                {"tier": 1, "url": "https://pollster.example/release", "source_type": "original_release"},
                {"tier": 1, "url": "https://pollster.example/topline.pdf", "source_type": "original_pdf"},
            ]
        )
        self.assertTrue(chosen["url"].endswith(".pdf"))

    def test_subgroup_normalization_keeps_incompatible_age_bands_apart(self):
        hispanic = normalize_subgroup("race_ethnicity", "Hispanic")
        latino = normalize_subgroup("race_ethnicity", "Latino")
        self.assertEqual(hispanic["subgroup_normalized"], "Hispanic/Latino")
        self.assertEqual(latino["subgroup_normalized"], "Hispanic/Latino")
        self.assertEqual(hispanic["subgroup_original"], "Hispanic")
        young = normalize_subgroup("age", "18-34")
        other = normalize_subgroup("age", "18-29")
        self.assertNotEqual(young["compatible_group"], other["compatible_group"])

    def test_outlier_flag_uses_the_uncertainty_floor(self):
        mild = standardized_residual(3, se_margin_pp=2, tau_pp=2)
        extreme = standardized_residual(12, se_margin_pp=2, tau_pp=2)
        self.assertLess(abs(mild), 2.5)
        self.assertGreater(abs(extreme), 2.5)

    def test_cluster_window(self):
        ids = cluster_ids(["Fox News", "Fox News", "Marist Poll"], [10, 12, 12], window_days=7)
        self.assertEqual(ids[0], ids[1])
        self.assertNotEqual(ids[0], ids[2])

    def test_canonical_record_is_the_approved_primary(self):
        key = choose_canonical(
            [
                {"external_key": "news", "approved_for_model": False, "sources": [{"tier": 4}]},
                {"external_key": "pdf", "approved_for_model": True, "sources": [{"tier": 1}]},
            ]
        )
        self.assertEqual(key, "pdf")

    def test_validation_blocks_a_total_that_is_not_a_race(self):
        config = load_yaml("model.yaml")
        messages = validate_poll(
            {
                "state": "OK",
                "race": "Governor",
                "cycle": 2026,
                "field_start": "2026-09-01",
                "field_end": "2026-09-02",
                "sample_size": 800,
                "sample_type": "LV",
                "pollster": "Example",
                "reported_moe": 3.5,
                "results": [
                    {"candidate": "Greg Abbott", "percentage": 50, "result_frame": "headline"},
                    {"candidate": "Gina Hinojosa", "percentage": 40, "result_frame": "headline"},
                ],
                "sources": [{"tier": 1, "url": "https://example.test/a.pdf", "source_type": "original_pdf"}],
            },
            config,
            as_of=date(2026, 10, 2),
        )
        self.assertTrue(any(item["code"] == "wrong_race" and item["level"] == "error" for item in messages))


class SnapshotTests(unittest.TestCase):
    def test_historical_import_snapshots_the_approved_polls_only(self):
        from txpoll.db import init_db, reset_engine
        from txpoll.service import import_historical, recompute

        handle = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
        handle.close()
        os.environ["POLLING_DATABASE_URL"] = "sqlite:///" + Path(handle.name).as_posix()
        os.environ["POLLING_SCHEDULER"] = "0"
        reset_engine()
        try:
            init_db()
            from txpoll.db import get_session

            session = get_session()
            summary = import_historical(session, force=True)
            self.assertGreater(summary["inserted"], 10)
            snapshot = recompute(session, "test", as_of=date(2026, 10, 2))
            modeled = {row["externalKey"] for row in snapshot["polls"] if row["inModel"]}
            self.assertIn("fox-2026-09", modeled)
            self.assertIn("fox-2026-07", modeled)
            self.assertNotIn("quantus-2026-06", modeled)
            self.assertNotIn("mason-dixon-2026-09", modeled)
            self.assertNotIn("nyt-siena-2026-06", modeled)
            self.assertIsNotNone(snapshot["overview"]["margin"])
            self.assertIsNotNone(snapshot["overview"]["low95"])
            self.assertLess(snapshot["overview"]["low95"], snapshot["overview"]["margin"])
            self.assertGreater(snapshot["overview"]["high95"], snapshot["overview"]["margin"])
            self.assertIn("not a forecast", snapshot["meta"]["disclaimer"])
            self.assertIsNone(snapshot["comparisons"]["rcp"])
            # Fox July's asterisk remainder is not the tracker's 4 points.
            fox = next(row for row in snapshot["polls"] if row["externalKey"] == "fox-2026-07")
            self.assertTrue(any("TPP says someone else/DK is 4" in note for note in fox["warnings"]))
            self.assertTrue(any(row["symbol"] == "*" for row in fox["results"]))
            session.close()
        finally:
            reset_engine()
            os.environ.pop("POLLING_DATABASE_URL", None)
            Path(handle.name).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
