"""
Fill blank Category values on Abbott poll SMS reply CSVs.

Categories:
  Strongly Support, Strongly Opposed, Lean Support, Lean Opposed,
  Undecided, Moved, Deceased, Opt Out, Random

Default: only blank Category rows are filled; existing labels are kept.

Be conservative: if the ballot intent is not clear, use Random.
Opt Out only for explicit stop / unsubscribe / remove-from-list language.
"""

from __future__ import annotations

import argparse
import csv
import re
import tempfile
from collections import Counter
from pathlib import Path

CATEGORIES = (
    "Strongly Support",
    "Strongly Opposed",
    "Lean Support",
    "Lean Opposed",
    "Undecided",
    "Moved",
    "Deceased",
    "Opt Out",
    "Random",
)

# --- Poll letter codes (A=Abbott, B=Democrat, C=unsure) ---
RE_PURE_A = re.compile(r"^\s*[\"']?A+[!?.\"'\s]*$", re.I)
RE_PURE_B = re.compile(r"^\s*[\"']?B+[!?.\"'\s]*$", re.I)
RE_PURE_C = re.compile(r"^\s*[\"']?C+[!?.\"'\s]*$", re.I)

# A/B/C as a clear vote answer (not a random letter buried in hostility)
RE_VOTE_A = re.compile(
    r"^\s*A+\b|"
    r"^\s*A(?=always\b)|"
    r"\boption\s*A\b|"
    r"\babsolutely\s*[\"']?A[\"']?\b|"
    r"\breply\s*A\b|"
    r"\bA\s*[-–—:]?\s*(all\s+the\s+way|all\s+day|is\s+the\s+only|"
    r"red\b|greg\s+abbott|abbott|republican|trump|stop|and\s+take\s+me)\b|"
    r"\bit would (definitely )?be A\b|"
    r"\bwould be A\b|"
    r"\bwould of done A\b",
    re.I,
)
RE_VOTE_B = re.compile(
    r"^\s*B+\b|"
    r"\boption\s*B\b|"
    r"\breply\s*B\b|"
    r"\bB\s*[-–—:]?\s*(all\s+the\s+way|the\s+democrat|for\s+the\s+democrat)\b",
    re.I,
)
RE_VOTE_C = re.compile(
    r"^\s*C+\b|"
    r"\boption\s*C\b|"
    r"\breply\s*C\b",
    re.I,
)

# Explicit list removal only — wrong-number / "who is this" are Random
RE_OPT_OUT = re.compile(
    r"^\s*(stop+|sto|stip|stp)[!?.🛑\s]*$|"
    r"\b(stop(\s+texting)?|unsubscribe|opt[\s-]?out|"
    r"remove\s+me|take\s+me\s+off|taking\s+off\s+your\s+list|"
    r"delete\s+(my\s+)?number|lose\s+(this\s+)?number|"
    r"leave\s+me\s+(the\s+fuck\s+)?alone|"
    r"do\s+not\s+(text|contact|bother)|don'?t\s+(text|contact|bother)|"
    r"never\s+(text|contact)\s+me|don'?t\s+ever\s+text)\b",
    re.I,
)

RE_MOVED = re.compile(
    r"\b(i\s+)?moved\b|"
    r"\bmoved\s+(to|out|from)\b|"
    r"\b(don'?t|do\s+not|never)[,.\s\w]{0,40}\b(live|reside)\s+in\s+texas\b|"
    r"\bdon'?t\s+live\s+in\s+texas\s+anymore\b|"
    r"\b(out\s+of\s+(state|tx|texas)|no\s+longer\s+(in|live)\s+(in\s+)?(tx|texas))\b|"
    r"\bwon'?t\s+be\s+voting\s+in\s+texas\b|"
    r"\bvoting\s+in\s+another\s+state\b|"
    r"\bnot\s+(from|in)\s+texas\b|"
    r"\bdon'?t\s+vote\s+in\s+texas\b|"
    r"\bas\s+i\s+live\s+in\b|"
    r"\b(i\s+)?(live|living|reside)\s+in\s+(tennessee|virginia|california|florida|"
    r"oklahoma|arizona|new\s+mexico|washington|colorado|nevada|georgia|ohio|"
    r"michigan|illinois|oregon|indiana|nyc|new\s+york)\b",
    re.I,
)

RE_DEAD_RHETORIC = re.compile(
    r"\b(dead\s+democrat|good\s+democrat\s+is\s+a\s+dead|"
    r"people\s+are\s+dead\s+because|"
    r"mitch\s+mcconnell\s+is\s+dead|"
    r"red\s+till\s+i'?m\s+dead|"
    r"drop\s+dead|"
    r"texas\s+red\s+roses\s+are\s+dead|"
    r"i'?d\s+rather\s+die)\b",
    re.I,
)

RE_DECEASED = re.compile(
    r"\b(is|are|'s|has\s+been)\s+dead\b|"
    r"\bpassed\s+away\b|"
    r"\b(he|she|they)\s+(died|passed)\b|"
    r"\bno\s+longer\s+(with\s+us|living)\b|"
    r"\bdeceased\b",
    re.I,
)

RE_ABBOTT = re.compile(
    r"\babbot+t?\b|\bgovernor\s+abbott\b|\bgreg\s+abbott\b|\bhot\s*wheels\b",
    re.I,
)
RE_HINOJOSA = re.compile(r"\bhin[ao]josa\b|\bgina\s+hinojosa\b", re.I)
RE_REPUBLICAN = re.compile(r"\brepublican(s)?\b|\bgop\b|\btrump\b|\bmaga\b", re.I)
RE_DEMOCRAT = re.compile(
    r"\bdemocrat(s|ic)?\b|\bdems?\b|\bdemocratic\b|\bdemon-?c-?rat\b",
    re.I,
)

RE_NEG_ABBOTT = re.compile(
    r"\b(fuck|hate|sucks?|against|never\s+(for|vote)|jail|fascist|"
    r"piece\s+of\s+shit|worst|awful|terrible|not)\b.{0,40}"
    r"\b(abbott|abbot|greg|hot\s*wheels)\b|"
    r"\b(abbott|abbot|greg|hot\s*wheels)\b.{0,40}"
    r"\b(fuck|hate|sucks?|jail|fascist|cliff|pos|worst|awful)\b|"
    r"\bfuck\s+(greg\s+)?abbot+t?\b|"
    r"\bfuck\s+hot\s*wheels\b|"
    r"\bnever\s+vote\s+for\s+(another\s+)?republican\b|"
    r"\bnot\s+abbott\b|"
    r"\bdefinitely\s+not\s+the\s+fascist\b",
    re.I,
)

RE_LEAN_SUPPORT = re.compile(
    r"\b(lean(ing)?\s+(toward|towards|to)?\s*(a|abbott|republican)|"
    r"probably\s+(a|abbott|republican)|"
    r"might\s+vote\s+(for\s+)?(a|abbott|republican)|"
    r"most\s+likely\s+vote\s+(for\s+)?(a|abbott|republican)|"
    r"not\s+happy\s+with.{0,40}(left|democrat)|"
    r"left\s+with\s+option\s*a)\b",
    re.I,
)
RE_LEAN_OPPOSE = re.compile(
    r"\b(lean(ing)?\s+(toward|towards|to)?\s*(b|hinojosa|democrat|democratic)|"
    r"probably\s+(b|hinojosa|democrat|democratic)|"
    r"might\s+vote\s+(for\s+)?(b|hinojosa|democrat)|"
    r"most\s+likely\s+vote\s+(for\s+)?(b|hinojosa|democrat|democratic))\b",
    re.I,
)

RE_UNDECIDED = re.compile(
    r"\b(undecided|not\s+sure|unsure|don'?t\s+know|idk|"
    r"haven'?t\s+decided|neither|both\s+bad|"
    r"never\s+vote\s+for\s+either\s+party|"
    r"they\s+all\s+(are|promise)|all\s+sell\s+outs)\b",
    re.I,
)

RE_NOISE = re.compile(
    r"\bi'?m\s+driving\b|"
    r"\bsent\s+from\s+my\s+car\b|"
    r"\bno\s+sms\s+capabilities\b|"
    r"\bwho\s+do\s+you\s+plan\s+to\s+vote\s+for\s+in\s+the\s+2026\b|"
    r"\bshein\.com\b",
    re.I,
)

# Hostility / jokes with no clear ballot choice
RE_HOSTILE_OR_JOKE = re.compile(
    r"\b(fuck\s+you|go\s+fuck|fuck\s+off|fuck\s+yourself|"
    r"your\s+mom|yo\s+momma?|none\s+of\s+your\s+(fucking\s+)?business|"
    r"nunya|non\s+of\s+your\s+business)\b",
    re.I,
)


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip())


def is_pure_opt_out(text: str) -> bool:
    t = re.sub(r"[^a-z\s]", "", text.lower()).strip()
    return bool(re.fullmatch(r"(stop|sto|stip|stp|opt\s*out|unsubscribe)(\s+)*", t))


def has_clear_vote_a(text: str) -> bool:
    """True only when A is a ballot answer, not a letter inside other words."""
    if RE_PURE_A.fullmatch(text) or re.fullmatch(r"A{2,}", text, re.I):
        return True
    if RE_VOTE_A.search(text):
        # Reject "A" used as "and" typo noise inside fuck-you jokes without vote framing
        if RE_HOSTILE_OR_JOKE.search(text) and not re.search(
            r"(^\s*A+\b|\boption\s*A\b|\breply\s*A\b|\bA\s+(all|greg|abbott|republican|stop|and\s+take))",
            text,
            re.I,
        ):
            return False
        return True
    return False


def has_clear_vote_b(text: str) -> bool:
    if RE_PURE_B.fullmatch(text):
        return True
    return bool(RE_VOTE_B.search(text))


def has_clear_vote_c(text: str) -> bool:
    if RE_PURE_C.fullmatch(text):
        return True
    # "C for fuck you" is not undecided
    if RE_HOSTILE_OR_JOKE.search(text) and re.search(r"^\s*C\b.*\bfuck\b", text, re.I):
        return False
    return bool(RE_VOTE_C.search(text))


def classify(content: str, first_name: str = "") -> str:
    text = normalize(content)
    if not text:
        return "Random"

    name = (first_name or "").strip()

    # Auto-replies / spam / echoed poll prompt
    if RE_NOISE.search(text):
        return "Random"

    # Deceased (list hygiene), not political rhetoric
    if not RE_DEAD_RHETORIC.search(text) and RE_DECEASED.search(text):
        if name and re.search(
            rf"\b{re.escape(name)}\b.{{0,30}}\b(dead|passed|died|deceased)\b", text, re.I
        ):
            return "Deceased"
        if re.search(r"\b[A-Z][a-z]+\s+is\s+dead\b", text) or re.search(
            r"\b(he|she|they|this\s+person)\s+(is\s+dead|passed\s+away|died)\b", text, re.I
        ):
            return "Deceased"
        if re.search(r"\bpassed\s+away\b|\bdeceased\b|\bhas\s+been\s+dead\b", text, re.I):
            return "Deceased"

    # Moved / not a TX voter
    if RE_MOVED.search(text):
        return "Moved"

    # Clear A / B / C ballot answers (before opt-out so "A STOP" keeps the vote)
    vote_a = has_clear_vote_a(text)
    vote_b = has_clear_vote_b(text)
    vote_c = has_clear_vote_c(text)

    if vote_a and not vote_b and not vote_c:
        if RE_LEAN_SUPPORT.search(text):
            return "Lean Support"
        return "Strongly Support"
    if vote_b and not vote_a and not vote_c:
        if RE_LEAN_OPPOSE.search(text):
            return "Lean Opposed"
        return "Strongly Opposed"
    if vote_c and not vote_a and not vote_b:
        return "Undecided"

    # Opt Out — explicit only
    if is_pure_opt_out(text) or RE_OPT_OUT.search(text):
        return "Opt Out"

    # Hostility / jokes with no clear candidate/party choice → Random
    # (must run before weak keyword grabs)
    if RE_HOSTILE_OR_JOKE.search(text) and not (
        RE_ABBOTT.search(text) or RE_HINOJOSA.search(text) or RE_REPUBLICAN.search(text) or RE_DEMOCRAT.search(text)
    ):
        return "Random"

    # One-word / short clear candidate or party answers
    if re.fullmatch(r"\s*(republican|gop|trump|greg\s+abbott|abbott|abbot)\s*", text, re.I):
        return "Strongly Support"
    if re.fullmatch(r"\s*(democrat|democratic|dem|gina\s+hinojosa|hinojosa)\s*", text, re.I):
        return "Strongly Opposed"
    if re.fullmatch(r"\s*not\s+abbott\s*", text, re.I):
        return "Strongly Opposed"

    neg_abbott = bool(RE_NEG_ABBOTT.search(text))
    mentions_abbott = bool(RE_ABBOTT.search(text))
    mentions_hino = bool(RE_HINOJOSA.search(text))
    mentions_gop = bool(RE_REPUBLICAN.search(text))
    mentions_dem = bool(RE_DEMOCRAT.search(text))

    if neg_abbott:
        return "Strongly Opposed"

    # Positive/neutral bare mention of Hinojosa as the choice
    if mentions_hino and not re.search(
        r"\bhin[ao]josa\b.{0,40}\b(won'?t|doesn'?t|no\s+stance|concerns)\b", text, re.I
    ):
        return "Strongly Opposed"

    if mentions_abbott and not neg_abbott:
        # Require a clear pro signal — bare "Abbott" yes; ambiguous Abbott talk → Random
        if re.fullmatch(r"\s*(greg\s+)?abbot+t?\s*", text, re.I):
            return "Strongly Support"
        if re.search(
            r"\b(vote|voting|support|for|all\s+the\s+way|republican)\b.{0,30}\b(abbott|abbot)\b|"
            r"\b(abbott|abbot)\b.{0,30}\b(all\s+the\s+way|republican|trump)\b",
            text,
            re.I,
        ):
            return "Strongly Support"
        return "Random"

    if RE_LEAN_SUPPORT.search(text):
        return "Lean Support"
    if RE_LEAN_OPPOSE.search(text):
        return "Lean Opposed"

    # Clear party vote language only (not mere mention in a rant)
    if re.search(
        r"\b(vote|voting|support|i'?m\s+a|always)\b.{0,25}\b(republican|gop|trump)\b|"
        r"\b(republican|gop|trump)\s+(all\s+the\s+way|forever)\b",
        text,
        re.I,
    ) and not neg_abbott:
        if RE_LEAN_SUPPORT.search(text):
            return "Lean Support"
        return "Strongly Support"

    if re.search(
        r"\b(vote|voting|support|i'?m\s+a|will)\b.{0,25}\b(democrat|democratic|dems?\b)|"
        r"\b(strait|straight)\s+democrat\b",
        text,
        re.I,
    ):
        if RE_LEAN_OPPOSE.search(text) or re.search(
            r"\b(most\s+likely|probably|might|lean)\b", text, re.I
        ):
            return "Lean Opposed"
        return "Strongly Opposed"

    if RE_UNDECIDED.search(text):
        return "Undecided"

    # Everything unclear — including wrong number, who is this, jokes, rants
    return "Random"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fill blank Category values on Abbott SMS poll replies"
    )
    parser.add_argument(
        "--input",
        default=r"C:\Users\TGAData\Documents\Abbott Reply 0723 515 PM.csv",
    )
    parser.add_argument("--output", default=None)
    parser.add_argument("--inplace", action="store_true", default=True)
    parser.add_argument("--no-inplace", action="store_true")
    parser.add_argument("--only-empty", action="store_true", default=True)
    parser.add_argument(
        "--reclassify-all",
        action="store_true",
        help="Overwrite every Category with the algorithm prediction",
    )
    args = parser.parse_args()

    in_path = Path(args.input)
    inplace = args.inplace and not args.no_inplace
    only_empty = args.only_empty and not args.reclassify_all

    if args.output:
        out_path = Path(args.output)
    elif inplace:
        out_path = in_path
    else:
        out_path = in_path.with_name(in_path.stem + " - classified.csv")

    filled: Counter[str] = Counter()
    kept = 0
    filled_n = 0
    rows: list[dict[str, str]] = []

    with in_path.open(newline="", encoding="utf-8", errors="replace") as fin:
        reader = csv.DictReader(fin)
        fieldnames = list(reader.fieldnames or [])
        if "Category" not in fieldnames:
            fieldnames.append("Category")

        for row in reader:
            prior = (row.get("Category") or "").strip()
            if only_empty and prior:
                kept += 1
                rows.append(row)
                continue

            predicted = classify(row.get("CONTENT") or "", row.get("FIRST_NAME") or "")
            row["Category"] = predicted
            filled[predicted] += 1
            filled_n += 1
            rows.append(row)

    with tempfile.NamedTemporaryFile(
        mode="w",
        newline="",
        encoding="utf-8",
        delete=False,
        dir=out_path.parent,
        suffix=".tmp.csv",
    ) as tmp:
        tmp_path = Path(tmp.name)
        writer = csv.DictWriter(tmp, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)

    tmp_path.replace(out_path)

    print(f"Wrote {len(rows)} rows -> {out_path}")
    print(f"Kept existing categories: {kept}")
    print(f"Newly filled: {filled_n}")
    if filled_n:
        print("\nNew category distribution:")
        for cat in CATEGORIES:
            if filled[cat]:
                print(f"  {filled[cat]:6d}  {cat}")


if __name__ == "__main__":
    main()
