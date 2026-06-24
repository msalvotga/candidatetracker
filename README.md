# Texas Candidate Lookup

App for looking up and editing GOP/Dem candidates by Texas race. Uses PostgreSQL.

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

## Migrate from SQLite (one-time)

If you have an existing `candidates.db` SQLite file:

```bash
export DATABASE_URL="postgresql://..."
npm run db:migrate-from-sqlite -- path/to/candidates.db
```

Defaults to `data/candidates.db` if no path is given. This drops and recreates all tables in PostgreSQL, then copies every row.

## Run locally

```bash
npm install
export DATABASE_URL="postgresql://..."   # required
npm run db:init    # seed 244 Texas offices if the database is empty
npm run dev        # API :3850, UI :5174
```

Edit GOP/Dem cells in the table; changes save on blur or Enter.

## API

- `GET /api/races?category=house&year=2026` — spreadsheet rows for a tab
- `PUT /api/candidates` — upsert candidate name for office/year/party
- `GET /api/offices/:id/history` — results + finance for one seat

## Deploy on Render

| Setting | Value |
|--------|--------|
| **Root directory** | `.` (repo root) |
| **Runtime** | Node |
| **Build command** | `npm install --include=dev && npm run build` |
| **Start command** | `npm start` |
| **Health check path** | `/api/health` |

**Environment variables**

| Variable | Value |
|----------|--------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Render Postgres internal or external connection string |

Render sets `PORT` automatically; the server listens on that port and serves the built UI from `dist/`.

First deploy seeds Texas offices automatically if the database is empty. To load spreadsheet data after deploy, run import scripts locally (pointing at the same `DATABASE_URL`), or use the in-app admin UI.

Alternatively, connect this repo with the included `render.yaml` blueprint.
