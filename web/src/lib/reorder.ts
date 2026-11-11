import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { flushSync } from "react-dom";

type Drag = { from: number; to: number; dy: number; height: number; settling: boolean };

type Session = {
  from: number;
  to: number;
  startY: number;
  /** The rows' boxes when the drag began; the list does not move under the pointer until the drop. */
  rects: DOMRect[];
};

const settleMs = 160;

/** The classes of the row in hand: a floating layer over the rows sliding under it. */
export const lifted = "relative overflow-hidden rounded-ctl border-transparent bg-overlay shadow-raise";

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Reorders a list by dragging a handle, with a mouse or a finger, or by the
 * arrow keys on a focused handle. The rows move aside while one is dragged;
 * `onMove` is called once, on the drop.
 *
 * `onStart` runs before the rows are measured, so it can fold away what
 * would change their height.
 */
export function useReorder({ count, onMove, onStart }: { count: number; onMove: (from: number, to: number) => void; onStart?: () => void }) {
  const rows = useRef<(HTMLElement | null)[]>([]);
  const handles = useRef<(HTMLElement | null)[]>([]);
  const session = useRef<Session | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The handle to focus again once a keyboard move has rendered.
  const refocus = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (refocus.current === null) return;
    handles.current[refocus.current]?.focus();
    refocus.current = null;
  });

  // Where the dragged row lands: past every row whose middle its leading edge
  // has crossed. The drag is clamped to the list, so at either end the edge
  // has always crossed the end row's middle, whatever the rows' heights.
  const slot = (s: Session, dy: number) => {
    const mid = (r: DOMRect) => r.top + r.height / 2;
    const self = s.rects[s.from];
    let to = s.from;
    for (let i = s.from + 1; i < s.rects.length && self.bottom + dy > mid(s.rects[i]); i++) to = i;
    for (let i = s.from - 1; i >= 0 && self.top + dy < mid(s.rects[i]); i--) to = i;
    return to;
  };

  // How far the dragged row travels to sit in slot `to`.
  const offset = (s: Session, to: number) =>
    to > s.from ? s.rects[to].bottom - s.rects[s.from].bottom : to < s.from ? s.rects[to].top - s.rects[s.from].top : 0;

  const end = (commit: boolean) => {
    const s = session.current;
    if (!s) return;
    session.current = null;
    document.body.style.removeProperty("user-select");
    const to = commit ? s.to : s.from;
    const finish = () => {
      setDrag(null);
      if (to !== s.from) onMove(s.from, to);
    };
    if (reduced()) return finish();
    setDrag({ from: s.from, to, dy: offset(s, to), height: s.rects[s.from].height, settling: true });
    window.setTimeout(finish, settleMs);
  };

  const handle = (index: number) => ({
    ref: (el: HTMLElement | null) => {
      handles.current[index] = el;
    },
    disabled: count < 2,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0 || count < 2 || session.current || drag) return;
      e.preventDefault();
      if (onStart) flushSync(onStart);
      const rects = rows.current.slice(0, count).map((row) => row?.getBoundingClientRect() ?? new DOMRect());
      session.current = { from: index, to: index, startY: e.clientY, rects };
      e.currentTarget.setPointerCapture(e.pointerId);
      document.body.style.userSelect = "none";
      setDrag({ from: index, to: index, dy: 0, height: rects[index].height, settling: false });
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const s = session.current;
      if (!s) return;
      const first = s.rects[0];
      const last = s.rects[s.rects.length - 1];
      const self = s.rects[s.from];
      const dy = Math.min(last.bottom - self.bottom, Math.max(first.top - self.top, e.clientY - s.startY));
      s.to = slot(s, dy);
      setDrag({ from: s.from, to: s.to, dy, height: self.height, settling: false });
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onLostPointerCapture: () => end(true),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const by = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (by === 0 || session.current) return;
      e.preventDefault();
      const to = index + by;
      if (to < 0 || to >= count) return;
      refocus.current = to;
      onMove(index, to);
    },
  });

  /** The ref and the style of row `index`. */
  const row = (index: number): { ref: (el: HTMLElement | null) => void; style: CSSProperties | undefined } => {
    const ref = (el: HTMLElement | null) => {
      rows.current[index] = el;
    };
    if (!drag) return { ref, style: undefined };
    if (index === drag.from) {
      return {
        ref,
        style: {
          transform: `translateY(${drag.dy}px)`,
          transition: drag.settling ? `transform ${settleMs}ms var(--ease-settle)` : "none",
          position: "relative",
          zIndex: 10,
        },
      };
    }
    const shift = drag.from < index && index <= drag.to ? -drag.height : drag.to <= index && index < drag.from ? drag.height : 0;
    return { ref, style: { transform: shift ? `translateY(${shift}px)` : undefined, transition: "transform 200ms var(--ease-settle)" } };
  };

  /** The index of the row being dragged or settling into its slot. */
  return { handle, row, dragging: drag?.from ?? null };
}

export type Reorder = ReturnType<typeof useReorder>;
