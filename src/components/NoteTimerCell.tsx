import { useEffect, useState } from "react";

/**
 * Note timer cell — brutalist GM-only countdown.
 *
 * Renders a single `.roll-cell` square (matching `<RollSetDisplay>`'s
 * primitives) that mirrors the dice cells visually so the timer sits
 * inline with the skill check it clocks. Four UI states:
 *
 *   A. Ticking, future  — caption CLOCK, value MM:SS, neutral cell.
 *   B. Ticking, past    — caption CLOCK, value -MM:SS (capped at -99:59),
 *                         failure cell with DUE badge.
 *   C. Done             — caption CLOCK, no value, success cell with
 *                         DONE badge.
 *   D. Due (manual)     — caption CLOCK, value `!`, failure cell with
 *                         DUE badge.
 *
 * States A and B share the same persisted record (`kind === "ticking"`);
 * the visual flip is purely a comparison of `Date.now()` to `dueAt`.
 *
 * Click semantics (GM only):
 *   A → C
 *   B → C
 *   C → D
 *   D → C
 *
 * `ticking` is intentionally unreachable post-creation — the server's
 * `cycleNoteTimer` mutation enforces this. See
 * `plans/2026-04-28-2026-04-28-note-timers-v1.md`.
 *
 * Clock-tick scope: when in `ticking`, an internal `setInterval(1000)`
 * forces a re-render so the value updates. The interval is cleared on
 * unmount and on `kind` change so non-ticking states never re-render.
 *
 * Visibility / role: this component is rendered ONLY by GM-side code
 * paths (`NoteList` checks `note.canDelete` before passing `viewerIsGm`).
 * The wire format already strips `timer` for non-GMs so the prop is
 * unreachable from a Player session.
 */

export type NoteTimerState =
  | { kind: "ticking"; dueAt: number }
  | { kind: "done" }
  | { kind: "due_manual" };

type Size = "sm" | "md";

/**
 * Format a remaining-ms value as `MM:SS` (positive remainder) or
 * `-MM:SS` (negative remainder, capped at -99:59).
 *
 * Pure helper exported so unit tests cover the formatting rules
 * independently of the component's tick wiring (Task 15).
 */
export function formatTimerValue(remainingMs: number): string {
  const sign = remainingMs < 0 ? "-" : "";
  const absSec = Math.floor(Math.abs(remainingMs) / 1000);
  // Cap at 99:59 in either direction so the cell never grows wider
  // than two-digit minutes. Negatives get the cap as -99:59.
  const totalSec = Math.min(absSec, 99 * 60 + 59);
  const mm = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, "0");
  const ss = (totalSec % 60).toString().padStart(2, "0");
  return `${sign}${mm}:${ss}`;
}

/**
 * Effective render state for a timer at a given clock reading. Pulled
 * out for unit testing (Task 15) — the reverse direction (state →
 * markup) is unit-tested via the component itself in integration.
 */
export type EffectiveTimerState = "running" | "overdue" | "done" | "due_manual";

export function deriveTimerState(
  timer: NoteTimerState,
  now: number,
): EffectiveTimerState {
  switch (timer.kind) {
    case "done":
      return "done";
    case "due_manual":
      return "due_manual";
    case "ticking":
      // Boundary: now === dueAt counts as overdue. The first instant
      // we cross zero we want the cell to flip styles, not linger on
      // the running variant.
      return now < timer.dueAt ? "running" : "overdue";
  }
}

export function NoteTimerCell({
  timer,
  viewerIsGm,
  onCycle,
  size = "sm",
}: {
  timer: NoteTimerState;
  /**
   * When `true`, the cell renders as a `<button>` and fires `onCycle`
   * on click. When `false`, the cell renders as a static `<div>` and
   * cannot be interacted with. Defence in depth — the server's
   * `cycleNoteTimer` mutation also rejects non-GMs.
   */
  viewerIsGm: boolean;
  onCycle?: () => void | Promise<void>;
  size?: Size;
}) {
  // Tick driver: only mounts a 1Hz interval while we're actually
  // ticking. Done / due_manual cells never re-render after their
  // initial paint.
  const [, force] = useState(0);
  useEffect(() => {
    if (timer.kind !== "ticking") return;
    const id = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [timer.kind]);

  const effective = deriveTimerState(timer, Date.now());

  // Compute cell variant + body content + badge per state.
  const classNames = ["roll-cell"];
  if (size === "sm") classNames.push("sm");
  if (effective === "overdue" || effective === "due_manual") {
    classNames.push("failure");
  } else if (effective === "done") {
    classNames.push("success");
  }
  if (viewerIsGm) classNames.push("note-timer-cell-clickable");

  let valueNode: React.ReactNode = null;
  if (effective === "running" || effective === "overdue") {
    const remaining =
      timer.kind === "ticking" ? timer.dueAt - Date.now() : 0;
    valueNode = (
      <span className="roll-cell-value">{formatTimerValue(remaining)}</span>
    );
  } else if (effective === "due_manual") {
    valueNode = <span className="roll-cell-value">!</span>;
  } else {
    // done — no value cell, badge alone carries the meaning.
    valueNode = null;
  }

  let badgeNode: React.ReactNode = null;
  if (effective === "overdue" || effective === "due_manual") {
    badgeNode = <span className="roll-cell-badge fail">Due</span>;
  } else if (effective === "done") {
    badgeNode = <span className="roll-cell-badge pass">Done</span>;
  }

  // Aria + click behaviour. The whole cell is interactive for the GM;
  // for Players we degrade to a plain div so screen readers don't
  // announce a useless control.
  if (viewerIsGm) {
    const ariaLabel = ariaLabelFor(effective);
    return (
      <button
        type="button"
        className={classNames.join(" ")}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={() => {
          if (onCycle) void onCycle();
        }}
      >
        <span className="roll-cell-caption">CLOCK</span>
        {valueNode}
        {badgeNode}
      </button>
    );
  }
  return (
    <div className={classNames.join(" ")} aria-label="Note timer">
      <span className="roll-cell-caption">CLOCK</span>
      {valueNode}
      {badgeNode}
    </div>
  );
}

function ariaLabelFor(state: EffectiveTimerState): string {
  switch (state) {
    case "running":
      return "Mark done";
    case "overdue":
      return "Mark done";
    case "done":
      return "Mark due";
    case "due_manual":
      return "Mark done";
  }
}
