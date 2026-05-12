import { useEffect, useRef, useState } from "react";
import { formatNumber, formatPercent } from "../lib/voteMath";

/**
 * Renders a vote/stat figure and briefly highlights when the numeric value changes
 * (background refresh feels like digits updating in place, not a full rerender).
 */
export function LiveCount({ value }: { value: number }) {
  const prev = useRef<number | undefined>(undefined);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (prev.current === undefined) {
      prev.current = value;
      return;
    }
    if (prev.current !== value) {
      prev.current = value;
      setPulse(true);
      const t = window.setTimeout(() => setPulse(false), 900);
      return () => window.clearTimeout(t);
    }
  }, [value]);

  return <span className={`enr-liveNum ${pulse ? "enr-liveNum--pulse" : ""}`}>{formatNumber(value)}</span>;
}

export function LivePercent({ value, digits = 1 }: { value: number; digits?: number }) {
  const prev = useRef<number | undefined>(undefined);
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    if (prev.current === undefined) {
      prev.current = value;
      return;
    }
    if (prev.current !== value) {
      prev.current = value;
      setPulse(true);
      const t = window.setTimeout(() => setPulse(false), 900);
      return () => window.clearTimeout(t);
    }
  }, [value]);

  return <span className={`enr-liveNum ${pulse ? "enr-liveNum--pulse" : ""}`}>{formatPercent(value, digits)}</span>;
}
