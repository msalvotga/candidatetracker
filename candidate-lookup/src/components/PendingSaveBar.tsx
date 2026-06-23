export function PendingSaveBar({
  visible,
  saving,
  saved,
  error,
  onSave,
  onDiscard,
}: {
  visible: boolean;
  saving?: boolean;
  saved?: boolean;
  error?: string;
  onSave: () => void;
  onDiscard?: () => void;
}) {
  if (!visible && !saved) return null;

  return (
    <div
      className={`pending-save-bar${saved ? " pending-save-bar--saved" : ""}`}
      role="status"
      aria-live="polite"
    >
      {saved ? (
        <span className="pending-save-saved">Changes saved</span>
      ) : (
        <>
          <span className="pending-save-label">You have unsaved changes</span>
          <div className="pending-save-actions">
            {onDiscard ? (
              <button type="button" className="pending-save-discard" onClick={onDiscard} disabled={saving}>
                Discard
              </button>
            ) : null}
            <button type="button" className="pending-save-button" onClick={onSave} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </>
      )}
      {error && !saved ? <span className="pending-save-error">{error}</span> : null}
    </div>
  );
}

export function valuesEqual(a: number | null | undefined, b: number | null | undefined) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) < 1e-9;
}
