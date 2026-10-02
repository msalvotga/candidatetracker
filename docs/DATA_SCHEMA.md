# Data schema

SQLite file: `polling/data/txpoll.sqlite`. Set `POLLING_DATABASE_URL` to a PostgreSQL URL to move the same SQLAlchemy models. The race is a column (`race_key`, `state`, `race`, `cycle`), not a hardcoded Abbott/Hinojosa table. The margin definition lives in `model.yaml`.

## polls

One row is one survey, not one web page.

`poll_id`, `external_key`, `pollster`, `pollster_canonical`, `pollster_parent_company`, `sponsor`, `sponsor_type`, `release_date`, `field_start`, `field_end`, `field_midpoint`, `state`, `race`, `cycle`, `sample_size`, `sample_size_provenance`, `sample_type` (LV, RV, Adults, Other), `mode_json` (live telephone, IVR, online panel, text-to-web, mixed, mail, other), `reported_moe`, `design_effect_moe`, `moe_kind`, `confidence_level`, `ballot_configuration`, `ballot_flags_json`, `question_wording`, `candidate_order`, `population_description`, `weighting_description`, `notes`, `alternate_frames_json`, `status`, `excluded`, `exclusion_reason`, `duplicate_group`, `is_canonical`, `created_at`, `updated_at`.

`is_canonical` is false when the row has been merged into another survey. The model skips it.

`alternate_frames_json` holds a second topline from the same survey, such as Fox’s registered-voter numbers beside the likely-voter headline. It is not a second observation.

## poll_results

`poll_id`, `candidate`, `party`, `percentage`, `reported_symbol`, `result_type`, `result_frame`.

`result_type` is `candidate`, `other`, `undecided`, `would_not_vote`, or `refused`. `reported_symbol` holds Fox’s `*` or `-` when no number was published. `result_frame` is `headline` for the topline the model reads.

## sources

`source_id`, `poll_id`, `source_type`, `tier`, `url`, `page_title`, `publisher`, `retrieved_at`, `publication_date`, `content_hash`, `local_file_path`, `is_primary`, `notes`.

The primary flag is the lowest tier, and a PDF wins ties. Changing a page later does not delete the old file.

## methodologies

`poll_id`, `sampling_method`, `weighting_variables`, `likely_voter_screen`, `contact_method`, `panel_provider`, `design_effect`, `effective_sample_size`, `reported_moe`, `confidence_level`, `methodology_text`.

## subgroup_results

`poll_id`, `dimension`, `subgroup_original`, `subgroup_normalized`, `compatible_group`, `candidate`, `percentage`, `subgroup_n`, `subgroup_moe`, `definition`, `notes`.

Normalization rules are in `polling/config/subgroup_mappings.yaml`. Unmapped labels keep their own group so they are not averaged together by accident.

## poll_reviews

`poll_id`, `validation_status`, `validation_messages_json`, `auto_confidence`, `reviewed_by`, `reviewed_at`, `approved_for_model`.

A validation **error** forces `approved_for_model` off. A warning does not. Approval is an explicit act, including the historical import’s act of approving a primary-source record while leaving the warning visible.

## poll_links

`left_poll_id`, `right_poll_id`, `relationship` (`possible_duplicate`, `duplicate`, `manual_merge`), `similarity`, `reasons_json`, `created_by`.

## discovery_queue

Search hits and changed pages. Status starts at `new` or `needs_review`. Nothing in this table is a poll until a person, or a later reviewed extractor, creates a `polls` row.

## page_versions

`url`, `content_hash`, `retrieved_at`, `local_file_path`, `change_note`. History is append-only.

## model_snapshots

`created_at`, `as_of`, `race_key`, `software_version`, `model_version`, `poll_ids_json`, `config_json`, `estimate_json`, `config_hash`.

## setting_overrides

The settings screen writes a JSON patch here, merged on top of `model.yaml`. Reset deletes the row.

## run_logs

One row per discovery or recompute, with a success flag and a short message.
