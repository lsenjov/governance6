import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import {
  formatGmTodoTarget,
  refineOrder,
} from "./GmTodoDrawer";
import type { GmTodoNoteRow } from "../../convex/notes";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * GM Todo drawer — pure-function unit tests.
 *
 * Plan: `plans/2026-04-28-gm-todo-drawer-v1.md` Task 13.
 *
 * Covers the two pure helpers we extract from the component:
 *
 *  - `formatGmTodoTarget(row)` — JSX assembly for the target context
 *    line. Tested by inspecting the React element tree directly so we
 *    don't drag in a DOM (Vitest env: edge-runtime).
 *  - `refineOrder(rows, now)` — the client-side sort refinement. The
 *    server returns `ticking` rows by `dueAt` ascending; this helper
 *    splits them into overdue (most-overdue first) followed by future
 *    (soonest first) using the wall-clock reading.
 *
 * The component's `useQuery` / `useMutation` wiring and the empty-state
 * / click-cell branches are covered by the broader behavioural stack
 * (manual smoke + the existing notes test corpus). The pure helpers
 * alone are what this file pins.
 */

const NOTE_ID = "n1" as Id<"notes">;
const USER_ID = "u1" as Id<"users">;

function baseRow(extra: Partial<GmTodoNoteRow>): GmTodoNoteRow {
  return {
    _id: NOTE_ID,
    createdAt: 0,
    body: "x",
    visibility: "private",
    authorUserId: USER_ID,
    authorDisplayName: "GM",
    timer: { kind: "done" },
    targetKind: "game",
    ...extra,
  };
}

/**
 * Walk a React element tree and pull the rendered text content out.
 * `formatGmTodoTarget` returns small fragments — bare strings inside
 * `<span>`s separated by `•`. We don't need a real renderer; we just
 * traverse the children prop.
 */
function extractText(node: unknown): string {
  if (node === null || node === undefined || node === false || node === true) {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join("");
  }
  if (typeof node === "object" && node !== null && "props" in node) {
    const el = node as ReactElement;
    return extractText((el.props as { children?: unknown }).children);
  }
  return "";
}

describe("formatGmTodoTarget", () => {
  it("renders 'Game-wide' for game-target rows", () => {
    const node = formatGmTodoTarget(baseRow({ targetKind: "game" }));
    expect(extractText(node)).toBe("Game-wide");
  });

  it("renders Player • Syndicate for syndicate-target rows with a selector", () => {
    const node = formatGmTodoTarget(
      baseRow({
        targetKind: "syndicate",
        targetSyndicateId: "s1" as Id<"syndicates">,
        syndicateName: "Crimson Cabal",
        playerId: "p1" as Id<"players">,
        playerDisplayName: "Alice",
      }),
    );
    expect(extractText(node)).toBe("Alice • Crimson Cabal");
  });

  it("renders (unassigned) • Syndicate when no player has selected", () => {
    const node = formatGmTodoTarget(
      baseRow({
        targetKind: "syndicate",
        targetSyndicateId: "s1" as Id<"syndicates">,
        syndicateName: "Crimson Cabal",
      }),
    );
    expect(extractText(node)).toBe("(unassigned) • Crimson Cabal");
  });

  it("renders Player • Syndicate • Minion for minion-target rows", () => {
    const node = formatGmTodoTarget(
      baseRow({
        targetKind: "minion",
        targetMinionId: "m1" as Id<"minions">,
        minionName: "Smiler",
        syndicateName: "Crimson Cabal",
        playerId: "p1" as Id<"players">,
        playerDisplayName: "Alice",
      }),
    );
    expect(extractText(node)).toBe("Alice • Crimson Cabal • Smiler");
  });

  it("renders (unassigned) on the player slot for minion-target rows with no selector", () => {
    const node = formatGmTodoTarget(
      baseRow({
        targetKind: "minion",
        targetMinionId: "m1" as Id<"minions">,
        minionName: "Smiler",
        syndicateName: "Crimson Cabal",
      }),
    );
    expect(extractText(node)).toBe("(unassigned) • Crimson Cabal • Smiler");
  });
});

describe("refineOrder", () => {
  /**
   * Build a ticking row pinned to a specific `dueAt`. `_id` is used
   * as the identity check in the assertions below so each row is
   * distinguishable.
   */
  function ticking(id: string, dueAt: number): GmTodoNoteRow {
    return baseRow({
      _id: id as Id<"notes">,
      timer: { kind: "ticking", dueAt },
    });
  }

  function done(id: string, createdAt: number): GmTodoNoteRow {
    return baseRow({
      _id: id as Id<"notes">,
      timer: { kind: "done" },
      createdAt,
    });
  }

  function dueManual(id: string, createdAt: number): GmTodoNoteRow {
    return baseRow({
      _id: id as Id<"notes">,
      timer: { kind: "due_manual" },
      createdAt,
    });
  }

  it("splits ticking rows on the wall-clock boundary", () => {
    // Server input: ticking rows sorted by dueAt asc.
    const rows = [
      ticking("a", 100), // overdue at now=200 (100ms past)
      ticking("b", 150), // overdue (50ms past)
      ticking("c", 250), // future (50ms ahead)
      ticking("d", 300), // future (100ms ahead)
    ];
    // Both halves keep their dueAt-asc order from the server:
    //   - overdue: [a, b]  (a is more overdue than b — most-overdue
    //     first emerges naturally from dueAt-asc).
    //   - future:  [c, d]  (c is soonest — soonest-first emerges
    //     naturally from dueAt-asc).
    const out = refineOrder(rows, 200);
    expect(out.map((r) => r._id)).toEqual(["a", "b", "c", "d"]);
  });

  it("most-overdue first: smaller dueAt at the head of the overdue band", () => {
    const rows = [
      ticking("a", 100), // 100ms overdue at now=200
      ticking("b", 150), // 50ms overdue
    ];
    // `a` is MORE overdue than `b` (further in the past). Most-overdue
    // first means `a` precedes `b`.
    const out = refineOrder(rows, 200);
    expect(out.map((r) => r._id)).toEqual(["a", "b"]);
  });

  it("soonest-first inside the future band", () => {
    const rows = [ticking("c", 250), ticking("d", 300)];
    const out = refineOrder(rows, 200);
    expect(out.map((r) => r._id)).toEqual(["c", "d"]);
  });

  it("interleaves overdue then future then non-ticking tiers", () => {
    const rows = [
      ticking("a", 100), // overdue
      ticking("b", 250), // future
      dueManual("c", 5_000),
      done("d", 10_000),
    ];
    const out = refineOrder(rows, 200);
    expect(out.map((r) => r._id)).toEqual(["a", "b", "c", "d"]);
  });

  it("treats now === dueAt as overdue (boundary inclusive on the past side)", () => {
    // refineOrder uses `dueAt > now` to start the future band, so a
    // row with dueAt === now stays in the overdue half — matches the
    // cell's deriveTimerState boundary.
    const rows = [ticking("a", 200), ticking("b", 300)];
    const out = refineOrder(rows, 200);
    expect(out.map((r) => r._id)).toEqual(["a", "b"]);
    // `a` is in the overdue half (dueAt=now=200 ⇒ overdue), `b` in
    // the future half. Single-element overdue, single-element future
    // — order unchanged.
  });

  it("preserves non-ticking tier order verbatim from the server", () => {
    const rows = [
      dueManual("c", 9_000),
      dueManual("c2", 5_000),
      done("d", 10_000),
      done("d2", 1_000),
    ];
    const out = refineOrder(rows, 0);
    // No ticking rows; the rest pass through in server order.
    expect(out.map((r) => r._id)).toEqual(["c", "c2", "d", "d2"]);
  });

  it("returns an empty array for empty input", () => {
    expect(refineOrder([], 0)).toEqual([]);
  });
});
