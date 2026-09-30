"""
Statewide ballot-score summary from the full RNC/TGA voter file.

2026 score: MODEL_GOV_BALLOT_SCORE (0-100, higher = Abbott).
2022 score: DRA_22G_AbbottGeneralBallot_Refresh, scaled to 0-100.
2018 has no ballot-score column in this file.
Early voting is filled later from daily VUID lists; those files are not in yet.
"""

from __future__ import annotations

import csv
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

csv.field_size_limit(min(sys.maxsize, 2_147_483_647))

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "server" / "data" / "ballot-score-summary.json"
SOURCE = Path(r"C:\Users\TGAData\Documents\fulldata1.csv")

VOTED = {"1", "2", "7"}


def voted(val: str) -> bool:
    s = (val or "").strip()
    if not s or s.upper() == "NULL" or s == "0":
        return False
    if s.isdigit():
        return s in VOTED
    return True


def score_100(val: str, scale_unit: bool) -> float | None:
    s = (val or "").strip()
    if not s or s.upper() == "NULL":
        return None
    try:
        number = float(s)
    except ValueError:
        return None
    if scale_unit and number <= 1.5:
        number *= 100.0
    return number


def district(val: str) -> str | None:
    s = (val or "").strip()
    if not s or not s.isdigit():
        return None
    number = int(s)
    if number <= 0:
        return None
    return str(number)


def county_name(val: str) -> str | None:
    s = (val or "").strip()
    if not s or s.upper() == "NULL" or not any(c.isalpha() for c in s):
        return None
    return s.upper()


def title_county(name: str) -> str:
    return " ".join(part.capitalize() for part in name.split())


class Bucket:
    def __init__(self):
        self.gov_n = 0
        self.gov_sum = 0.0
        self.gov22_n = 0
        self.gov22_sum = 0.0
        self.abb_n = 0
        self.abb_sum = 0.0

    def add(self, gov: float | None, abbott: float | None, voted22: bool):
        if gov is not None:
            self.gov_n += 1
            self.gov_sum += gov
            if voted22:
                self.gov22_n += 1
                self.gov22_sum += gov
        if voted22 and abbott is not None:
            self.abb_n += 1
            self.abb_sum += abbott


def stat(n: int, total: float):
    if n <= 0:
        return {"n": 0, "avg": None}
    return {"n": n, "avg": round(total / n, 1)}


def payload(bucket: Bucket):
    return {
        "gov2026": stat(bucket.gov_n, bucket.gov_sum),
        "gov2026Among2022Voters": stat(bucket.gov22_n, bucket.gov22_sum),
        "abbott2022": stat(bucket.abb_n, bucket.abb_sum),
        "early2026": {"n": 0, "avg": None},
        "earlyDays": [],
    }


def main():
    if not SOURCE.exists():
        raise SystemExit(f"Missing statewide file: {SOURCE}")

    buckets: dict[tuple[str, str], Bucket] = defaultdict(Bucket)
    rows = 0
    with_gov = 0

    with SOURCE.open(newline="", encoding="utf-8-sig", errors="replace") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            rows += 1
            if rows % 500_000 == 0:
                print(f"{rows:,} rows", flush=True)
            gov = score_100(row.get("MODEL_GOV_BALLOT_SCORE") or "", False)
            abbott = score_100(row.get("DRA_22G_AbbottGeneralBallot_Refresh") or "", True)
            did22 = voted(row.get("VH22G") or "")
            if gov is not None:
                with_gov += 1
            targets = [("statewide", "TX")]
            county = county_name(row.get("CountyName") or "")
            hd = district(row.get("TXHouse") or "")
            sd = district(row.get("TXSenate") or "")
            cd = district(row.get("USHouse") or "")
            if county:
                targets.append(("county", county))
            if hd:
                targets.append(("house", hd))
            if sd:
                targets.append(("senate", sd))
            if cd:
                targets.append(("congress", cd))
            for key in targets:
                buckets[key].add(gov, abbott, did22)

    def rows_for(level: str, labeler):
        out = []
        for (lvl, key), bucket in buckets.items():
            if lvl != level:
                continue
            out.append({"key": key, "label": labeler(key), **payload(bucket)})
        out.sort(key=lambda item: int(item["key"]) if item["key"].isdigit() else item["label"])
        return out

    groups = {
        "county": rows_for("county", title_county),
        "house": rows_for("house", lambda key: f"HD {key}"),
        "senate": rows_for("senate", lambda key: f"SD {key}"),
        "congress": rows_for("congress", lambda key: f"CD {key}"),
    }
    summary = {
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "score": {
            "column": "MODEL_GOV_BALLOT_SCORE",
            "label": "2026 governor ballot score",
            "scale": "0 to 100. Higher means a stronger modeled Abbott vote.",
        },
        "compare": {
            "column2022": "DRA_22G_AbbottGeneralBallot_Refresh",
            "label2022": "2022 Abbott ballot score",
            "missing2018": "This voter file has no 2018 ballot-score column and no day-by-day 2018 or 2022 early-voting list.",
        },
        "coverageNote": (
            "Every county, state House seat, state Senate seat, and congressional district on the statewide voter file. "
            "The 2026 number is the average modeled governor ballot score. "
            "The 2022 number is the average Abbott general-ballot score among people who voted in the 2022 general, shown on the same 0–100 scale. "
            "Early voting has not started. When each day's VUID list comes in, this page will add that day's average and a cumulative average, "
            "and line them up with the same early-voting day from 2018 and 2022 once those lists are loaded."
        ),
        "sourceFile": SOURCE.name,
        "voters": {
            "rows": rows,
            "with2026Score": with_gov,
            "counties": len(groups["county"]),
            "house": len(groups["house"]),
            "senate": len(groups["senate"]),
            "congress": len(groups["congress"]),
        },
        "ev": {
            "status": "not_started",
            "election": "2026 general",
            "note": "No 2026 general early-voting VUID file has been loaded.",
        },
        "statewide": payload(buckets[("statewide", "TX")]),
        "groups": groups,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(summary), encoding="utf-8")
    print(
        f"wrote {OUT} counties={summary['voters']['counties']} house={summary['voters']['house']} "
        f"senate={summary['voters']['senate']} congress={summary['voters']['congress']} rows={rows:,}",
        flush=True,
    )


if __name__ == "__main__":
    main()
