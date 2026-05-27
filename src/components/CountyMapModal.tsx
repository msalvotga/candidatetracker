import { useEffect } from "react";
import type { RaceInput } from "../types/election";
import { RaceCountyHeatmap } from "./RaceCountyHeatmap";

export function CountyMapModal({
  race,
  open,
  onClose,
}: {
  race: RaceInput;
  open: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="enr-modalBackdrop" onClick={onClose}>
      <div
        className="enr-countyMapModal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="enr-county-map-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="enr-countyMapModal__header">
          <div>
            <h3 id="enr-county-map-title" className="enr-countyMapModal__title">
              County map
            </h3>
            <p className="enr-muted enr-countyMapModal__subtitle">{race.title}</p>
          </div>
          <button type="button" className="enr-countyHistoryModal__close" onClick={onClose} aria-label="Close county map">
            ×
          </button>
        </div>
        <div className="enr-countyMapModal__body">
          <RaceCountyHeatmap race={race} embedded />
        </div>
      </div>
    </div>
  );
}
