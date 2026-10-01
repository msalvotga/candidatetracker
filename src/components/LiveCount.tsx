import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatNumber, formatPercent } from "../lib/voteMath";

const RAISED_MS = 10_000;

/** Keep a green highlight for 10 seconds after the figure goes up. Decreases stay quiet. */
function useRaisedHighlight(value: number): boolean {
  const prev = useRef<number | undefined>(undefined);
  const timer = useRef<number | null>(null);
  const [raised, setRaised] = useState(false);

  useEffect(() => {
    if (prev.current === undefined) {
      prev.current = value;
      return;
    }
    const previous = prev.current;
    prev.current = value;
    if (!(value > previous)) return;
    setRaised(true);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setRaised(false);
    }, RAISED_MS);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  return raised;
}

function LiveFigure({ value, children }: { value: number; children: ReactNode }) {
  const raised = useRaisedHighlight(value);
  return <span className={`enr-liveNum ${raised ? "enr-liveNum--pulse" : ""}`}>{children}</span>;
}

export function LiveCount({ value }: { value: number }) {
  return <LiveFigure value={value}>{formatNumber(value)}</LiveFigure>;
}

export function LivePercent({ value, digits = 1 }: { value: number; digits?: number }) {
  return <LiveFigure value={value}>{formatPercent(value, digits)}</LiveFigure>;
}
