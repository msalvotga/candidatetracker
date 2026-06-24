# Texas Candidate Lookup

Separate app for looking up and editing GOP/Dem candidates by Texas race. Uses a local SQLite database — independent from the main election night tracker (PostgreSQL).

## Data model

| Table | Purpose |
|-------|---------|
| `offices` | Every seat (HD-001…HD-150, SD-01…SD-31, SBOE, statewide, TX congressional). `category` maps to the five UI tabs. |
| `candidates` | One row per office + cycle year + party (R/D slots for the general election). |
| `election_results` | Historical results (primary, runoff, general) — can link to `candidates` or store a name for past cycles. |
| `finance_reports` | TEC/FEC filings tied to a `candidate_id`. |

## Import from Excel

```bash
npm run db:import -- "path/to/2026 TX Lege Races (1).xlsx"
```

Defaults to `~/Downloads/2026 TX Lege Races (1).xlsx` if no path is given.

The importer reads all five tabs and maps:
- **Col A** — district or office name
- **Cols B/C** — incumbent name and party
- **Cols E/F** — challenger name and party
- **July '25 COH** — column Q (House/SBOE/Statewide), **S** (Senate), **P** (Congress)
- **Jan '26 COH** — column T (House/SBOE/Statewide), **V** (Senate)

Finance is attached to the incumbent when col B is filled, otherwise to the challenger in col E.

## Run locally

```bash
cd candidate-lookup
npm install
npm run db:init    # seed 244 Texas offices (first time)
npm run dev        # API :3850, UI :5174
```

Edit GOP/Dem cells in the table; changes save on blur or Enter.

## API

- `GET /api/races?category=house&year=2026` — spreadsheet rows for a tab
- `PUT /api/candidates` — upsert candidate name for office/year/party
- `GET /api/offices/:id/history` — results + finance for one seat

Database file: `data/candidates.db` locally (gitignored). On Render, set `CANDIDATE_LOOKUP_DB_PATH=/var/data/candidates.db` with a persistent disk mounted at `/var/data`.

## Deploy on Render

| Setting | Value |
|--------|--------|
| **Root directory** | `.` (repo root) |
| **Runtime** | Node |
| **Build command** | `npm install && npm run build` |
| **Start command** | `npm start` |
| **Health check path** | `/api/health` |

**Environment variables**

| Variable | Value |
|----------|--------|
| `NODE_ENV` | `production` |
| `CANDIDATE_LOOKUP_DB_PATH` | `/var/data/candidates.db` |

**Persistent disk** (required — SQLite data survives redeploys):

| Setting | Value |
|--------|--------|
| Mount path | `/var/data` |
| Size | 1 GB (or more if needed) |

Render sets `PORT` automatically; the server listens on that port and serves the built UI from `dist/`.

First deploy seeds Texas offices automatically if the database is empty. To load spreadsheet data after deploy, run import scripts locally against a copy of the DB, or use the in-app admin UI.

Alternatively, connect this repo with the included `render.yaml` blueprint.
