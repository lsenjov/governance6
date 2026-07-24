// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import { resolveNoteCount } from "../hooks/useNotesCountMap";
import { buildListArgs, NoteList, type NoteListItem } from "./NoteIcon";

const GAME_ID = "game" as Id<"games">;
const NOTE_ID = "note" as Id<"notes">;

vi.mock("convex/react", () => ({
  useQuery: (_reference: unknown, args: Record<string, unknown>) =>
    Object.keys(args).length === 1
      ? {
          gameNotes: 0,
          bySyndicate: {},
          byMinion: {},
          byGrant: {},
          byGoal: {},
          byAnnouncement: {},
          byNote: { note: 2 },
        }
      : [
          {
            _id: "child-note",
            createdAt: 1,
            body: "Child thought",
            visibility: "public",
            authorUserId: "child-user",
            authorDisplayName: "Bob",
            isMine: false,
            canDelete: false,
          },
        ],
  useMutation: () => vi.fn(),
}));

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(cleanup);

describe("note reply client integration", () => {
  it("builds list args for a note target", () => {
    expect(buildListArgs(GAME_ID, { kind: "note", noteId: NOTE_ID })).toEqual({
      gameId: GAME_ID,
      targetKind: "note",
      targetNoteId: NOTE_ID,
    });
  });

  it("resolves note-target counts", () => {
    expect(
      resolveNoteCount(
        {
          gameNotes: 0,
          bySyndicate: {},
          byMinion: {},
          byGrant: {},
          byGoal: {},
          byAnnouncement: {},
          byNote: { [NOTE_ID]: 3 },
        },
        { kind: "note", noteId: NOTE_ID },
      ),
    ).toBe(3);
  });

  it("renders a reply control and direct-reply count on every note card", () => {
    const note: NoteListItem = {
      _id: NOTE_ID,
      createdAt: 0,
      body: "A thought",
      visibility: "public",
      authorUserId: "user" as Id<"users">,
      authorDisplayName: "Alice",
      isMine: false,
      canDelete: false,
    };

    render(
      <NoteList gameId={GAME_ID} notes={[note]} onDelete={() => undefined} />,
    );

    const reply = screen.getByRole("button", {
      name: "Replies: note by Alice (2)",
    });
    expect(reply.textContent).toContain("Reply");
    expect(reply.textContent).toContain("2");
  });

  it("keeps ancestor popovers open while closing a deeper branch", () => {
    const note: NoteListItem = {
      _id: NOTE_ID,
      createdAt: 0,
      body: "A thought",
      visibility: "public",
      authorUserId: "user" as Id<"users">,
      authorDisplayName: "Alice",
      isMine: false,
      canDelete: false,
    };

    render(
      <NoteList gameId={GAME_ID} notes={[note]} onDelete={() => undefined} />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Replies: note by Alice (2)",
      }),
    );
    const parentDialog = screen.getByRole("dialog", {
      name: "Notes for note by Alice",
    });

    fireEvent.click(
      within(parentDialog).getByRole("button", {
        name: "Replies: note by Bob",
      }),
    );
    expect(screen.getAllByRole("dialog")).toHaveLength(2);

    fireEvent.mouseDown(within(parentDialog).getByText("Notes"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(
      screen.getByRole("dialog", { name: "Notes for note by Alice" }),
    ).toBe(parentDialog);
  });
});
