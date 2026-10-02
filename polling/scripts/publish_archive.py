"""Publish this machine's poll sqlite into the live Postgres polling schema.

The local app keeps using polling/data/txpoll.sqlite. This copies that archive
into DATABASE_URL so the Render service has its own copy. Later includes on
either side stay on that side.
"""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "polling" / "src"
sys.path.insert(0, str(SRC))

TABLES = [
    "polls",
    "poll_results",
    "sources",
    "methodologies",
    "subgroup_results",
    "poll_reviews",
    "poll_links",
    "discovery_queue",
    "page_versions",
    "model_snapshots",
    "setting_overrides",
    "run_logs",
]


def database_url_from_env() -> str:
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip().strip('"')
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        raise SystemExit("DATABASE_URL is not set.")
    return url


def main() -> None:
    url = database_url_from_env()
    if "render.com" in url and "sslmode=" not in url:
        url += "&sslmode=require" if "?" in url else "?sslmode=require"
    os.environ["POLLING_DATABASE_URL"] = url

    from sqlalchemy import text

    from txpoll.db import get_engine, init_db

    init_db()
    engine = get_engine()
    sqlite_path = ROOT / "polling" / "data" / "txpoll.sqlite"
    source = sqlite3.connect(sqlite_path)
    source.row_factory = sqlite3.Row

    with engine.begin() as connection:
        boolean_columns = {
            (row.table_name, row.column_name)
            for row in connection.execute(
                text(
                    """
                    SELECT table_name, column_name
                    FROM information_schema.columns
                    WHERE table_schema = 'polling' AND data_type = 'boolean'
                    """
                )
            )
        }
        listed = ", ".join(f"polling.{table}" for table in TABLES)
        connection.execute(text(f"TRUNCATE TABLE {listed} RESTART IDENTITY CASCADE"))
        for table in TABLES:
            rows = source.execute(f"SELECT * FROM {table}").fetchall()
            if table == "poll_links":
                poll_ids = {row[0] for row in source.execute("SELECT id FROM polls")}
                rows = [
                    row
                    for row in rows
                    if row["left_poll_id"] in poll_ids and row["right_poll_id"] in poll_ids
                ]
            if not rows:
                print(f"{table} 0")
                continue
            present = {
                row.column_name
                for row in connection.execute(
                    text(
                        """
                        SELECT column_name
                        FROM information_schema.columns
                        WHERE table_schema = 'polling' AND table_name = :table
                        """
                    ),
                    {"table": table},
                )
            }
            columns = [column for column in rows[0].keys() if column in present]
            assignments = ", ".join(columns)
            placeholders = ", ".join(f":{column}" for column in columns)
            statement = text(
                f"INSERT INTO polling.{table} ({assignments}) VALUES ({placeholders})"
            )
            payload = []
            for row in rows:
                item = {}
                for column in columns:
                    value = row[column]
                    if (table, column) in boolean_columns and value is not None:
                        value = bool(value)
                    item[column] = value
                payload.append(item)
            connection.execute(statement, payload)
            connection.execute(
                text(
                    f"""
                    SELECT setval(
                        pg_get_serial_sequence('polling.{table}', 'id'),
                        (SELECT MAX(id) FROM polling.{table})
                    )
                    """
                )
            )
            print(f"{table} {len(payload)}")
    source.close()


if __name__ == "__main__":
    main()
