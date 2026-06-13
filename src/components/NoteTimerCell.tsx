import { useNow } from "../lib/useNow";

/**
 * Note timer cell — brutalist GM-only countdown.
 *
 * Renders a single `.roll-cell` square (matching `<RollSetDisplay>`'s
 * primitives) that mirrors the dice cells visually so the timer sits
 * inline with the skill check it clocks. Four UI states:
 *
 *   A. Ticking, future  — caption CLOCK, value MM stacked over SS,
 *                         neutral cell.
 *   B. Ticking, past    — caption CLOCK, value -MM stacked over SS
 *                         (capped at -99:59), failure cell with DUE
 *                         badge.
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
 * Clock-tick scope (`plans/2026-04-28-gm-todo-drawer-v1.md` Task 0c):
 * the cell subscribes unconditionally to the shared `useNow()`
 * heartbeat so EVERY visible cell ticks on the same second-boundary.
 * `done` / `due_manual` cells will re-render once per second alongside
 * `ticking` cells — the work per re-render is trivial (a few static
 * spans) and the simplification keeps the GM Todo drawer's sort
 * refinement on the same heartbeat for free.
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

/** See `RollSetDisplay`'s `Variant`: `terminal` renders the clock as an
 * inline `.term-stat` for the note's terminal prefix bar, `stacked` the
 * original square cell. */
type Variant = "stacked" | "terminal";

/**
 * Format a remaining-ms value as a `{ mm, ss }` pair so the cell can
 * render minutes on the top line and seconds below. Positive
 * remainders produce two-digit, zero-padded strings; negative
 * remainders carry the leading `-` on `mm` (the top line) and stay
 * capped at -99:59 so the cell never grows wider than three chars.
 *
 * Pure helper exported so unit tests cover the formatting rules
 * independently of the component's tick wiring (Task 15).
 */
export function formatTimerValue(remainingMs: number): {
  mm: string;
  ss: string;
} {
  const sign = remainingMs < 0 ? "-" : "";
  const absSec = Math.floor(Math.abs(remainingMs) / 1000);
  // Cap at 99:59 in either direction so the cell never grows wider
  // than two-digit minutes. Negatives get the cap as -99:59 with the
  // sign attached to the mm line.
  const totalSec = Math.min(absSec, 99 * 60 + 59);
  const mmRaw = Math.floor(totalSec / 60)
    .toString()
    .padStart(2, "0");
  const ss = (totalSec % 60).toString().padStart(2, "0");
  return { mm: `${sign}${mmRaw}`, ss };
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
  variant = "stacked",
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
  variant?: Variant;
}) {
  // Tick driver: subscribe to the shared 1Hz heartbeat. Every visible
  // cell on the page re-renders on the same second-boundary; see the
  // docblock above for the trade-off rationale.
  const now = useNow();

  const effective = deriveTimerState(timer, now);

  // Terminal variant (design 19): one inline `.term-stat` matching
  // RollSetDisplay's terminal output, so the clock sits in the same
  // mono prefix bar as the dice. Clickable for the GM, static span
  // otherwise. `done` reads mint, `overdue` / `due` read riot-red,
  // `running` is neutral white.
  if (variant === "terminal") {
    let value: string;
    let resClass = "";
    if (effective === "running" || effective === "overdue") {
      const remaining = timer.kind === "ticking" ? timer.dueAt - now : 0;
      const { mm, ss } = formatTimerValue(remaining);
      value = `${mm}:${ss}`;
      if (effective === "overdue") resClass = "fail";
    } else if (effective === "due_manual") {
      value = "due";
      resClass = "fail";
    } else {
      value = "done";
      resClass = "ok";
    }
    const inner = (
      <>
        <span className="term-key">clk</span>
        <span className={resClass ? `term-val ${resClass}` : "term-val"}>
          {value}
        </span>
      </>
    );
    if (viewerIsGm) {
      const ariaLabel = ariaLabelFor(effective);
      return (
        <button
          type="button"
          className="term-stat term-clock"
          aria-label={ariaLabel}
          title={ariaLabel}
          onClick={() => {
            if (onCycle) void onCycle();
          }}
        >
          {inner}
        </button>
      );
    }
    return (
      <span className="term-stat term-clock" aria-label="Note timer">
        {inner}
      </span>
    );
  }

  // Compute cell variant + body content + badge per state (stacked).
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
    const remaining = timer.kind === "ticking" ? timer.dueAt - now : 0;
    // Stack mm on the top line and ss on the line below. When the
    // timer is overdue the leading `-` is already part of `mm`, so
    // it stays on the top line beside the minutes. Wrapping both
    // spans in a single container collapses the pair into ONE flex
    // child of `.roll-cell`, so `justify-content: space-between` no
    // longer pushes ss away from mm when no badge is present.
    const { mm, ss } = formatTimerValue(remaining);
    valueNode = (
      <span className="note-timer-stack">
        <span className="roll-cell-value">{mm}</span>
        <span className="roll-cell-value">{ss}</span>
      </span>
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
