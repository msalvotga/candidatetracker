"""Normalized polling schema. SQLite now; PostgreSQL via POLLING_DATABASE_URL."""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, Date, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Poll(Base):
    __tablename__ = "polls"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    external_key: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    race_key: Mapped[str] = mapped_column(String(80), index=True)
    pollster: Mapped[str] = mapped_column(String(240))
    pollster_canonical: Mapped[str] = mapped_column(String(240), index=True)
    pollster_parent_company: Mapped[str | None] = mapped_column(String(240))
    sponsor: Mapped[str | None] = mapped_column(String(240))
    sponsor_type: Mapped[str] = mapped_column(String(40), default="unknown")
    release_date: Mapped[datetime | None] = mapped_column(Date)
    field_start: Mapped[datetime | None] = mapped_column(Date)
    field_end: Mapped[datetime | None] = mapped_column(Date)
    field_midpoint: Mapped[datetime | None] = mapped_column(Date)
    state: Mapped[str] = mapped_column(String(8), default="TX")
    race: Mapped[str] = mapped_column(String(80), default="Governor")
    cycle: Mapped[int] = mapped_column(Integer, default=2026)
    sample_size: Mapped[int | None] = mapped_column(Integer)
    sample_size_provenance: Mapped[str | None] = mapped_column(Text)
    sample_type: Mapped[str | None] = mapped_column(String(24))
    mode_json: Mapped[str | None] = mapped_column(Text)
    reported_moe: Mapped[float | None] = mapped_column(Float)
    design_effect_moe: Mapped[float | None] = mapped_column(Float)
    moe_kind: Mapped[str | None] = mapped_column(String(40))
    confidence_level: Mapped[float | None] = mapped_column(Float)
    ballot_configuration: Mapped[str | None] = mapped_column(String(80))
    ballot_flags_json: Mapped[str | None] = mapped_column(Text)
    question_wording: Mapped[str | None] = mapped_column(Text)
    candidate_order: Mapped[str | None] = mapped_column(Text)
    population_description: Mapped[str | None] = mapped_column(Text)
    weighting_description: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    alternate_frames_json: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="needs_review", index=True)
    excluded: Mapped[bool] = mapped_column(Boolean, default=False)
    exclusion_reason: Mapped[str | None] = mapped_column(Text)
    duplicate_group: Mapped[str | None] = mapped_column(String(160), index=True)
    is_canonical: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    results: Mapped[list[PollResult]] = relationship(back_populates="poll", cascade="all, delete-orphan")
    sources: Mapped[list[Source]] = relationship(back_populates="poll", cascade="all, delete-orphan")
    methodology: Mapped[Methodology | None] = relationship(back_populates="poll", cascade="all, delete-orphan", uselist=False)
    subgroups: Mapped[list[SubgroupResult]] = relationship(back_populates="poll", cascade="all, delete-orphan")
    review: Mapped[PollReview | None] = relationship(back_populates="poll", cascade="all, delete-orphan", uselist=False)


class PollResult(Base):
    __tablename__ = "poll_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    poll_id: Mapped[int] = mapped_column(ForeignKey("polls.id", ondelete="CASCADE"), index=True)
    candidate: Mapped[str] = mapped_column(String(160))
    party: Mapped[str | None] = mapped_column(String(80))
    percentage: Mapped[float | None] = mapped_column(Float)
    reported_symbol: Mapped[str | None] = mapped_column(String(16))
    result_type: Mapped[str] = mapped_column(String(32))
    result_frame: Mapped[str] = mapped_column(String(32), default="headline")
    poll: Mapped[Poll] = relationship(back_populates="results")


class Source(Base):
    __tablename__ = "sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    poll_id: Mapped[int | None] = mapped_column(ForeignKey("polls.id", ondelete="CASCADE"), index=True)
    source_type: Mapped[str] = mapped_column(String(40))
    tier: Mapped[int] = mapped_column(Integer, default=5)
    url: Mapped[str] = mapped_column(Text)
    page_title: Mapped[str | None] = mapped_column(Text)
    publisher: Mapped[str | None] = mapped_column(String(240))
    retrieved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    publication_date: Mapped[datetime | None] = mapped_column(Date)
    content_hash: Mapped[str | None] = mapped_column(String(64))
    local_file_path: Mapped[str | None] = mapped_column(Text)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str | None] = mapped_column(Text)
    poll: Mapped[Poll | None] = relationship(back_populates="sources")


class Methodology(Base):
    __tablename__ = "methodologies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    poll_id: Mapped[int] = mapped_column(ForeignKey("polls.id", ondelete="CASCADE"), unique=True)
    sampling_method: Mapped[str | None] = mapped_column(Text)
    weighting_variables: Mapped[str | None] = mapped_column(Text)
    likely_voter_screen: Mapped[str | None] = mapped_column(Text)
    contact_method: Mapped[str | None] = mapped_column(Text)
    panel_provider: Mapped[str | None] = mapped_column(String(160))
    design_effect: Mapped[float | None] = mapped_column(Float)
    effective_sample_size: Mapped[float | None] = mapped_column(Float)
    reported_moe: Mapped[float | None] = mapped_column(Float)
    confidence_level: Mapped[float | None] = mapped_column(Float)
    methodology_text: Mapped[str | None] = mapped_column(Text)
    poll: Mapped[Poll] = relationship(back_populates="methodology")


class SubgroupResult(Base):
    __tablename__ = "subgroup_results"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    poll_id: Mapped[int] = mapped_column(ForeignKey("polls.id", ondelete="CASCADE"), index=True)
    dimension: Mapped[str] = mapped_column(String(80))
    subgroup_original: Mapped[str] = mapped_column(String(160))
    subgroup_normalized: Mapped[str] = mapped_column(String(160))
    compatible_group: Mapped[str | None] = mapped_column(String(160))
    candidate: Mapped[str] = mapped_column(String(160))
    percentage: Mapped[float | None] = mapped_column(Float)
    subgroup_n: Mapped[int | None] = mapped_column(Integer)
    subgroup_moe: Mapped[float | None] = mapped_column(Float)
    definition: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    poll: Mapped[Poll] = relationship(back_populates="subgroups")


class PollReview(Base):
    __tablename__ = "poll_reviews"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    poll_id: Mapped[int] = mapped_column(ForeignKey("polls.id", ondelete="CASCADE"), unique=True)
    validation_status: Mapped[str] = mapped_column(String(32), default="pending")
    validation_messages_json: Mapped[str] = mapped_column(Text, default="[]")
    auto_confidence: Mapped[float | None] = mapped_column(Float)
    reviewed_by: Mapped[str | None] = mapped_column(String(120))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    approved_for_model: Mapped[bool] = mapped_column(Boolean, default=False)
    poll: Mapped[Poll] = relationship(back_populates="review")


class PollLink(Base):
    """Duplicate / syndication relationship. The model uses one canonical poll."""

    __tablename__ = "poll_links"
    __table_args__ = (UniqueConstraint("left_poll_id", "right_poll_id", "relationship"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    left_poll_id: Mapped[int] = mapped_column(ForeignKey("polls.id", ondelete="CASCADE"), index=True)
    right_poll_id: Mapped[int] = mapped_column(ForeignKey("polls.id", ondelete="CASCADE"), index=True)
    relationship: Mapped[str] = mapped_column(String(40), default="possible_duplicate")
    similarity: Mapped[float] = mapped_column(Float, default=0)
    reasons_json: Mapped[str] = mapped_column(Text, default="[]")
    created_by: Mapped[str] = mapped_column(String(40), default="system")


class DiscoveryItem(Base):
    __tablename__ = "discovery_queue"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    url: Mapped[str] = mapped_column(Text)
    title: Mapped[str | None] = mapped_column(Text)
    publisher: Mapped[str | None] = mapped_column(String(240))
    query: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), default="new", index=True)
    notes: Mapped[str | None] = mapped_column(Text)
    content_hash: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PageVersion(Base):
    __tablename__ = "page_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    url: Mapped[str] = mapped_column(Text, index=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    retrieved_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    local_file_path: Mapped[str | None] = mapped_column(Text)
    change_note: Mapped[str | None] = mapped_column(Text)


class ModelSnapshot(Base):
    __tablename__ = "model_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    as_of: Mapped[datetime] = mapped_column(Date)
    race_key: Mapped[str] = mapped_column(String(80))
    software_version: Mapped[str] = mapped_column(String(40))
    model_version: Mapped[str] = mapped_column(String(40))
    poll_ids_json: Mapped[str] = mapped_column(Text)
    config_json: Mapped[str] = mapped_column(Text)
    estimate_json: Mapped[str] = mapped_column(Text)
    config_hash: Mapped[str] = mapped_column(String(64))


class SettingOverride(Base):
    __tablename__ = "setting_overrides"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    race_key: Mapped[str] = mapped_column(String(80), unique=True)
    config_json: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class RunLog(Base):
    __tablename__ = "run_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    kind: Mapped[str] = mapped_column(String(40))
    ok: Mapped[bool] = mapped_column(Boolean, default=False)
    message: Mapped[str | None] = mapped_column(Text)
