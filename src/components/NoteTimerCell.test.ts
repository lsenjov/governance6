import { describe, expect, it } from "vitest";
import {
  deriveTimerState,
  formatTimerValue,
  type NoteTimerState,
} from "./NoteTimerCell";

/**
 * Note timers v1 — pure-function unit tests.
 *
 * Covers `formatTimerValue` (`{ mm, ss }` pair, two-digit padding,
 * leading `-` carried on `mm`, negative cap at -99:59) and
 * `deriveTimerState` (boundary at `now === dueAt`, the three
 * persisted kinds). The component's tick wiring and click semantics
 * are covered by the broader behavioural stack; these tests pin the
 * math.
 *
 * Plan: `plans/2026-04-28-2026-04-28-note-timers-v1.md` Task 15.
 */
describe("formatTimerValue", () => {
  it("formats positive remainders as { mm, ss } with zero padding", () => {
    expect(formatTimerValue(0)).toEqual({ mm: "00", ss: "00" });
    expect(formatTimerValue(1_000)).toEqual({ mm: "00", ss: "01" });
    expect(formatTimerValue(59_000)).toEqual({ mm: "00", ss: "59" });
    expect(formatTimerValue(60_000)).toEqual({ mm: "01", ss: "00" });
    expect(formatTimerValue(125_000)).toEqual({ mm: "02", ss: "05" });
    expect(formatTimerValue(30 * 60_000)).toEqual({ mm: "30", ss: "00" });
  });

  it("floors sub-second positives toward zero", () => {
    // 1500ms remaining ⇒ floor(1500/1000) = 1 second.
    expect(formatTimerValue(1_500)).toEqual({ mm: "00", ss: "01" });
    // 999ms remaining ⇒ floor(999/1000) = 0 seconds.
    expect(formatTimerValue(999)).toEqual({ mm: "00", ss: "00" });
  });

  it("carries the leading minus sign on the mm field for negatives", () => {
    expect(formatTimerValue(-1_000)).toEqual({ mm: "-00", ss: "01" });
    expect(formatTimerValue(-59_000)).toEqual({ mm: "-00", ss: "59" });
    expect(formatTimerValue(-60_000)).toEqual({ mm: "-01", ss: "00" });
    expect(formatTimerValue(-125_000)).toEqual({ mm: "-02", ss: "05" });
  });

  it("caps negative output at -99:59", () => {
    // Exactly the cap.
    const capMs = -(99 * 60 + 59) * 1000;
    expect(formatTimerValue(capMs)).toEqual({ mm: "-99", ss: "59" });
    // Past the cap — should clamp, not roll over.
    expect(formatTimerValue(capMs - 60_000)).toEqual({ mm: "-99", ss: "59" });
    expect(formatTimerValue(-1_000_000_000)).toEqual({ mm: "-99", ss: "59" });
  });

  it("caps positive output at 99:59 too (defensive)", () => {
    const capMs = (99 * 60 + 59) * 1000;
    expect(formatTimerValue(capMs)).toEqual({ mm: "99", ss: "59" });
    expect(formatTimerValue(capMs + 60_000)).toEqual({ mm: "99", ss: "59" });
  });

  it("treats absolute zero as positive (no leading minus)", () => {
    // Boundary: 0ms exactly is not negative, so no sign.
    expect(formatTimerValue(0)).toEqual({ mm: "00", ss: "00" });
  });
});

describe("deriveTimerState", () => {
  it("returns 'done' for done timers regardless of clock", () => {
    const t: NoteTimerState = { kind: "done" };
    expect(deriveTimerState(t, 0)).toBe("done");
    expect(deriveTimerState(t, 9_999_999_999)).toBe("done");
  });

  it("returns 'due_manual' for due_manual timers regardless of clock", () => {
    const t: NoteTimerState = { kind: "due_manual" };
    expect(deriveTimerState(t, 0)).toBe("due_manual");
    expect(deriveTimerState(t, 9_999_999_999)).toBe("due_manual");
  });

  it("returns 'running' when now < dueAt", () => {
    const t: NoteTimerState = { kind: "ticking", dueAt: 1_000 };
    expect(deriveTimerState(t, 0)).toBe("running");
    expect(deriveTimerState(t, 999)).toBe("running");
  });

  it("returns 'overdue' at the boundary now === dueAt", () => {
    // Spec: the moment we cross zero we want the cell to flip styles
    // immediately. `now === dueAt` is overdue, not running.
    const t: NoteTimerState = { kind: "ticking", dueAt: 1_000 };
    expect(deriveTimerState(t, 1_000)).toBe("overdue");
  });

  it("returns 'overdue' when now > dueAt", () => {
    const t: NoteTimerState = { kind: "ticking", dueAt: 1_000 };
    expect(deriveTimerState(t, 1_001)).toBe("overdue");
    expect(deriveTimerState(t, 9_999_999_999)).toBe("overdue");
  });
});
