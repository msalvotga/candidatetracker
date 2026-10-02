# Texas Governor Poll Trend

Local archive and polling-trend model for the 2026 Texas gubernatorial election. It is an analytical instrument: estimated current polling margin, and how that margin has moved. It does not estimate the probability that either candidate wins.

Open it from the election night tracker by clicking the final **R** in “Texas election night tracker”, or go directly to `/#polling`. The page is not in the navigation.

## Run

The page is served by the existing app. From the repo root:

```bash
npm run dev
```

The first load builds the archive if `polling/data/public_snapshot.json` is missing. That step needs Python 3.12+ with the packages in `polling/requirements.txt`.

Rebuild by hand:

```bash
cd polling
set PYTHONPATH=src
python -m txpoll.cli init
python -m txpoll.cli recompute
```

On PowerShell, use `$env:PYTHONPATH = "src"`.

Optional FastAPI process, for the scheduler in its own process:

```bash
python -m txpoll.cli serve
```

That listens on `http://127.0.0.1:3851`. The Vite app does not require it. Discovery runs from **Review** is not on the page yet as a button in every build; call `python -m txpoll.cli discover`. The default schedule is every 3 hours when the FastAPI process is running (`schedule.interval_hours` in `polling/config/model.yaml`).

Search needs an API key in the repo `.env`:

```
POLLING_SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=
```

`bing` and `serpapi` are the other providers. With no key, search is skipped and known pages are still fetched.

## What the number means

The headline is Abbott’s share minus Hinojosa’s share, in percentage points, smoothed across field-date midpoints. After the newest poll’s midpoint the line is held. It is not a forecast.

Only polls approved for the model are included. Aggregator-only rows stay in the review queue. One survey published in several places is one observation.

## Docs

- [Methodology](../docs/METHODOLOGY.md)
- [Assumptions](../docs/MODEL_ASSUMPTIONS.md)
- [Sources](../docs/SOURCES.md)
- [Schema](../docs/DATA_SCHEMA.md)

Tests:

```bash
cd polling
set PYTHONPATH=src
python -m unittest tests.test_calculations
```
