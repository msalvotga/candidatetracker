from __future__ import annotations

import json
from datetime import date

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .db import get_session, init_db
from .scheduler import start_scheduler
from .service import (
    add_manual_poll,
    effective_config,
    export_tables,
    import_historical,
    merge_polls,
    read_snapshot,
    recompute,
    reset_config,
    run_discovery,
    save_config_patch,
    set_approval,
    set_exclusion,
    unmerge_poll,
    SNAPSHOT_PATH,
)
from pathlib import Path

app = FastAPI(title="Texas Governor Poll Trend", version="txpoll-1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ReviewBody(BaseModel):
    approved: bool
    reviewer: str = "local"


class ExcludeBody(BaseModel):
    excluded: bool
    reason: str = ""


class MergeBody(BaseModel):
    keepId: int
    dropId: int


class ManualBody(BaseModel):
    pollster: str
    sponsor: str | None = None
    sponsor_type: str | None = None
    field_start: str | None = None
    field_end: str | None = None
    release_date: str | None = None
    sample_size: int | None = None
    sample_type: str | None = None
    reported_moe: float | None = None
    abbott: float | None = None
    hinojosa: float | None = None
    other: float | None = None
    undecided: float | None = None
    url: str | None = None
    ballot_configuration: str | None = None


@app.on_event("startup")
def startup() -> None:
    init_db()
    session = get_session()
    try:
        import_historical(session)
        if not SNAPSHOT_PATH.exists():
            recompute(session, software_version="txpoll-1")
    finally:
        session.close()
    start_scheduler()


@app.get("/api/polling/state")
def state():
    try:
        return read_snapshot()
    except FileNotFoundError:
        session = get_session()
        try:
            return recompute(session, software_version="txpoll-1")
        finally:
            session.close()


@app.post("/api/polling/settings")
def settings(patch: dict):
    session = get_session()
    try:
        save_config_patch(session, patch)
        return recompute(session, software_version="txpoll-1")
    finally:
        session.close()


@app.post("/api/polling/settings/reset")
def settings_reset():
    session = get_session()
    try:
        reset_config(session)
        return recompute(session, software_version="txpoll-1")
    finally:
        session.close()


@app.get("/api/polling/settings")
def settings_get():
    session = get_session()
    try:
        return effective_config(session)
    finally:
        session.close()


@app.post("/api/polling/polls/{poll_id}/approval")
def approval(poll_id: int, body: ReviewBody):
    session = get_session()
    try:
        set_approval(session, poll_id, body.approved, body.reviewer)
        return recompute(session, software_version="txpoll-1")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        session.close()


@app.post("/api/polling/polls/{poll_id}/exclusion")
def exclusion(poll_id: int, body: ExcludeBody):
    session = get_session()
    try:
        set_exclusion(session, poll_id, body.excluded, body.reason)
        return recompute(session, software_version="txpoll-1")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        session.close()


@app.post("/api/polling/merge")
def merge(body: MergeBody):
    session = get_session()
    try:
        merge_polls(session, body.keepId, body.dropId)
        return recompute(session, software_version="txpoll-1")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        session.close()


@app.post("/api/polling/polls/{poll_id}/unmerge")
def unmerge(poll_id: int):
    session = get_session()
    try:
        unmerge_poll(session, poll_id)
        return recompute(session, software_version="txpoll-1")
    finally:
        session.close()


@app.post("/api/polling/manual")
def manual(body: ManualBody):
    session = get_session()
    try:
        result = add_manual_poll(session, body.model_dump())
        state = recompute(session, software_version="txpoll-1")
        state["manualResult"] = result
        return state
    finally:
        session.close()


@app.post("/api/polling/discover")
def discover():
    session = get_session()
    try:
        return run_discovery(session)
    finally:
        session.close()


@app.post("/api/polling/export")
def export():
    session = get_session()
    try:
        folder = Path(__file__).resolve().parents[2] / "data" / "exports"
        return export_tables(session, folder)
    finally:
        session.close()


@app.get("/api/polling/health")
def health():
    return {"ok": True, "asOf": date.today().isoformat()}
