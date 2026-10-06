"""Synthetic polls with known inputs. These do not use the historical archive."""

from __future__ import annotations

import math
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path

import numpy as np

from txpoll import MODEL_VERSION
from txpoll.calc import (
    Observation,
    build_weights,
    cluster_adjustments,
    cluster_bootstrap,
    cluster_ids,
    estimate_margin_precision,
    field_midpoint,
    histogram_bins,
    local_linear_at,
    margin_pp,
    n_eff_from_moe,
    precision_weight,
    recency_weight,
    sample_type_weight,
    se_proportion_from_moe,
    series_from_weights,
    source_completeness_code,
    source_completeness_weight,
    standardized_residual,
    summarize_draws,
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

    def test_polls_a_month_apart_are_not_one_cluster(self):
        ids = cluster_ids(["Emerson College Polling", "Emerson College Polling"], [0, 33], window_days=7)
        factors = cluster_adjustments(ids, "sqrt_dampen", 1.5, [1.0, 1.0])
        self.assertNotEqual(ids[0], ids[1])
        self.assertEqual(factors, [1.0, 1.0])

    def test_two_polls_inside_the_window_share_a_sqrt_dampen(self):
        ids = cluster_ids(["Fox News", "Fox News"], [0, 4], window_days=7)
        factors = cluster_adjustments(ids, "sqrt_dampen", 1.5, [1.0, 1.0])
        self.assertAlmostEqual(factors[0], 1 / math.sqrt(2))
        self.assertAlmostEqual(factors[1], 1 / math.sqrt(2))

    def test_model_version_matches_the_config(self):
        config = load_yaml("model.yaml")
        self.assertEqual(MODEL_VERSION, "1.3.0")
        self.assertEqual(config["model_version"], MODEL_VERSION)
        self.assertFalse(config["sponsorship_weights"]["apply_in_default_model"])

    def test_source_completeness_replaces_sponsor_type_in_the_default_weight(self):
        config = load_yaml("model.yaml")
        media = _observation(1, "media", "original_with_methodology_or_crosstabs")
        unknown = _observation(2, "unknown", "original_with_methodology_or_crosstabs")
        weighted, _half, _label = build_weights([media, unknown], config, date(2026, 10, 2))
        self.assertAlmostEqual(weighted[0].normalized_weight, weighted[1].normalized_weight)
        self.assertEqual(weighted[0].sponsorship, 1.0)
        self.assertEqual(weighted[1].sponsorship, 1.0)
        self.assertAlmostEqual(weighted[0].source_quality, 1.0)
        aggregator = _observation(3, "media", "aggregator_only", midpoint=date(2026, 9, 1).toordinal())
        self.assertAlmostEqual(source_completeness_weight("aggregator_only", config), 0.70)
        self.assertEqual(
            source_completeness_code(tiers=[3], has_methodology=False, has_crosstabs=False),
            "aggregator_only",
        )
        self.assertEqual(
            source_completeness_code(tiers=[1], has_methodology=True, has_crosstabs=False),
            "original_with_methodology_or_crosstabs",
        )
        legacy, _h, _l = build_weights([media, unknown], config, date(2026, 10, 2), quality="sponsor")
        self.assertGreater(legacy[0].normalized_weight, legacy[1].normalized_weight)
        self.assertIsNotNone(aggregator)

    def test_percentiles_are_not_clipped(self):
        draws = np.array([-12.0, -3.0, 0.0, 1.0, 4.0, 5.0, 5.6, 40.0])
        summary = summarize_draws(draws)
        self.assertEqual(summary["method"], "percentile")
        self.assertEqual(summary["minimum"], -12.0)
        self.assertEqual(summary["maximum"], 40.0)
        self.assertAlmostEqual(summary["p2_5"], float(np.percentile(draws, 2.5)))
        self.assertAlmostEqual(summary["p97_5"], float(np.percentile(draws, 97.5)))
        self.assertGreater(summary["p97_5"], 5.6)
        self.assertLess(summary["maximum"], 100)
        bins = histogram_bins(draws, bins=4)
        self.assertEqual(sum(item["count"] for item in bins), len(draws))
        self.assertAlmostEqual(bins[-1]["x1"], 40.0)

    def test_displayed_margin_is_the_local_linear_fit(self):
        config = load_yaml("model.yaml")
        config["trend"]["bootstrap_draws"] = 25
        early = _observation(1, "media", "original_with_methodology_or_crosstabs", margin=1, midpoint=date(2026, 8, 1).toordinal())
        late = _observation(2, "unknown", "original_with_methodology_or_crosstabs", margin=8, midpoint=date(2026, 9, 20).toordinal(), pollster="Other Poll")
        weighted, _half, _label = build_weights([early, late], config, date(2026, 10, 2))
        series = series_from_weights(weighted, config, date(2026, 10, 2))
        newest = max(item.observation.midpoint for item in weighted)
        held = local_linear_at(series["x"], series["y"], series["w"], newest, float(config["trend"]["bandwidth_days"]))
        self.assertAlmostEqual(float(series["estimate"][-1]), held)
        bands = cluster_bootstrap(weighted, config, date(2026, 10, 2), draws=25)
        summary = bands["drawSummary"]
        self.assertEqual(summary["maximum"], float(np.nanmax(bands["currentDraws"])))
        self.assertEqual(summary["minimum"], float(np.nanmin(bands["currentDraws"])))
        self.assertAlmostEqual(float(bands["high95"][-1]), summary["p97_5"])
        self.assertAlmostEqual(float(bands["low80"][-1]), summary["p10"])
        self.assertEqual(bands["intervalMethod"], "percentile")

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
            from txpoll.service import effective_config, load_polls, observations_for_model

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
            self.assertEqual(snapshot["meta"]["modelVersion"], "1.3.0")
            self.assertEqual(snapshot["uncertainty"]["method"], "gaussian_posterior")
            self.assertEqual(snapshot["meta"]["engine"], "Dynamic latent polling trend")
            self.assertIsNotNone(snapshot["overview"]["low50"])
            self.assertIn("measurement", next(row for row in snapshot["polls"] if row["externalKey"] == "fox-2026-09"))
            self.assertTrue(snapshot["modelLab"]["rows"])
            self.assertNotIn(2026, snapshot["modelLab"]["cycles"])
            self.assertEqual(snapshot["uncertainty"]["pointEstimate"], snapshot["overview"]["margin"])
            self.assertGreaterEqual(snapshot["uncertainty"]["maximum"], snapshot["uncertainty"]["p97_5"])
            self.assertLessEqual(snapshot["uncertainty"]["minimum"], snapshot["uncertainty"]["p2_5"])
            self.assertAlmostEqual(snapshot["overview"]["low80"], snapshot["uncertainty"]["p10"])
            self.assertAlmostEqual(snapshot["overview"]["high95"], snapshot["uncertainty"]["p97_5"])
            held_out = [row for row in snapshot["polls"] if not row["inModel"]]
            self.assertTrue(held_out)
            self.assertTrue(all(row["modelStatus"] and row["modelStatusDetail"] for row in held_out))
            mason = next(row for row in snapshot["polls"] if row["externalKey"] == "mason-dixon-2026-09")
            self.assertEqual(mason["modelStatus"], "excluded_conflicting_sources")
            self.assertTrue(all(row["weights"]["sponsorship"] == 1 for row in snapshot["polls"] if row["weights"]))
            emerson = [row for row in snapshot["polls"] if row["inModel"] and row["canonical"] == "Emerson College Polling"]
            self.assertEqual(len(emerson), 2)
            self.assertTrue(all(row["weights"]["clusterSize"] == 1 for row in emerson))
            from txpoll.service import set_exclusion

            quantus = next(row for row in snapshot["polls"] if row["externalKey"] == "quantus-2026-06")
            set_exclusion(session, quantus["id"], False, "")
            included = observations_for_model(load_polls(session), effective_config(session))
            self.assertIn(quantus["id"], {item.poll_id for item in included})
            mason = next(row for row in snapshot["polls"] if row["externalKey"] == "mason-dixon-2026-09")
            with self.assertRaises(ValueError):
                set_exclusion(session, mason["id"], False, "")
            # Fox July's asterisk remainder is not the tracker's 4 points.
            fox = next(row for row in snapshot["polls"] if row["externalKey"] == "fox-2026-07")
            self.assertTrue(any("TPP says someone else/DK is 4" in note for note in fox["warnings"]))
            self.assertTrue(any(row["symbol"] == "*" for row in fox["results"]))
            session.close()
        finally:
            reset_engine()
            os.environ.pop("POLLING_DATABASE_URL", None)
            Path(handle.name).unlink(missing_ok=True)


class DatabaseUrlTests(unittest.TestCase):
    def test_postgres_url_uses_the_psycopg_driver(self):
        from txpoll.config import database_url

        previous = os.environ.get("POLLING_DATABASE_URL")
        os.environ["POLLING_DATABASE_URL"] = "postgres://user:secret@localhost:5432/election"
        try:
            self.assertEqual(
                database_url(),
                "postgresql+psycopg://user:secret@localhost:5432/election",
            )
        finally:
            if previous is None:
                os.environ.pop("POLLING_DATABASE_URL", None)
            else:
                os.environ["POLLING_DATABASE_URL"] = previous

    def test_election_database_url_is_not_the_poll_archive(self):
        from txpoll.config import database_url

        previous_poll = os.environ.get("POLLING_DATABASE_URL")
        previous_app = os.environ.get("DATABASE_URL")
        os.environ.pop("POLLING_DATABASE_URL", None)
        os.environ["DATABASE_URL"] = "postgres://user:secret@localhost:5432/election"
        try:
            self.assertTrue(database_url().startswith("sqlite:///"))
        finally:
            if previous_poll is None:
                os.environ.pop("POLLING_DATABASE_URL", None)
            else:
                os.environ["POLLING_DATABASE_URL"] = previous_poll
            if previous_app is None:
                os.environ.pop("DATABASE_URL", None)
            else:
                os.environ["DATABASE_URL"] = previous_app


def _observation(poll_id, sponsor_type, source_code, margin=4.0, midpoint=None, pollster="Example Poll"):
    midpoint = date(2026, 9, 20).toordinal() if midpoint is None else midpoint
    return Observation(
        poll_id=poll_id,
        external_key=f"k-{poll_id}",
        pollster=pollster,
        pollster_canonical=pollster,
        sponsor=None,
        sponsor_type=sponsor_type,
        midpoint=float(midpoint),
        field_label="2026-09-20",
        release_date="2026-09-21",
        sample_size=1000,
        sample_type="LV",
        reported_moe=3.0,
        ballot_configuration="two_candidate",
        share_a=50 + margin / 2,
        share_b=50 - margin / 2,
        other_pp=None,
        undecided_pp=None,
        margin=margin,
        se_margin_pp=3.0,
        n_eff=1000,
        n_eff_estimated=True,
        precision_note="test",
        source_label="test",
        review_status="approved",
        source_completeness=source_code,
        sampling_variance_pp=9.0,
    )


class MarginSimulationTests(unittest.TestCase):
    def test_a_positive_margin_leads_more_often_for_abbott(self):
        from txpoll.primary import simulate_margin

        first = simulate_margin(2.0, 1.2)
        second = simulate_margin(2.0, 1.2)
        self.assertEqual(first["runs"], 100_000)
        self.assertGreater(first["abbottShare"], 0.9)
        self.assertEqual(first["abbottLeads"], second["abbottLeads"])
        self.assertEqual(first["abbottLeads"] + first["hinojosaLeads"] + first["ties"], 100_000)


class RcpParseTests(unittest.TestCase):
    def test_reads_individual_polls_and_drops_the_average(self):
        from txpoll.ingest.rcp import parse_rcp_polls

        html = """
        <table>
          <tr><th>pollster</th><th>date</th><th>sample</th><th>moe</th><th>Abbott (R)</th><th>Hinojosa (D)</th><th>spread</th></tr>
          <tr><td>RCP Average</td><td>9/8 - 10/5</td><td>—</td><td>—</td><td>48.1</td><td>46.4</td><td>Abbott +1.7</td></tr>
          <tr><td><a href="https://example.com/yougov.pdf">YouGov</a></td><td>9/28 - 10/5</td><td>3622 LV</td><td>3.0</td><td>47</td><td>48</td><td>Hinojosa +1</td></tr>
          <tr><td>Emerson</td><td>1/10 - 1/12</td><td>1165 LV</td><td>2.8</td><td>50</td><td>42</td><td>Abbott +8</td></tr>
        </table>
        """
        rows = parse_rcp_polls(html)
        self.assertEqual([row["pollster"] for row in rows], ["YouGov", "Emerson"])
        yougov = rows[0]
        self.assertEqual(yougov["field_start"], "2026-09-28")
        self.assertEqual(yougov["field_end"], "2026-10-05")
        self.assertEqual(yougov["sample_size"], 3622)
        self.assertEqual(yougov["sample_type"], "LV")
        self.assertEqual(yougov["abbott"], 47)
        self.assertEqual(yougov["hinojosa"], 48)
        self.assertEqual(yougov["document_url"], "https://example.com/yougov.pdf")
        self.assertNotIn(48.1, [row["abbott"] for row in rows])


class TrackerParseTests(unittest.TestCase):
    def test_parses_a_new_siena_row_without_splitting_a_combined_remainder(self):
        from txpoll.ingest.tpp import parse_tpp_polls, same_survey

        html = """
        <table><tr><th>Poll</th><th>Field Dates</th><th>Sample Size</th><th>Sample Type</th><th>MOE</th><th>Abbott</th><th>Hinojosa</th><th>Other</th><th>Spread</th></tr>
        <tr><td>New York Times/Siena</td><td>9/21 - 9/30</td><td>615</td><td>LV</td><td>+/- 4%</td><td>46</td><td>49</td><td>Another .5%; 5% DK</td><td>Hinojosa +3</td></tr>
        <tr><td>FOX News</td><td>9/24 - 9/28</td><td>881</td><td>LV</td><td>+/-3%</td><td>52</td><td>47</td><td>n/a</td><td>Abbott +5</td></tr>
        <tr><td>NBC News/Mason-Dixon</td><td>9/9 -9/10</td><td>625</td><td>LV</td><td>+/- 4.0%</td><td>48</td><td>41</td><td>Other/undecided 11</td><td>Abbott +7</td></tr>
        </table>
        """
        rows = parse_tpp_polls(html)
        siena = rows[0]
        self.assertEqual(siena["field_start"], "2026-09-21")
        self.assertEqual(siena["field_end"], "2026-09-30")
        self.assertEqual(siena["sample_size"], 615)
        self.assertEqual(siena["abbott"], 46)
        self.assertEqual(siena["hinojosa"], 49)
        self.assertEqual(siena["ballot"], "two_candidate_undecided_permitted")
        self.assertEqual([item["percentage"] for item in siena["extras"]], [0.5, 5.0])
        self.assertTrue(same_survey({"family": "fox", "field_start": "2026-09-24", "field_end": "2026-09-28", "sample_size": 881, "abbott": 52, "hinojosa": 47}, rows[1]))
        self.assertFalse(same_survey({"family": "siena", "field_start": "2026-06-19", "field_end": "2026-06-27", "sample_size": 656, "abbott": 51, "hinojosa": 44}, siena))
        self.assertTrue(same_survey({"family": "mason", "field_start": None, "field_end": None, "sample_size": 625, "abbott": 48, "hinojosa": 41}, rows[2]))


if __name__ == "__main__":
    unittest.main()
