"""Command line for the polling archive.

Examples:
  python -m txpoll.cli init
  python -m txpoll.cli recompute
  python -m txpoll.cli discover
  python -m txpoll.cli serve
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .db import get_session, init_db
from .service import export_tables, import_historical, recompute, run_discovery


def software_version() -> str:
    package = Path(__file__).resolve().parents[3] / "package.json"
    try:
        return "app-" + json.loads(package.read_text(encoding="utf-8"))["version"]
    except (OSError, KeyError, json.JSONDecodeError):
        return "txpoll-1"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="txpoll")
    parser.add_argument("command", choices=["init", "recompute", "discover", "export", "serve", "settings", "reset-settings", "approve", "exclude", "include", "manual", "merge", "unmerge", "ensure"])
    parser.add_argument("--force-import", action="store_true")
    parser.add_argument("--id", type=int)
    parser.add_argument("--keep", type=int)
    parser.add_argument("--drop", type=int)
    parser.add_argument("--approved", choices=["yes", "no"])
    parser.add_argument("--reason", default="")
    args = parser.parse_args(argv)
    if args.command == "serve":
        import uvicorn

        uvicorn.run("txpoll.api:app", host="127.0.0.1", port=3851, reload=False)
        return 0
    init_db()
    session = get_session()
    try:
        from .service import (
            add_manual_poll,
            ensure_database,
            merge_polls,
            reset_config,
            save_config_patch,
            set_approval,
            set_exclusion,
            unmerge_poll,
        )

        if args.command == "ensure":
            print(ensure_database(session, software_version()))
        elif args.command == "init":
            summary = import_historical(session, force=args.force_import)
            snapshot = recompute(session, software_version())
            print(json.dumps({"import": summary, "label": snapshot["overview"]["label"], "polls": snapshot["overview"]["pollsInModel"]}))
        elif args.command == "recompute":
            snapshot = recompute(session, software_version())
            print(snapshot["overview"]["label"])
        elif args.command == "discover":
            print(json.dumps(run_discovery(session), indent=2))
        elif args.command == "export":
            folder = Path(__file__).resolve().parents[2] / "data" / "exports"
            print(json.dumps(export_tables(session, folder), indent=2))
        elif args.command == "settings":
            patch = json.loads(sys.stdin.read() or "{}")
            save_config_patch(session, patch)
            recompute(session, software_version())
            print("ok")
        elif args.command == "reset-settings":
            reset_config(session)
            recompute(session, software_version())
            print("ok")
        elif args.command == "approve":
            set_approval(session, args.id, args.approved == "yes", "local")
            recompute(session, software_version())
            print("ok")
        elif args.command == "exclude":
            set_exclusion(session, args.id, True, args.reason)
            recompute(session, software_version())
            print("ok")
        elif args.command == "include":
            set_exclusion(session, args.id, False, "")
            recompute(session, software_version())
            print("ok")
        elif args.command == "manual":
            payload = json.loads(sys.stdin.read() or "{}")
            print(json.dumps(add_manual_poll(session, payload)))
            recompute(session, software_version())
        elif args.command == "merge":
            merge_polls(session, args.keep, args.drop)
            recompute(session, software_version())
            print("ok")
        elif args.command == "unmerge":
            unmerge_poll(session, args.id)
            recompute(session, software_version())
            print("ok")
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    finally:
        session.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
