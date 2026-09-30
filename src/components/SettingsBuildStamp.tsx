import { APP_VERSION, appVersionUpdatedAt } from "../lib/appVersion";
import { formatDateTime } from "../lib/voteMath";

export function SettingsBuildStamp({ timeZone = "America/Chicago" }: { timeZone?: string }) {
  const updated = appVersionUpdatedAt();
  const when = updated ? formatDateTime(updated.toISOString(), timeZone) : null;
  return (
    <div className="enr-buildStamp">
      <div className="enr-buildStamp__version">Version {APP_VERSION}</div>
      {when ? <div className="enr-buildStamp__when">Updated {when}</div> : null}
    </div>
  );
}
