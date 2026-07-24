import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import { formatNoteTarget } from "./NotesDrawer";
import type { TimerNoteRow } from "../../convex/notes";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * GM Todo drawer — pure-function unit tests.
 *
 * Plan: `plans/2026-04-28-gm-todo-drawer-v1.md` Task 13.
 *
 * Covers `formatNoteTarget(row)` — JSX assembly for the target
 * context line. Tested by inspecting the React element tree directly
 * so we don't drag in a DOM (Vitest env: edge-runtime).
 *
 * The component's `useQuery` / `useMutation` wiring and the empty-state
 * / click-cell branches are covered by the broader behavioural stack
 * (manual smoke + the existing notes test corpus).
 *
 * Sort order: rows arrive from `listGameTimerNotes` already
 * ordered `createdAt` descending and the drawer renders them as-is.
 * The server-side ordering is pinned by the corresponding test in
 * `convex/notes.test.ts` ("server-side sort: createdAt desc across
 * all timer states"), so there is nothing to assert on the client.
 */

const NOTE_ID = "n1" as Id<"notes">;
const USER_ID = "u1" as Id<"users">;

function baseRow(extra: Partial<TimerNoteRow>): TimerNoteRow {
  return {
    _id: NOTE_ID,
    createdAt: 0,
    body: "x",
    visibility: "private",
    authorUserId: USER_ID,
    authorDisplayName: "GM",
    timer: { kind: "done" },
    targetKind: "game",
    replyCount: 0,
    ...extra,
  };
}

/**
 * Walk a React element tree and pull the rendered text content out.
 * `formatNoteTarget` returns small fragments — bare strings inside
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

describe("formatNoteTarget", () => {
  it("renders 'Game-wide' for game-target rows", () => {
    const node = formatNoteTarget(baseRow({ targetKind: "game" }));
    expect(extractText(node)).toBe("Game-wide");
  });

  it("renders Syndicate • Player for syndicate-target rows with a selector", () => {
    const node = formatNoteTarget(
      baseRow({
        targetKind: "syndicate",
        targetSyndicateId: "s1" as Id<"syndicates">,
        syndicateName: "Crimson Cabal",
        playerId: "p1" as Id<"players">,
        playerDisplayName: "Alice",
      }),
    );
    expect(extractText(node)).toBe("Crimson Cabal • Alice");
  });

  it("renders Syndicate • (unassigned) when no player has selected", () => {
    const node = formatNoteTarget(
      baseRow({
        targetKind: "syndicate",
        targetSyndicateId: "s1" as Id<"syndicates">,
        syndicateName: "Crimson Cabal",
      }),
    );
    expect(extractText(node)).toBe("Crimson Cabal • (unassigned)");
  });

  it("renders Minion • Syndicate • Player for minion-target rows", () => {
    const node = formatNoteTarget(
      baseRow({
        targetKind: "minion",
        targetMinionId: "m1" as Id<"minions">,
        minionName: "Smiler",
        syndicateName: "Crimson Cabal",
        playerId: "p1" as Id<"players">,
        playerDisplayName: "Alice",
      }),
    );
    expect(extractText(node)).toBe("Smiler • Crimson Cabal • Alice");
  });

  it("renders (unassigned) on the player slot for minion-target rows with no selector", () => {
    const node = formatNoteTarget(
      baseRow({
        targetKind: "minion",
        targetMinionId: "m1" as Id<"minions">,
        minionName: "Smiler",
        syndicateName: "Crimson Cabal",
      }),
    );
    expect(extractText(node)).toBe("Smiler • Crimson Cabal • (unassigned)");
  });

  it("renders an announcement excerpt", () => {
    const node = formatNoteTarget(
      baseRow({
        targetKind: "announcement",
        targetAnnouncementId: "a1" as Id<"announcements">,
        announcementExcerpt: "The first decree",
      }),
    );
    expect(extractText(node)).toBe("Announcement: The first decree");
  });

  it("renders a parent note excerpt and author for reply rows", () => {
    const node = formatNoteTarget(
      baseRow({
        targetKind: "note",
        targetNoteId: "n0" as Id<"notes">,
        parentNoteExcerpt: "Original thought",
        parentNoteAuthorDisplayName: "Alice",
      }),
    );
    expect(extractText(node)).toBe("Note: Original thought • Alice");
  });
});
