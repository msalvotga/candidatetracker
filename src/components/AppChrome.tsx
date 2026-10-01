import { EV_ROSTER_ENABLED } from "../lib/featureFlags";
import type { ElectionOption } from "../lib/dataBackend";

export type AppScreen = "dashboard" | "manual-votes" | "settings" | "ev-roster" | "ballot-score" | "county-roster";

const LINKS: { id: AppScreen; label: string; requiresRoster?: boolean }[] = [
  { id: "dashboard", label: "Home" },
  { id: "manual-votes", label: "Manual votes" },
  { id: "ev-roster", label: "Early voting rosters", requiresRoster: true },
  { id: "ballot-score", label: "Ballot scores" },
  { id: "county-roster", label: "County rosters" },
  { id: "settings", label: "Settings" },
];

export function AppChrome({
  active,
  onNavigate,
  resultStatus,
  electionOptions,
  selectedElectionId,
  onSelectElection,
  listLoading,
}: {
  active: AppScreen;
  onNavigate: (screen: AppScreen) => void;
  resultStatus?: string | null;
  electionOptions: ElectionOption[];
  selectedElectionId: string | null;
  onSelectElection: (catalogId: string | null) => void;
  listLoading: boolean;
}) {
  return (
    <>
      <header className="enr-top">
        <div className="enr-top__row">
          <div className="enr-brand">Texas election night tracker</div>
          <div className="enr-top__center">
            {resultStatus ? (
              <span className="enr-official">{resultStatus}</span>
            ) : (
              <span className="enr-official enr-official--muted">Unofficial results</span>
            )}
          </div>
          <div className="enr-top__right" />
        </div>
      </header>

      <nav className="enr-nav">
        <div className="enr-nav__left">
          {LINKS.filter((link) => !link.requiresRoster || EV_ROSTER_ENABLED).map((link) => (
            <button
              key={link.id}
              type="button"
              className={`enr-navlink ${active === link.id ? "is-active" : ""}`}
              aria-current={active === link.id ? "page" : undefined}
              onClick={() => onNavigate(link.id)}
            >
              {link.label}
            </button>
          ))}
        </div>
        <div className="enr-nav__right">
          {electionOptions.length > 0 ? (
            <div className="enr-navElectionBlock">
              <label className="enr-navElectionRow">
                <span className="enr-navElectionLabel">Election</span>
                <select
                  className="enr-navElectionSelect"
                  value={selectedElectionId ?? ""}
                  onChange={(event) => onSelectElection(event.target.value || null)}
                  disabled={listLoading}
                  aria-label="Select election"
                >
                  {electionOptions.map((option) => (
                    <option key={option.catalogId} value={option.catalogId}>
                      {option.catalogLabel}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
        </div>
      </nav>
    </>
  );
}
