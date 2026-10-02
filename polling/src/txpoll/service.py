"""Import, review, weight, and snapshot the polling trend."""

from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from .calc import (
    Observation,
    apply_house_effects,
    build_weights,
    cluster_bootstrap,
    estimate_margin_precision,
    field_midpoint,
    half_life_for_date,
    house_effects,
    kalman_local_level,
    leader_text,
    local_linear_at,
    ordinal_to_iso,
    parse_date,
    series_from_weights,
    standardized_residual,
)
from .config import DATA_DIR, deep_merge, load_yaml
from .dedupe import choose_canonical, should_link
from .historical import historical_polls
from .ingest.discover import fetch_watch_pages
from .ingest.search import SearchNotConfigured, planned_queries, search
from .models import (
    DiscoveryItem,
    Methodology,
    ModelSnapshot,
    PageVersion,
    Poll,
    PollLink,
    PollResult,
    PollReview,
    RunLog,
    SettingOverride,
    Source,
    SubgroupResult,
    utcnow,
)
from .subgroups import mapping_index, normalize_subgroup
from .validate import has_errors, source_priority, validate_poll

MODEL_VERSION = "txpoll-1"
SNAPSHOT_PATH = DATA_DIR / "public_snapshot.json"


def effective_config(session: Session) -> dict[str, Any]:
    base = load_yaml("model.yaml")
    row = session.scalar(select(SettingOverride).where(SettingOverride.race_key == base["race_key"]))
    if row and row.config_json:
        return deep_merge(base, json.loads(row.config_json))
    return base


def save_config_patch(session: Session, patch: dict[str, Any]) -> dict[str, Any]:
    base = load_yaml("model.yaml")
    row = session.scalar(select(SettingOverride).where(SettingOverride.race_key == base["race_key"]))
    current = json.loads(row.config_json) if row and row.config_json else {}
    merged = deep_merge(current, patch)
    if row is None:
        row = SettingOverride(race_key=base["race_key"], config_json=json.dumps(merged))
        session.add(row)
    else:
        row.config_json = json.dumps(merged)
        row.updated_at = utcnow()
    session.commit()
    return effective_config(session)


def reset_config(session: Session) -> dict[str, Any]:
    base = load_yaml("model.yaml")
    row = session.scalar(select(SettingOverride).where(SettingOverride.race_key == base["race_key"]))
    if row is not None:
        session.delete(row)
        session.commit()
    return effective_config(session)


def import_historical(session: Session, *, force: bool = False) -> dict[str, int]:
    config = effective_config(session)
    existing = session.scalars(select(Poll.external_key)).all()
    if existing and not force:
        return {"inserted": 0, "updated": 0, "skipped": len(existing)}
    inserted = 0
    updated = 0
    for record in historical_polls():
        found = session.scalar(select(Poll).where(Poll.external_key == record["external_key"]))
        if found and not force:
            continue
        if found and force:
            session.delete(found)
            session.flush()
            updated += 1
        else:
            inserted += 1
        _insert_poll(session, record, config)
    session.commit()
    _link_similar(session)
    session.commit()
    return {"inserted": inserted, "updated": updated, "skipped": 0}


def _insert_poll(session: Session, record: dict, config: dict) -> Poll:
    messages = validate_poll(record, config)
    approved = bool(record.get("approved_for_model")) and not has_errors(messages)
    midpoint = field_midpoint(record.get("field_start"), record.get("field_end"))
    poll = Poll(
        external_key=record["external_key"],
        race_key=config["race_key"],
        pollster=record["pollster"],
        pollster_canonical=record.get("pollster_canonical") or record["pollster"],
        pollster_parent_company=record.get("pollster_parent_company"),
        sponsor=record.get("sponsor"),
        sponsor_type=record.get("sponsor_type") or "unknown",
        release_date=parse_date(record.get("release_date")),
        field_start=parse_date(record.get("field_start")),
        field_end=parse_date(record.get("field_end")),
        field_midpoint=date.fromordinal(int(math.floor(midpoint))) if midpoint is not None else None,
        state=record.get("state") or "TX",
        race=record.get("race") or "Governor",
        cycle=int(record.get("cycle") or 2026),
        sample_size=record.get("sample_size"),
        sample_size_provenance=record.get("sample_size_provenance"),
        sample_type=record.get("sample_type"),
        mode_json=json.dumps(record.get("mode") or []),
        reported_moe=record.get("reported_moe"),
        design_effect_moe=record.get("design_effect_moe"),
        moe_kind=record.get("moe_kind"),
        confidence_level=record.get("confidence_level"),
        ballot_configuration=record.get("ballot_configuration"),
        ballot_flags_json=json.dumps(record.get("ballot_flags") or []),
        question_wording=record.get("question_wording"),
        population_description=record.get("population_description"),
        weighting_description=record.get("weighting_description"),
        notes=record.get("notes"),
        alternate_frames_json=json.dumps(record.get("alternate_frames") or []),
        status="approved" if approved else "needs_review",
        is_canonical=True,
    )
    session.add(poll)
    session.flush()
    for row in record.get("results") or []:
        session.add(
            PollResult(
                poll_id=poll.id,
                candidate=row["candidate"],
                party=row.get("party"),
                percentage=row.get("percentage"),
                reported_symbol=row.get("reported_symbol"),
                result_type=row.get("result_type") or "candidate",
                result_frame=row.get("result_frame") or "headline",
            )
        )
    primary = source_priority(record.get("sources") or [])
    for src in record.get("sources") or []:
        session.add(
            Source(
                poll_id=poll.id,
                source_type=src.get("source_type") or "other",
                tier=int(src.get("tier") or 5),
                url=src.get("url") or "",
                publisher=src.get("publisher"),
                publication_date=parse_date(src.get("publication_date")),
                is_primary=primary is not None and src is primary,
                notes=src.get("notes"),
                local_file_path=record.get("local_file_path") if src is primary else None,
                retrieved_at=utcnow(),
            )
        )
    if record.get("methodology_text") or record.get("panel_provider"):
        session.add(
            Methodology(
                poll_id=poll.id,
                methodology_text=record.get("methodology_text"),
                panel_provider=record.get("panel_provider"),
                weighting_variables=record.get("weighting_description"),
                contact_method=", ".join(record.get("mode") or []),
                reported_moe=record.get("reported_moe"),
                confidence_level=record.get("confidence_level"),
            )
        )
    index = mapping_index()
    for sub in record.get("subgroups") or []:
        norm = normalize_subgroup(sub["dimension"], sub["subgroup"], index)
        session.add(
            SubgroupResult(
                poll_id=poll.id,
                dimension=sub["dimension"],
                subgroup_original=norm["subgroup_original"],
                subgroup_normalized=norm["subgroup_normalized"],
                compatible_group=norm["compatible_group"],
                candidate=sub["candidate"],
                percentage=sub.get("percentage"),
                subgroup_n=sub.get("subgroup_n"),
                subgroup_moe=sub.get("subgroup_moe"),
                definition=sub.get("definition"),
                notes=("Unmapped label. " if not norm["mapped"] else "") + (sub.get("notes") or ""),
            )
        )
    if record.get("duplicate_aliases"):
        messages.append(
            {
                "level": "warning",
                "code": "alias",
                "message": "Other publications use these names for what is stored as one survey: "
                + "; ".join(record["duplicate_aliases"]),
            }
        )
    session.add(
        PollReview(
            poll_id=poll.id,
            validation_status="pass" if approved and not any(m["level"] == "warning" for m in messages) else ("approved_with_warnings" if approved else "needs_review"),
            validation_messages_json=json.dumps(messages),
            auto_confidence=record.get("auto_confidence"),
            approved_for_model=approved,
            reviewed_by="historical-import" if approved else None,
            reviewed_at=utcnow() if approved else None,
        )
    )
    return poll


def _link_similar(session: Session) -> int:
    polls = session.scalars(select(Poll).options(selectinload(Poll.results))).all()
    records = [_record_view(poll) for poll in polls]
    linked = 0
    for i, left in enumerate(records):
        for right in records[i + 1 :]:
            link, score, reasons = should_link(left, right)
            if not link:
                continue
            pair = tuple(sorted((left["id"], right["id"])))
            exists = session.scalar(
                select(PollLink).where(PollLink.left_poll_id == pair[0], PollLink.right_poll_id == pair[1])
            )
            if exists:
                continue
            session.add(
                PollLink(
                    left_poll_id=pair[0],
                    right_poll_id=pair[1],
                    relationship="possible_duplicate",
                    similarity=score,
                    reasons_json=json.dumps(reasons),
                    created_by="system",
                )
            )
            linked += 1
    if linked:
        _assign_canonical_groups(session)
    return linked


def _record_view(poll: Poll) -> dict:
    return {
        "id": poll.id,
        "external_key": poll.external_key,
        "pollster": poll.pollster,
        "pollster_canonical": poll.pollster_canonical,
        "sponsor": poll.sponsor,
        "field_start": poll.field_start,
        "field_end": poll.field_end,
        "sample_size": poll.sample_size,
        "sample_type": poll.sample_type,
        "approved_for_model": bool(poll.review and poll.review.approved_for_model),
        "results": [
            {"candidate": row.candidate, "percentage": row.percentage, "result_frame": row.result_frame}
            for row in poll.results
        ],
        "sources": [{"tier": src.tier} for src in poll.sources],
    }


def _assign_canonical_groups(session: Session) -> None:
    links = session.scalars(select(PollLink)).all()
    parent: dict[int, int] = {}

    def find(item: int) -> int:
        parent.setdefault(item, item)
        if parent[item] != item:
            parent[item] = find(parent[item])
        return parent[item]

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for link in links:
        if link.relationship in {"possible_duplicate", "duplicate", "manual_merge"}:
            union(link.left_poll_id, link.right_poll_id)
    groups: dict[int, list[int]] = {}
    for item in list(parent):
        groups.setdefault(find(item), []).append(item)
    for members in groups.values():
        if len(members) < 2:
            continue
        polls = session.scalars(select(Poll).where(Poll.id.in_(members)).options(selectinload(Poll.sources), selectinload(Poll.review))).all()
        records = []
        for poll in polls:
            records.append(
                {
                    "external_key": poll.external_key,
                    "approved_for_model": bool(poll.review and poll.review.approved_for_model),
                    "sources": [{"tier": src.tier, "url": src.url, "source_type": src.source_type} for src in poll.sources],
                }
            )
        canonical_key = choose_canonical(records)
        group_name = canonical_key
        for poll in polls:
            poll.duplicate_group = group_name
            poll.is_canonical = poll.external_key == canonical_key
            if not poll.is_canonical and poll.review:
                poll.review.approved_for_model = False
                poll.status = "merged_duplicate"


def load_polls(session: Session) -> list[Poll]:
    return list(
        session.scalars(
            select(Poll)
            .options(
                selectinload(Poll.results),
                selectinload(Poll.sources),
                selectinload(Poll.methodology),
                selectinload(Poll.subgroups),
                selectinload(Poll.review),
            )
            .order_by(Poll.field_end.desc(), Poll.id.desc())
        ).all()
    )


def _share(poll: Poll, name: str) -> float | None:
    for row in poll.results:
        if row.result_frame == "headline" and row.candidate == name and row.percentage is not None:
            return float(row.percentage)
    return None


def _sum_type(poll: Poll, types: set[str], *, exclude_named: set[str] | None = None) -> float | None:
    total = 0.0
    seen = False
    for row in poll.results:
        if row.result_frame != "headline" or row.percentage is None:
            continue
        if exclude_named and row.candidate in exclude_named:
            continue
        if row.result_type in types or (exclude_named is not None and row.candidate not in exclude_named and row.result_type == "candidate"):
            total += float(row.percentage)
            seen = True
    return total if seen else None


def observations_for_model(polls: list[Poll], config: dict[str, Any]) -> list[Observation]:
    a_name = config["margin"]["candidate_a"]
    b_name = config["margin"]["candidate_b"]
    found = []
    for poll in polls:
        review = poll.review
        if poll.excluded or not poll.is_canonical or not review or not review.approved_for_model:
            continue
        share_a = _share(poll, a_name)
        share_b = _share(poll, b_name)
        midpoint = field_midpoint(poll.field_start, poll.field_end)
        if share_a is None or share_b is None or midpoint is None:
            continue
        try:
            precision = estimate_margin_precision(
                share_a,
                share_b,
                poll.sample_size,
                poll.reported_moe,
                poll.design_effect_moe,
                poll.methodology.effective_sample_size if poll.methodology else None,
                prefer_design_effect_moe=bool(config["precision"].get("prefer_design_effect_moe", True)),
                z=float(config["precision"].get("moe_z", 1.96)),
                moe_inversion_proportion=float(config["precision"].get("moe_inversion_proportion", 0.5)),
            )
        except ValueError:
            continue
        messages = json.loads(review.validation_messages_json or "[]")
        other = _sum_type(poll, {"other", "would_not_vote"}, exclude_named={a_name, b_name})
        undecided = _sum_type(poll, {"undecided", "refused"})
        primary = next((src for src in poll.sources if src.is_primary), None)
        found.append(
            Observation(
                poll_id=poll.id,
                external_key=poll.external_key,
                pollster=poll.pollster,
                pollster_canonical=poll.pollster_canonical,
                sponsor=poll.sponsor,
                sponsor_type=poll.sponsor_type,
                midpoint=midpoint,
                field_label=_field_label(poll),
                release_date=poll.release_date.isoformat() if poll.release_date else None,
                sample_size=poll.sample_size,
                sample_type=poll.sample_type,
                reported_moe=poll.design_effect_moe or poll.reported_moe,
                ballot_configuration=poll.ballot_configuration,
                share_a=share_a,
                share_b=share_b,
                other_pp=other,
                undecided_pp=undecided,
                margin=share_a - share_b,
                se_margin_pp=precision.se_margin_pp,
                n_eff=precision.n_eff,
                n_eff_estimated=precision.n_eff_estimated,
                precision_note=precision.note,
                source_label=primary.publisher if primary and primary.publisher else (primary.url if primary else ""),
                review_status=review.validation_status,
                warnings=[m["message"] for m in messages if m["level"] in {"warning", "error"}],
            )
        )
    return found


def _field_label(poll: Poll) -> str:
    if poll.field_start and poll.field_end:
        return f"{poll.field_start.isoformat()} – {poll.field_end.isoformat()}"
    return ""


def recompute(session: Session, software_version: str, as_of: date | None = None) -> dict[str, Any]:
    config = effective_config(session)
    as_of = as_of or date.today()
    polls = load_polls(session)
    observations = observations_for_model(polls, config)
    snapshot = build_snapshot(polls, observations, config, as_of, software_version)
    snapshot = attach_links(session, snapshot)
    payload = json.dumps(snapshot, default=_json_default)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    session.add(
        ModelSnapshot(
            as_of=as_of,
            race_key=config["race_key"],
            software_version=software_version,
            model_version=MODEL_VERSION,
            poll_ids_json=json.dumps([obs.poll_id for obs in observations]),
            config_json=json.dumps(config, default=_json_default),
            estimate_json=json.dumps(
                {
                    "margin": snapshot["overview"]["margin"],
                    "low80": snapshot["overview"]["low80"],
                    "high80": snapshot["overview"]["high80"],
                    "low95": snapshot["overview"]["low95"],
                    "high95": snapshot["overview"]["high95"],
                    "label": snapshot["overview"]["label"],
                }
            ),
            config_hash=digest,
        )
    )
    session.add(RunLog(kind="recompute", ok=True, finished_at=utcnow(), message=snapshot["overview"]["label"]))
    session.commit()
    SNAPSHOT_PATH.parent.mkdir(parents=True, exist_ok=True)
    SNAPSHOT_PATH.write_text(payload, encoding="utf-8")
    return snapshot


def build_snapshot(polls, observations, config, as_of: date, software_version: str) -> dict[str, Any]:
    weighted, half_life, half_life_label = build_weights(observations, config, as_of, weight_mode="full")
    series = series_from_weights(weighted, config, as_of)
    fitted = []
    if weighted:
        for item in weighted:
            fitted.append(local_linear_at(series["x"], series["y"], series["w"], item.observation.midpoint, float(config["trend"]["bandwidth_days"])))
    effects = house_effects(weighted, fitted, config) if weighted else {}
    if config["house_effects"].get("apply") and weighted:
        apply_house_effects(weighted, effects)
        series = series_from_weights(weighted, config, as_of)
        fitted = [
            local_linear_at(series["x"], series["y"], series["w"], item.observation.midpoint, float(config["trend"]["bandwidth_days"]))
            for item in weighted
        ]
    else:
        for item in weighted:
            item.adjusted_margin = item.observation.margin
            item.house_effect = effects.get(item.observation.pollster_canonical, {}).get("estimate") or 0.0

    bands = cluster_bootstrap(weighted, config, as_of) if weighted else {}
    estimate = _last_finite(series.get("estimate"))
    low80 = _last_finite(bands.get("low80")) if bands else None
    high80 = _last_finite(bands.get("high80")) if bands else None
    low95 = _last_finite(bands.get("low95")) if bands else None
    high95 = _last_finite(bands.get("high95")) if bands else None

    tau = float(config["precision"]["tau_pp"])
    threshold = float(config["outliers"]["standardized_threshold"])
    outliers = []
    weight_by_id = {item.observation.poll_id: item for item in weighted}
    for item, fit in zip(weighted, fitted):
        if fit is None or not math.isfinite(fit):
            continue
        residual = item.observation.margin - fit
        z = standardized_residual(residual, item.observation.se_margin_pp, tau)
        flagged = abs(z) >= threshold
        outliers.append(
            {
                "pollId": item.observation.poll_id,
                "fitted": fit,
                "residual": residual,
                "standardized": z,
                "flagged": flagged,
            }
        )
    outlier_by_id = {row["pollId"]: row for row in outliers}

    comparisons = _comparisons(observations, config, as_of, estimate, series.get("ordinals"))
    state = _state_space(weighted, config, as_of, series)
    daily = _daily_table(series, bands, state, comparisons["series"])
    if daily:
        comparisons["current"]["stateSpace"] = daily[-1]["stateSpace"]
        comparisons["current"]["stateSpaceLabel"] = leader_text(daily[-1]["stateSpace"], config)
        comparisons["current"]["stateLow95"] = daily[-1]["stateLow95"]
        comparisons["current"]["stateHigh95"] = daily[-1]["stateHigh95"]
    subgroup_block = _subgroup_block(polls, config, as_of)
    poll_rows = [_poll_row(poll, weight_by_id.get(poll.id), outlier_by_id.get(poll.id), config) for poll in polls]
    quality = _quality(poll_rows)

    lv_weight = sum(item.normalized_weight for item in weighted if item.observation.sample_type == "LV")
    rv_weight = sum(item.normalized_weight for item in weighted if item.observation.sample_type == "RV")
    latest = max(poll_rows, key=lambda row: row["releaseDate"] or "", default=None)
    return {
        "meta": {
            "title": "Texas Governor Poll Trend",
            "raceKey": config["race_key"],
            "asOf": as_of.isoformat(),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "softwareVersion": software_version,
            "modelVersion": MODEL_VERSION,
            "electionDate": config["race"]["election_date"],
            "halfLifeDays": half_life,
            "halfLifeLabel": half_life_label,
            "engine": "Weighted local linear trend",
            "disclaimer": "This is a polling-trend estimate, not a forecast and not a probability that either candidate wins.",
            "candidateA": config["margin"]["candidate_a"],
            "candidateB": config["margin"]["candidate_b"],
            "colors": config.get("display") or {},
        },
        "overview": {
            "margin": estimate,
            "label": leader_text(estimate, config),
            "low80": low80,
            "high80": high80,
            "low95": low95,
            "high95": high95,
            "interval80Label": _interval_label(low80, high80, config),
            "interval95Label": _interval_label(low95, high95, config),
            "pollsInModel": len(weighted),
            "pollstersInModel": len({item.observation.pollster_canonical for item in weighted}),
            "pollsStored": len(polls),
            "lvCount": sum(1 for item in weighted if item.observation.sample_type == "LV"),
            "rvCount": sum(1 for item in weighted if item.observation.sample_type == "RV"),
            "lvWeightShare": lv_weight,
            "rvWeightShare": rv_weight,
            "latestRelease": latest,
            "lastFieldMidpoint": ordinal_to_iso(max(item.observation.midpoint for item in weighted)) if weighted else None,
            "trendHoldNote": "After the newest field midpoint, the trend is held at that day's fitted value. The line is not projected forward.",
            "houseEffectApplied": bool(config["house_effects"].get("apply")),
        },
        "daily": daily,
        "polls": poll_rows,
        "comparisons": comparisons["current"],
        "subgroups": subgroup_block,
        "pollsters": _pollster_rows(weighted, effects, outlier_by_id),
        "review": [row for row in poll_rows if row["status"] != "approved" or row["warnings"]],
        "quality": quality,
        "settings": config,
        "links": [
            {
                "left": link.left_poll_id,
                "right": link.right_poll_id,
                "relationship": link.relationship,
                "similarity": link.similarity,
                "reasons": json.loads(link.reasons_json or "[]"),
            }
            for link in []
        ],
    }


def _comparisons(observations, config, as_of, weighted_now, grid):
    def current(mode, types=None):
        weighted, _h, _l = build_weights(observations, config, as_of, sample_types=types, weight_mode=mode)
        series = series_from_weights(weighted, config, as_of, grid=grid)
        return _last_finite(series.get("estimate")), series

    weighted_value = weighted_now
    equal, equal_series = current("equal")
    sized, sized_series = current("sample_size")
    lv, lv_series = current("full", {"LV"})
    rv, rv_series = current("full", {"RV"})
    return {
        "current": {
            "weightedTrend": weighted_value,
            "weightedLabel": leader_text(weighted_value, config),
            "unweightedMean": equal,
            "unweightedLabel": leader_text(equal, config),
            "sampleSizeWeighted": sized,
            "sampleSizeLabel": leader_text(sized, config),
            "lvOnly": lv,
            "lvLabel": leader_text(lv, config),
            "rvOnly": rv,
            "rvLabel": leader_text(rv, config),
            "stateSpace": None,
            "rcp": None,
            "rcpNote": "The RealClearPolling average is a comparison slot only. It has not been ingested, and it is never an input.",
        },
        "series": {
            "equal": equal_series,
            "sized": sized_series,
            "lv": lv_series,
            "rv": rv_series,
        },
    }


def _state_space(weighted, config, as_of, series):
    if not weighted or "ordinals" not in series:
        return {"mean": [], "sd": []}
    tau = float(config["precision"]["tau_pp"])
    obs = []
    for item in weighted:
        margin = item.adjusted_margin if item.adjusted_margin is not None else item.observation.margin
        sd = math.sqrt(item.observation.se_margin_pp ** 2 + tau ** 2)
        obs.append((item.observation.midpoint, margin, sd))
    initial = float(np.average([m for _o, m, _s in obs]))
    process_sd = float(config["state_space"]["process_sd_per_day"])
    initial_sd = float(config["state_space"]["initial_sd"])
    mean, sd = kalman_local_level(obs, series["ordinals"], process_sd, initial, initial_sd)
    return {"mean": mean, "sd": sd}


def _daily_table(series, bands, state, comparison_series) -> list[dict]:
    if not series or not series.get("dates"):
        return []
    rows = []
    n = len(series["dates"])

    def at(payload, index):
        if not payload or "estimate" not in payload or len(payload["estimate"]) != n:
            return None
        value = payload["estimate"][index]
        return None if not math.isfinite(float(value)) else float(value)

    for i, day in enumerate(series["dates"]):
        estimate = series["estimate"][i]
        ss = state["mean"][i] if len(state["mean"]) == n else None
        ss_sd = state["sd"][i] if len(state["sd"]) == n else None
        rows.append(
            {
                "date": day,
                "weighted": None if not math.isfinite(float(estimate)) else float(estimate),
                "low80": _band(bands, "low80", i),
                "high80": _band(bands, "high80", i),
                "low95": _band(bands, "low95", i),
                "high95": _band(bands, "high95", i),
                "stateSpace": None if ss is None or not math.isfinite(float(ss)) else float(ss),
                "stateLow95": None if ss is None or ss_sd is None else float(ss - 1.96 * ss_sd),
                "stateHigh95": None if ss is None or ss_sd is None else float(ss + 1.96 * ss_sd),
                "unweighted": at(comparison_series["equal"], i),
                "sampleSize": at(comparison_series["sized"], i),
                "lvOnly": at(comparison_series["lv"], i),
                "rvOnly": at(comparison_series["rv"], i),
            }
        )
    if rows:
        last = rows[-1]
        # The caller fills stateSpace on the comparison card from the last day.
    return rows


def _band(bands, key, index):
    if not bands or key not in bands or len(bands[key]) <= index:
        return None
    value = bands[key][index]
    if value is None or not math.isfinite(float(value)):
        return None
    return float(value)


def _poll_row(poll: Poll, weight, outlier, config) -> dict[str, Any]:
    a = config["margin"]["candidate_a"]
    b = config["margin"]["candidate_b"]
    messages = json.loads(poll.review.validation_messages_json) if poll.review else []
    headline = [row for row in poll.results if row.result_frame == "headline"]
    other = 0.0
    other_seen = False
    undecided = None
    for row in headline:
        if row.candidate in {a, b} or row.percentage is None:
            continue
        if row.result_type in {"undecided", "refused"}:
            undecided = (undecided or 0) + float(row.percentage)
        else:
            other += float(row.percentage)
            other_seen = True
    primary = next((src for src in poll.sources if src.is_primary), None)
    return {
        "id": poll.id,
        "externalKey": poll.external_key,
        "pollster": poll.pollster,
        "canonical": poll.pollster_canonical,
        "sponsor": poll.sponsor,
        "sponsorType": poll.sponsor_type,
        "fieldStart": poll.field_start.isoformat() if poll.field_start else None,
        "fieldEnd": poll.field_end.isoformat() if poll.field_end else None,
        "fieldLabel": _field_label(poll),
        "midpoint": ordinal_to_iso(field_midpoint(poll.field_start, poll.field_end)) if field_midpoint(poll.field_start, poll.field_end) else None,
        "releaseDate": poll.release_date.isoformat() if poll.release_date else None,
        "sampleSize": poll.sample_size,
        "sampleSizeProvenance": poll.sample_size_provenance,
        "sampleType": poll.sample_type,
        "mode": json.loads(poll.mode_json or "[]"),
        "moe": poll.reported_moe,
        "designEffectMoe": poll.design_effect_moe,
        "moeKind": poll.moe_kind,
        "abbott": _share(poll, a),
        "hinojosa": _share(poll, b),
        "other": other if other_seen else None,
        "undecided": undecided,
        "margin": None if _share(poll, a) is None or _share(poll, b) is None else _share(poll, a) - _share(poll, b),
        "ballot": poll.ballot_configuration,
        "ballotFlags": json.loads(poll.ballot_flags_json or "[]"),
        "question": poll.question_wording,
        "population": poll.population_description,
        "weighting": poll.weighting_description,
        "notes": poll.notes,
        "status": poll.status,
        "excluded": poll.excluded,
        "exclusionReason": poll.exclusion_reason,
        "canonicalObservation": poll.is_canonical,
        "duplicateGroup": poll.duplicate_group,
        "approved": bool(poll.review and poll.review.approved_for_model),
        "reviewStatus": poll.review.validation_status if poll.review else "pending",
        "confidence": poll.review.auto_confidence if poll.review else None,
        "warnings": [m["message"] for m in messages if m["level"] != "info"],
        "messages": messages,
        "inModel": weight is not None and not poll.excluded,
        "weights": None
        if weight is None
        else {
            "precision": weight.precision,
            "recency": weight.recency,
            "sampleType": weight.sample_type_factor,
            "sampleTypeKey": weight.sample_type_key,
            "sponsorship": weight.sponsorship,
            "cluster": weight.cluster_factor,
            "clusterSize": weight.cluster_size,
            "raw": weight.raw_weight,
            "final": weight.normalized_weight,
            "seMargin": weight.observation.se_margin_pp,
            "nEff": weight.observation.n_eff,
            "nEffEstimated": weight.observation.n_eff_estimated,
            "precisionNote": weight.observation.precision_note,
            "houseEffect": weight.house_effect,
        },
        "outlier": outlier,
        "sources": [
            {
                "id": src.id,
                "type": src.source_type,
                "tier": src.tier,
                "url": src.url,
                "publisher": src.publisher,
                "publicationDate": src.publication_date.isoformat() if src.publication_date else None,
                "isPrimary": src.is_primary,
                "notes": src.notes,
                "localFile": src.local_file_path,
                "hash": src.content_hash,
            }
            for src in poll.sources
        ],
        "primaryPublisher": primary.publisher if primary else None,
        "methodology": poll.methodology.methodology_text if poll.methodology else None,
        "panel": poll.methodology.panel_provider if poll.methodology else None,
        "alternateFrames": json.loads(poll.alternate_frames_json or "[]"),
        "subgroups": [
            {
                "dimension": sub.dimension,
                "original": sub.subgroup_original,
                "normalized": sub.subgroup_normalized,
                "group": sub.compatible_group,
                "candidate": sub.candidate,
                "percentage": sub.percentage,
                "n": sub.subgroup_n,
                "moe": sub.subgroup_moe,
                "definition": sub.definition,
                "notes": sub.notes,
            }
            for sub in poll.subgroups
        ],
        "results": [
            {
                "candidate": row.candidate,
                "party": row.party,
                "percentage": row.percentage,
                "symbol": row.reported_symbol,
                "type": row.result_type,
            }
            for row in headline
        ],
        "completeness": _completeness(poll),
    }


def _completeness(poll: Poll) -> dict[str, Any]:
    checks = {
        "pollster": bool(poll.pollster),
        "sponsor": bool(poll.sponsor),
        "field dates": bool(poll.field_start and poll.field_end),
        "sample size": bool(poll.sample_size),
        "sample type": poll.sample_type in {"LV", "RV", "Adults", "Other"},
        "margin of error": poll.reported_moe is not None or poll.design_effect_moe is not None,
        "mode": bool(poll.mode_json and poll.mode_json not in {"[]", "null"}),
        "question wording": bool(poll.question_wording),
        "ballot format": bool(poll.ballot_configuration),
        "primary or sponsor source": any(src.tier <= 2 for src in poll.sources),
        "methodology note": bool(poll.methodology and poll.methodology.methodology_text),
        "both major-candidate shares": _share(poll, "Greg Abbott") is not None and _share(poll, "Gina Hinojosa") is not None,
    }
    score = round(100 * sum(1 for ok in checks.values() if ok) / len(checks))
    return {"score": score, "checks": checks, "label": "Data completeness"}


def _quality(rows: list[dict]) -> dict[str, Any]:
    def count(pred):
        return sum(1 for row in rows if pred(row))

    issues = {
        "missingN": count(lambda row: not row["sampleSize"]),
        "missingMoe": count(lambda row: row["moe"] is None and row["designEffectMoe"] is None),
        "unknownSample": count(lambda row: row["sampleType"] not in {"LV", "RV", "Adults"}),
        "missingPrimary": count(lambda row: not any(src["tier"] <= 2 for src in row["sources"])),
        "extractionWarnings": count(lambda row: any(m["code"] == "extraction" for m in row["messages"])),
        "shareTotalFlags": count(lambda row: any(m["code"] == "share_total" for m in row["messages"])),
        "dateProblems": count(lambda row: any(m["code"] in {"missing_dates", "date_order", "future_dates"} for m in row["messages"])),
        "subgroupCellsMissingN": sum(1 for row in rows for sub in row["subgroups"] if sub["n"] is None),
        "notInModel": count(lambda row: not row["inModel"]),
    }
    scores = [row["completeness"]["score"] for row in rows]
    return {
        "label": "Data completeness",
        "note": "This score counts whether fields and sources are present. It is not a partisan or ideological quality rating.",
        "meanCompleteness": round(sum(scores) / len(scores), 1) if scores else None,
        "issues": issues,
    }


def _pollster_rows(weighted, effects, outlier_by_id) -> list[dict]:
    names = sorted({item.observation.pollster_canonical for item in weighted} | set(effects))
    rows = []
    for name in names:
        items = [item for item in weighted if item.observation.pollster_canonical == name]
        effect = effects.get(name) or {}
        residuals = []
        for item in items:
            outlier = outlier_by_id.get(item.observation.poll_id)
            if outlier:
                residuals.append(outlier["residual"])
        rows.append(
            {
                "pollster": name,
                "polls": effect.get("polls", len(items)),
                "averageN": _mean([item.observation.sample_size for item in items]),
                "sampleTypes": sorted({item.observation.sample_type for item in items if item.observation.sample_type}),
                "averageWeight": _mean([item.normalized_weight for item in items]),
                "houseEffect": effect.get("estimate"),
                "houseSe": effect.get("se"),
                "houseLabel": effect.get("label"),
                "residuals": residuals,
            }
        )
    return rows


def _subgroup_block(polls: list[Poll], config: dict, as_of: date) -> list[dict]:
    """Diagnostic layer. These margins are not inputs to the statewide trend."""
    minimum = int(config["subgroups"]["minimum_polls_for_trend"])
    a = config["margin"]["candidate_a"]
    b = config["margin"]["candidate_b"]
    buckets: dict[tuple, list] = {}
    for poll in polls:
        if poll.excluded or not poll.is_canonical or not poll.review or not poll.review.approved_for_model:
            continue
        cells: dict[tuple, dict] = {}
        for sub in poll.subgroups:
            key = (sub.dimension, sub.compatible_group or sub.subgroup_normalized)
            cell = cells.setdefault(
                key,
                {
                    "originals": set(),
                    "normalized": sub.subgroup_normalized,
                    "shares": {},
                    "n": sub.subgroup_n,
                    "definition": sub.definition,
                },
            )
            cell["originals"].add(sub.subgroup_original)
            if sub.percentage is not None:
                cell["shares"][sub.candidate] = float(sub.percentage)
            if sub.subgroup_n is not None:
                cell["n"] = sub.subgroup_n
        midpoint = field_midpoint(poll.field_start, poll.field_end)
        for key, cell in cells.items():
            if a not in cell["shares"] or b not in cell["shares"] or midpoint is None:
                continue
            buckets.setdefault(key, []).append(
                {
                    "pollId": poll.id,
                    "pollster": poll.pollster_canonical,
                    "midpoint": midpoint,
                    "date": ordinal_to_iso(midpoint),
                    "margin": cell["shares"][a] - cell["shares"][b],
                    "abbott": cell["shares"][a],
                    "hinojosa": cell["shares"][b],
                    "n": cell["n"],
                    "originals": sorted(cell["originals"]),
                    "definition": cell["definition"],
                }
            )
    half_life, _label = half_life_for_date(config, as_of)
    cards = []
    for (dimension, group), rows in sorted(buckets.items()):
        originals = sorted({name for row in rows for name in row["originals"]})
        known_n = sum(row["n"] or 0 for row in rows)
        n_reported = sum(1 for row in rows if row["n"])
        weights = []
        for row in rows:
            age = max(0.0, as_of.toordinal() - row["midpoint"])
            recency = 0.5 ** (age / half_life)
            if row["n"]:
                precision = row["n"]
                note = "Recency and reported subgroup n. Still separate from the statewide model."
            else:
                precision = 1.0
                note = "Subgroup sample size not reported. This trend is recency-weighted only and is not a precision claim."
            weights.append(recency * precision)
        total = sum(weights) or 1.0
        current = sum(row["margin"] * (w / total) for row, w in zip(rows, weights))
        cards.append(
            {
                "dimension": dimension,
                "group": group,
                "label": rows[0]["originals"][0] if len(originals) == 1 else rows[-1]["originals"][0],
                "normalized": originals[0] if len(set(originals)) == 1 else ", ".join(originals),
                "originalLabels": originals,
                "polls": len(rows),
                "knownN": known_n if n_reported else None,
                "nReportedFor": n_reported,
                "nMissing": len(rows) - n_reported,
                "current": current if len(rows) >= minimum else None,
                "currentLabel": leader_text(current, config) if len(rows) >= minimum else f"Fewer than {minimum} polls",
                "precisionNote": note,
                "separateFromTopline": True,
                "points": [
                    {"pollId": row["pollId"], "pollster": row["pollster"], "date": row["date"], "margin": row["margin"], "n": row["n"]}
                    for row in sorted(rows, key=lambda item: item["midpoint"])
                ],
            }
        )
    return cards


def _last_finite(values) -> float | None:
    if values is None:
        return None
    for value in reversed(list(values)):
        if value is not None and math.isfinite(float(value)):
            return float(value)
    return None


def _mean(values) -> float | None:
    clean = [float(v) for v in values if v is not None]
    if not clean:
        return None
    return sum(clean) / len(clean)


def _interval_label(low, high, config) -> str | None:
    if low is None or high is None:
        return None
    return f"{leader_text(low, config)} to {leader_text(high, config)}"


def _json_default(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    raise TypeError(type(value))


def attach_links(session: Session, snapshot: dict) -> dict:
    links = session.scalars(select(PollLink)).all()
    snapshot["links"] = [
        {
            "left": link.left_poll_id,
            "right": link.right_poll_id,
            "relationship": link.relationship,
            "similarity": link.similarity,
            "reasons": json.loads(link.reasons_json or "[]"),
        }
        for link in links
    ]
    return snapshot


def set_approval(session: Session, poll_id: int, approved: bool, reviewer: str) -> None:
    poll = session.get(Poll, poll_id)
    if poll is None or poll.review is None:
        raise KeyError(poll_id)
    messages = json.loads(poll.review.validation_messages_json or "[]")
    if approved and any(m["level"] == "error" for m in messages):
        raise ValueError("This poll still has validation errors. Edit the record before approving it.")
    poll.review.approved_for_model = approved and poll.is_canonical and not poll.excluded
    poll.review.reviewed_by = reviewer
    poll.review.reviewed_at = utcnow()
    poll.review.validation_status = "approved" if poll.review.approved_for_model else "rejected"
    poll.status = "approved" if poll.review.approved_for_model else "needs_review"
    session.commit()


def set_exclusion(session: Session, poll_id: int, excluded: bool, reason: str) -> None:
    if excluded and not (reason or "").strip():
        raise ValueError("Excluding a poll requires a reason.")
    poll = session.get(Poll, poll_id)
    if poll is None or poll.review is None:
        raise KeyError(poll_id)
    poll.excluded = excluded
    poll.exclusion_reason = reason.strip() if excluded else None
    if excluded:
        poll.review.approved_for_model = False
        poll.status = "excluded"
    session.commit()


def merge_polls(session: Session, keep_id: int, drop_id: int) -> None:
    if keep_id == drop_id:
        raise ValueError("Choose two different polls.")
    session.add(
        PollLink(
            left_poll_id=min(keep_id, drop_id),
            right_poll_id=max(keep_id, drop_id),
            relationship="manual_merge",
            similarity=1,
            reasons_json=json.dumps(["manual merge"]),
            created_by="user",
        )
    )
    session.flush()
    _assign_canonical_groups(session)
    kept = session.get(Poll, keep_id)
    if kept:
        kept.is_canonical = True
        kept.duplicate_group = kept.external_key
    dropped = session.get(Poll, drop_id)
    if dropped:
        dropped.is_canonical = False
        if dropped.review:
            dropped.review.approved_for_model = False
        dropped.status = "merged_duplicate"
    session.commit()


def unmerge_poll(session: Session, poll_id: int) -> None:
    poll = session.get(Poll, poll_id)
    if poll is None:
        raise KeyError(poll_id)
    links = session.scalars(
        select(PollLink).where(or_(PollLink.left_poll_id == poll_id, PollLink.right_poll_id == poll_id))
    ).all()
    for link in links:
        session.delete(link)
    poll.is_canonical = True
    poll.duplicate_group = None
    poll.status = "needs_review"
    session.commit()


def add_manual_poll(session: Session, payload: dict, config: dict | None = None) -> dict:
    config = config or effective_config(session)
    record = {
        "external_key": payload.get("external_key") or f"manual-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
        "pollster": payload["pollster"],
        "pollster_canonical": payload.get("pollster") or payload["pollster"],
        "sponsor": payload.get("sponsor"),
        "sponsor_type": payload.get("sponsor_type") or "unknown",
        "release_date": payload.get("release_date"),
        "field_start": payload.get("field_start"),
        "field_end": payload.get("field_end"),
        "sample_size": payload.get("sample_size"),
        "sample_size_provenance": "Entered manually.",
        "sample_type": payload.get("sample_type"),
        "reported_moe": payload.get("reported_moe"),
        "ballot_configuration": payload.get("ballot_configuration") or "unspecified",
        "state": "TX",
        "race": "Governor",
        "cycle": 2026,
        "approved_for_model": False,
        "auto_confidence": 0.5,
        "results": [
            {"candidate": "Greg Abbott", "party": "Republican", "percentage": payload.get("abbott"), "result_type": "candidate"},
            {"candidate": "Gina Hinojosa", "party": "Democrat", "percentage": payload.get("hinojosa"), "result_type": "candidate"},
        ],
        "sources": [
            {
                "tier": 4 if payload.get("url") else 5,
                "source_type": "manual",
                "url": payload.get("url") or "manual-entry",
                "publisher": payload.get("pollster"),
                "is_primary": True,
                "notes": "Manual entry. Duplicate check runs before this can be approved.",
            }
        ],
        "extraction_warnings": ["Entered by hand. Held for review until approved."],
    }
    if payload.get("other") is not None:
        record["results"].append({"candidate": "Other", "percentage": payload.get("other"), "result_type": "other"})
    if payload.get("undecided") is not None:
        record["results"].append({"candidate": "Undecided", "percentage": payload.get("undecided"), "result_type": "undecided"})
    poll = _insert_poll(session, record, config)
    session.commit()
    view = _record_view(poll)
    conflicts = []
    for other in load_polls(session):
        if other.id == poll.id:
            continue
        link, score, reasons = should_link(view, _record_view(other))
        if link:
            conflicts.append({"pollId": other.id, "pollster": other.pollster, "similarity": score, "reasons": reasons})
            session.add(
                PollLink(
                    left_poll_id=min(poll.id, other.id),
                    right_poll_id=max(poll.id, other.id),
                    relationship="possible_duplicate",
                    similarity=score,
                    reasons_json=json.dumps(reasons),
                    created_by="manual-entry",
                )
            )
    session.commit()
    return {"pollId": poll.id, "possibleDuplicates": conflicts}


def run_discovery(session: Session) -> dict[str, Any]:
    started = RunLog(kind="discovery", ok=False, message="started")
    session.add(started)
    session.commit()
    notes = []
    pages = fetch_watch_pages()
    for page in pages:
        url = page["url"]
        if not page.get("ok"):
            session.add(DiscoveryItem(url=url, status="fetch_failed", notes=page.get("error"), publisher=(page.get("source") or {}).get("name")))
            notes.append(f"Failed {url}")
            continue
        previous = session.scalars(select(PageVersion).where(PageVersion.url == url).order_by(PageVersion.retrieved_at.desc())).first()
        if previous and previous.content_hash == page["hash"]:
            notes.append(f"Unchanged {url}")
            continue
        session.add(
            PageVersion(
                url=url,
                content_hash=page["hash"],
                local_file_path=page.get("path"),
                change_note=None if previous is None else "Content hash changed. Previous version kept.",
            )
        )
        rows = page.get("rows") or []
        if rows:
            for row in rows:
                session.add(
                    DiscoveryItem(
                        url=url,
                        title=" | ".join(row.get("cells") or [])[:500],
                        publisher=(page.get("source") or {}).get("name"),
                        status="needs_review",
                        content_hash=page["hash"],
                        notes="Parsed tracker row. Not a poll until a primary source is matched.",
                    )
                )
        else:
            session.add(
                DiscoveryItem(
                    url=url,
                    publisher=(page.get("source") or {}).get("name"),
                    status="needs_review",
                    content_hash=page["hash"],
                    notes=page.get("note") or "Page changed or was archived. No poll table was parsed.",
                )
            )
        notes.append(f"Archived {url}")
    try:
        for query in planned_queries():
            for hit in search(query):
                session.add(DiscoveryItem(url=hit.url, title=hit.title, query=query, status="new", notes=hit.snippet, publisher=hit.provider))
            notes.append(f"Searched {query}")
    except SearchNotConfigured as exc:
        notes.append(str(exc))
    started.ok = True
    started.finished_at = utcnow()
    started.message = "\n".join(notes)[:4000]
    session.commit()
    return {"ok": True, "notes": notes}


def export_tables(session: Session, folder: Path) -> dict[str, str]:
    folder.mkdir(parents=True, exist_ok=True)
    polls = load_polls(session)
    config = effective_config(session)
    observations = observations_for_model(polls, config)
    snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8")) if SNAPSHOT_PATH.exists() else {}
    poll_frame = pd.DataFrame(
        [
            {
                "poll_id": row["id"],
                "pollster": row["pollster"],
                "sponsor": row["sponsor"],
                "field_start": row["fieldStart"],
                "field_end": row["fieldEnd"],
                "release_date": row["releaseDate"],
                "n": row["sampleSize"],
                "sample": row["sampleType"],
                "moe": row["moe"],
                "abbott": row["abbott"],
                "hinojosa": row["hinojosa"],
                "other": row["other"],
                "undecided": row["undecided"],
                "margin": row["margin"],
                "ballot": row["ballot"],
                "final_weight": None if not row["weights"] else row["weights"]["final"],
                "approved": row["approved"],
                "completeness": row["completeness"]["score"],
            }
            for row in [_poll_row(poll, None, None, config) for poll in polls]
        ]
    )
    # Weights from a fresh compute when the snapshot has them.
    if snapshot.get("polls"):
        by_id = {row["id"]: row for row in snapshot["polls"]}
        poll_frame["final_weight"] = poll_frame["poll_id"].map(lambda pid: ((by_id.get(pid) or {}).get("weights") or {}).get("final"))
    subgroup_rows = []
    for poll in polls:
        for sub in poll.subgroups:
            subgroup_rows.append(
                {
                    "poll_id": poll.id,
                    "pollster": poll.pollster,
                    "dimension": sub.dimension,
                    "original": sub.subgroup_original,
                    "normalized": sub.subgroup_normalized,
                    "candidate": sub.candidate,
                    "percentage": sub.percentage,
                    "n": sub.subgroup_n,
                }
            )
    source_rows = []
    for poll in polls:
        for src in poll.sources:
            source_rows.append(
                {
                    "poll_id": poll.id,
                    "tier": src.tier,
                    "type": src.source_type,
                    "publisher": src.publisher,
                    "url": src.url,
                    "is_primary": src.is_primary,
                }
            )
    paths = {
        "polls.csv": folder / "polls.csv",
        "subgroups.csv": folder / "subgroups.csv",
        "sources.csv": folder / "sources.csv",
        "model_daily.csv": folder / "model_daily.csv",
    }
    poll_frame.to_csv(paths["polls.csv"], index=False)
    pd.DataFrame(subgroup_rows).to_csv(paths["subgroups.csv"], index=False)
    pd.DataFrame(source_rows).to_csv(paths["sources.csv"], index=False)
    pd.DataFrame(snapshot.get("daily") or []).to_csv(paths["model_daily.csv"], index=False)
    snaps = session.scalars(select(ModelSnapshot).order_by(ModelSnapshot.created_at)).all()
    pd.DataFrame(
        [
            {
                "id": snap.id,
                "created_at": snap.created_at,
                "as_of": snap.as_of,
                "estimate": snap.estimate_json,
                "software_version": snap.software_version,
                "model_version": snap.model_version,
                "poll_ids": snap.poll_ids_json,
            }
            for snap in snaps
        ]
    ).to_csv(folder / "model_snapshots.csv", index=False)
    xlsx = folder / "polls.xlsx"
    poll_frame.to_excel(xlsx, index=False)
    db_file = DATA_DIR / "txpoll.sqlite"
    backup = folder / "txpoll-backup.sqlite"
    if db_file.exists():
        backup.write_bytes(db_file.read_bytes())
    return {key: str(path) for key, path in paths.items()} | {"polls.xlsx": str(xlsx), "backup": str(backup)}


def read_snapshot() -> dict[str, Any]:
    if not SNAPSHOT_PATH.exists():
        raise FileNotFoundError(SNAPSHOT_PATH)
    return json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
