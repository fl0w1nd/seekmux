import { useEffect, useRef, useState } from "react";

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Follows `target` over `ms` instead of jumping to it, so a quantity that
 * arrives in steps reads as moving. It starts at the target: only a change
 * is animated.
 */
export function useTween(target: number, ms = 600): number {
  const [value, setValue] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const from = current.current;
    if (from === target) return;
    if (reduced()) {
      current.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / ms);
      current.current = from + (target - from) * (1 - (1 - t) ** 3);
      setValue(current.current);
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

/** The clock, read every `ms` while `running`. */
export function useNow(running: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [running, ms]);
  return now;
}

/** How long `running` has been true, in ms; it stops at its last value. */
export function useElapsed(running: boolean): number {
  const [span, setSpan] = useState({ start: 0, now: 0 });
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setSpan({ start, now: start });
    const timer = setInterval(() => setSpan({ start, now: Date.now() }), 100);
    return () => clearInterval(timer);
  }, [running]);
  return span.now - span.start;
}
