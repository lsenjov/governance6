import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __isHeartbeatRunningForTesting,
  __subscriberCountForTesting,
  subscribeToNow,
} from "./useNow";

/**
 * Heartbeat lifecycle tests for `useNow`.
 *
 * The hook itself (`useNow`) is React-flavoured and the project's
 * vitest environment is `edge-runtime` (no DOM), so we drive the
 * underlying singleton via the exported `subscribeToNow` primitive.
 * The plan's "mounting two cells results in one interval" assertion
 * is equivalent: each `<NoteTimerCell>` calls `useNow` exactly once
 * per mount, which subscribes exactly once.
 *
 * Plan: `plans/2026-04-28-gm-todo-drawer-v1.md` Task 0c.
 */
describe("useNow heartbeat singleton", () => {
  afterEach(() => {
    // Defensive cleanup so a failing test does not leak subscribers
    // into the next case. The hook itself is reference-counted, so
    // the count should already be zero after each test's own
    // unsubscribe; this assertion catches accidental leaks (Risk 11).
    expect(__subscriberCountForTesting()).toBe(0);
    expect(__isHeartbeatRunningForTesting()).toBe(false);
  });

  it("starts a single setInterval when the first subscriber arrives", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const unsub = subscribeToNow(() => {});
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(__isHeartbeatRunningForTesting()).toBe(true);
      unsub();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("does NOT start a second setInterval when a second subscriber arrives", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    try {
      const unsub1 = subscribeToNow(() => {});
      const unsub2 = subscribeToNow(() => {});
      // Two cells, one interval — the whole point of Task 0c.
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(__subscriberCountForTesting()).toBe(2);
      unsub1();
      unsub2();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it("clears the interval when the last subscriber unsubscribes", () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const unsub1 = subscribeToNow(() => {});
      const unsub2 = subscribeToNow(() => {});
      unsub1();
      // Still one subscriber left — interval must persist.
      expect(__isHeartbeatRunningForTesting()).toBe(true);
      expect(clearIntervalSpy).not.toHaveBeenCalled();
      unsub2();
      // Now zero subscribers — interval must tear down.
      expect(__isHeartbeatRunningForTesting()).toBe(false);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearIntervalSpy.mockRestore();
    }
  });

  it("is idempotent under repeated unsubscribe", () => {
    const unsub = subscribeToNow(() => {});
    unsub();
    expect(__isHeartbeatRunningForTesting()).toBe(false);
    // Second call must not throw or start a new interval.
    unsub();
    expect(__isHeartbeatRunningForTesting()).toBe(false);
  });
});
