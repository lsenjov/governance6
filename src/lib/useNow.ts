import { useEffect, useState } from "react";

/**
 * Shared 1Hz heartbeat hook — every caller of `useNow()` re-renders
 * once per second on the SAME `setInterval(1000)`. The interval is
 * lazily started when the first subscriber mounts and torn down when
 * the last subscriber unmounts.
 *
 * Rationale (`plans/2026-04-28-gm-todo-drawer-v1.md` Task 0c): the
 * GM Todo drawer renders many `<NoteTimerCell>`s and refines its
 * sort order on each tick. A per-instance `setInterval` per cell
 * gives drift between cells and multiplies the timer count. A
 * single module-level interval keeps every visible clock on the
 * same second-boundary.
 *
 * Trade-off: callers re-render every second whether or not their
 * displayed value actually depends on `now`. We pick the
 * unconditional variant for simplicity — `<NoteTimerCell>` in
 * `done` / `due_manual` re-renders cost a few microseconds and the
 * page renders at most a few dozen cells in practice.
 *
 * Test seam: `subscribeToNow(fn)` is exported so tests can drive
 * the singleton directly without mounting React components (the
 * vitest env is `edge-runtime`, no DOM). The plan's
 * "mounting two cells results in one interval" assertion is
 * equivalent to calling `subscribeToNow` twice and asserting
 * `globalThis.setInterval` was called once. A separate value
 * override (`__setUseNowOverrideForTesting`) lets tests pin the
 * reading returned by `useNow()` without engaging the heartbeat.
 * Production code MUST NOT call either test seam.
 */

type Subscriber = () => void;

const subscribers: Set<Subscriber> = new Set();
let intervalId: ReturnType<typeof setInterval> | null = null;
let testOverride: number | null = null;

function startIntervalIfNeeded(): void {
  if (intervalId !== null) return;
  intervalId = setInterval(() => {
    for (const fn of subscribers) {
      try {
        fn();
      } catch {
        // Subscribers should never throw, but if one does we don't
        // want a single bad subscriber to kill the whole heartbeat.
      }
    }
  }, 1000);
}

function stopIntervalIfIdle(): void {
  if (intervalId !== null && subscribers.size === 0) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Subscribe a callback to the shared heartbeat. The callback is
 * invoked once per second while subscribed. Returns an unsubscribe
 * function that, when called, removes the callback and tears down
 * the interval if no subscribers remain.
 *
 * Exported primarily so the `useNow` hook itself can wire into the
 * singleton, and so tests can drive the lifecycle without a DOM.
 */
export function subscribeToNow(fn: Subscriber): () => void {
  subscribers.add(fn);
  startIntervalIfNeeded();
  return () => {
    subscribers.delete(fn);
    stopIntervalIfIdle();
  };
}

/**
 * Returns the current `Date.now()` reading and re-renders the caller
 * on each 1-second tick of the shared heartbeat.
 *
 * In tests, if `__setUseNowOverrideForTesting` has been called with
 * a non-null value, that value is returned without subscribing.
 */
export function useNow(): number {
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (testOverride !== null) {
      // Test seam active — no real subscription required.
      return;
    }
    const unsubscribe = subscribeToNow(() => forceTick((n) => n + 1));
    return unsubscribe;
  }, []);

  return testOverride ?? Date.now();
}

/**
 * TEST SEAM. Sets a fixed `now` reading returned by every subsequent
 * `useNow()` call. While set, no real `setInterval` is started.
 *
 * Call with `null` to clear the override. Production code MUST NOT
 * call this — it bypasses the live heartbeat.
 */
export function __setUseNowOverrideForTesting(value: number | null): void {
  testOverride = value;
}

/**
 * TEST INTROSPECTION. Returns whether the shared interval is currently
 * running. Used by Vitest cleanup assertions to confirm the heartbeat
 * tears itself down on the last unsubscribe.
 */
export function __isHeartbeatRunningForTesting(): boolean {
  return intervalId !== null;
}

/**
 * TEST INTROSPECTION. Returns the current subscriber count. Used by
 * cleanup assertions to verify no leaks across test cases.
 */
export function __subscriberCountForTesting(): number {
  return subscribers.size;
}
