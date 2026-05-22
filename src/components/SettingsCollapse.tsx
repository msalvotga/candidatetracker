import type { ReactNode } from "react";

export function SettingsCollapse({
  title,
  badge,
  children,
  className,
}: {
  title: string;
  badge?: string | number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={className ? `enr-settingsCollapse ${className}` : "enr-settingsCollapse"}>
      <summary className="enr-settingsCollapse__summary">
        <span>{title}</span>
        {badge != null && badge !== "" ? <span className="enr-settingsCollapse__badge">{badge}</span> : null}
      </summary>
      <div className="enr-settingsCollapse__body">{children}</div>
    </details>
  );
}
