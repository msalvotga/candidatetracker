"""Local scheduler. Default discovery interval is 3 hours and is read from model.yaml."""

from __future__ import annotations

import os

from apscheduler.schedulers.background import BackgroundScheduler

from .config import load_yaml
from .db import get_session
from .service import run_discovery

_scheduler: BackgroundScheduler | None = None


def start_scheduler() -> BackgroundScheduler | None:
    global _scheduler
    if os.environ.get("POLLING_SCHEDULER", "1") == "0":
        return None
    if _scheduler is not None:
        return _scheduler
    hours = float((load_yaml("model.yaml").get("schedule") or {}).get("interval_hours") or 3)
    scheduler = BackgroundScheduler(daemon=True)
    scheduler.add_job(_job, "interval", hours=hours, id="polling-discovery", replace_existing=True)
    scheduler.start()
    _scheduler = scheduler
    return scheduler


def _job() -> None:
    session = get_session()
    try:
        run_discovery(session)
    finally:
        session.close()
