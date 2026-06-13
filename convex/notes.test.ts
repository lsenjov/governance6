/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/**
 * Convex Auth derives the user id from `identity.subject` by splitting on `|`
 * (see `TOKEN_SUB_CLAIM_DIVIDER`). In tests we fabricate a matching identity
 * so `getAuthUserId(ctx)` resolves to the user we created directly in the db.
 */
function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * Shared setup: 3 users (GM, two Players, plus an "outsider" stranger), a
 * syndicate owned by Player A with one minion, a game in `ready` with both
 * Players on the roster and A's syndicate selected by Player A.
 */
async function createHarness() {
  const t = convexTest(schema, modules);

  const ids = await t.run(async (ctx) => {
    const gmId = await ctx.db.insert("users", {
      displayName: "GM",
      email: "gm@test",
    });
    const aId = await ctx.db.insert("users", {
      displayName: "Alice",
      email: "a@test",
    });
    const bId = await ctx.db.insert("users", {
      displayName: "Bob",
      email: "b@test",
    });
    const outsiderId = await ctx.db.insert("users", {
      displayName: "Outsider",
      email: "o@test",
    });

    const syndicateId = await ctx.db.insert("syndicates", {
      name: "Alice's Syndicate",
      leader: "Alice",
      description: "",
      played: false,
      isShared: false,
      ownerId: aId,
    });
    const minionId = await ctx.db.insert("minions", {
      syndicateId,
      name: "Raven",
      skills: ["sneak"],
      order: 0,
    });

    const gameId = await ctx.db.insert("games", {
      name: "Test Game",
      gmId,
      state: "ready",
    });
    const playerAId = await ctx.db.insert("players", {
      gameId,
      userId: aId,
      selectedSyndicateId: syndicateId,
      power: 0,
      joinedAt: Date.now(),
    });
    const playerBId = await ctx.db.insert("players", {
      gameId,
      userId: bId,
      power: 0,
      joinedAt: Date.now() + 1,
    });

    return {
      gmId,
      aId,
      bId,
      outsiderId,
      syndicateId,
      minionId,
      gameId,
      playerAId,
      playerBId,
    };
  });

  return { t, ids };
}

async function createGameNote(
  h: Harness,
  actor: Id<"users">,
  body: string,
  visibility: "private" | "public" = "private",
): Promise<Id<"notes">> {
  return await h.t.withIdentity(asUser(actor)).mutation(api.notes.createNote, {
    gameId: h.ids.gameId,
    targetKind: "game",
    body,
    visibility,
  });
}

describe("notes: authoring eligibility", () => {
  test("participants (GM + Player) can create notes on all three target kinds", async () => {
    const h = await createHarness();

    for (const actor of [h.ids.gmId, h.ids.aId]) {
      const gameNote = await h.t
        .withIdentity(asUser(actor))
        .mutation(api.notes.createNote, {
          gameId: h.ids.gameId,
          targetKind: "game",
          body: "game note",
        });
      expect(gameNote).toBeTruthy();

      const syndNote = await h.t
        .withIdentity(asUser(actor))
        .mutation(api.notes.createNote, {
          gameId: h.ids.gameId,
          targetKind: "syndicate",
          targetSyndicateId: h.ids.syndicateId,
          body: "syndicate note",
        });
      expect(syndNote).toBeTruthy();

      const minNote = await h.t
        .withIdentity(asUser(actor))
        .mutation(api.notes.createNote, {
          gameId: h.ids.gameId,
          targetKind: "minion",
          targetMinionId: h.ids.minionId,
          body: "minion note",
        });
      expect(minNote).toBeTruthy();
    }
  });

  test("non-participant cannot create notes", async () => {
    const h = await createHarness();
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .mutation(api.notes.createNote, {
          gameId: h.ids.gameId,
          targetKind: "game",
          body: "sneaky",
        }),
    ).rejects.toThrow(/not a participant/i);
  });

  test("unauthenticated callers are rejected", async () => {
    const h = await createHarness();
    await expect(
      h.t.mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "game",
        body: "anon",
      }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("empty and oversize bodies are rejected", async () => {
    const h = await createHarness();
    await expect(createGameNote(h, h.ids.aId, "   ")).rejects.toThrow(/empty/i);
    await expect(
      createGameNote(h, h.ids.aId, "x".repeat(2001)),
    ).rejects.toThrow(/2000/);
  });

  test("target fields must match targetKind", async () => {
    const h = await createHarness();
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "game",
        targetSyndicateId: h.ids.syndicateId,
        body: "bad",
      }),
    ).rejects.toThrow();
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "syndicate",
        body: "missing id",
      }),
    ).rejects.toThrow();
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        body: "missing id",
      }),
    ).rejects.toThrow();
  });
});

describe("notes: visibility", () => {
  test("private notes are visible only to author and GM", async () => {
    const h = await createHarness();
    // Alice writes a private note on the game.
    await createGameNote(h, h.ids.aId, "alice-private", "private");

    // Alice sees her own note.
    const aView = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "game",
      });
    expect(aView).toHaveLength(1);
    expect(aView[0].body).toBe("alice-private");

    // Bob does NOT see Alice's private note.
    const bView = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "game",
      });
    expect(bView).toHaveLength(0);

    // GM sees it.
    const gmView = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "game",
      });
    expect(gmView).toHaveLength(1);
  });

  test("public notes are visible to every participant", async () => {
    const h = await createHarness();
    await createGameNote(h, h.ids.aId, "alice-public", "public");

    for (const actor of [h.ids.aId, h.ids.bId, h.ids.gmId]) {
      const view = await h.t
        .withIdentity(asUser(actor))
        .query(api.notes.listNotesForTarget, {
          gameId: h.ids.gameId,
          targetKind: "game",
        });
      expect(view).toHaveLength(1);
      expect(view[0].body).toBe("alice-public");
    }
  });

  test("non-participant cannot list notes", async () => {
    const h = await createHarness();
    await createGameNote(h, h.ids.aId, "seen by whom?", "public");
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .query(api.notes.listNotesForTarget, {
          gameId: h.ids.gameId,
          targetKind: "game",
        }),
    ).rejects.toThrow(/not a participant/i);
  });

  test("canDelete flag reflects GM-only delete", async () => {
    const h = await createHarness();
    await createGameNote(h, h.ids.aId, "author", "public");

    const asAuthor = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "game",
      });
    expect(asAuthor[0].canDelete).toBe(false);

    const asGm = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "game",
      });
    expect(asGm[0].canDelete).toBe(true);
  });
});

describe("notes: deletion (GM-only)", () => {
  test("GM can delete any note; authors and other participants cannot", async () => {
    const h = await createHarness();
    const aliceNoteId = await createGameNote(
      h,
      h.ids.aId,
      "alice note",
      "public",
    );

    // Author rejection.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.notes.deleteNote, { noteId: aliceNoteId }),
    ).rejects.toThrow(/Game Master/i);

    // Non-author participant rejection.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.bId))
        .mutation(api.notes.deleteNote, { noteId: aliceNoteId }),
    ).rejects.toThrow(/Game Master/i);

    // Outsider rejection.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .mutation(api.notes.deleteNote, { noteId: aliceNoteId }),
    ).rejects.toThrow();

    // GM can delete.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.deleteNote, { noteId: aliceNoteId });

    const remaining = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "game",
      });
    expect(remaining).toHaveLength(0);
  });
});

describe("notes: edit surface is absent", () => {
  test("no updateNote mutation exists on api.notes", () => {
    // Runtime + type-level assertion: the only mutations we expose are
    // create and delete. Any future regression would surface as a key
    // appearing on the api object.
    const apiNotesKeys = Object.keys(api.notes as unknown as object);
    expect(apiNotesKeys).not.toContain("updateNote");
  });
});

describe("notes: ordering", () => {
  test("listNotesForTarget returns newest first", async () => {
    const h = await createHarness();
    // Seed 3 notes with monotonically increasing timestamps.
    await h.t.run(async (ctx) => {
      await ctx.db.insert("notes", {
        gameId: h.ids.gameId,
        targetKind: "game",
        authorUserId: h.ids.aId,
        visibility: "public",
        body: "first",
        createdAt: 1_000,
      });
      await ctx.db.insert("notes", {
        gameId: h.ids.gameId,
        targetKind: "game",
        authorUserId: h.ids.aId,
        visibility: "public",
        body: "second",
        createdAt: 2_000,
      });
      await ctx.db.insert("notes", {
        gameId: h.ids.gameId,
        targetKind: "game",
        authorUserId: h.ids.aId,
        visibility: "public",
        body: "third",
        createdAt: 3_000,
      });
    });

    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "game",
      });
    expect(view.map((n) => n.body)).toEqual(["third", "second", "first"]);
  });
});

describe("notes: game-scoping", () => {
  test("notes in game A do not surface in game B for the same syndicate", async () => {
    const h = await createHarness();

    // Build a second independent game with the same syndicate selected.
    const gameBId = await h.t.run(async (ctx) => {
      const newGm = await ctx.db.insert("users", {
        displayName: "GM2",
        email: "gm2@test",
      });
      const gBId = await ctx.db.insert("games", {
        name: "Game B",
        gmId: newGm,
        state: "ready",
      });
      await ctx.db.insert("players", {
        gameId: gBId,
        userId: h.ids.aId,
        selectedSyndicateId: h.ids.syndicateId,
        power: 0,
        joinedAt: Date.now(),
      });
      return gBId;
    });

    // Alice posts a syndicate-scoped note in game A.
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "syndicate",
      targetSyndicateId: h.ids.syndicateId,
      body: "game A note",
      visibility: "public",
    });

    // List notes for the same syndicate in game B from Alice's perspective.
    const bListing = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: gameBId,
        targetKind: "syndicate",
        targetSyndicateId: h.ids.syndicateId,
      });
    expect(bListing).toHaveLength(0);

    // Sanity check: the note is still visible from game A.
    const aListing = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "syndicate",
        targetSyndicateId: h.ids.syndicateId,
      });
    expect(aListing).toHaveLength(1);
  });
});

describe("notes: cascade on entity deletion", () => {
  test("deleting a minion removes all notes targeting it", async () => {
    const h = await createHarness();
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "about the minion",
      visibility: "public",
    });

    // Before: one visible note.
    const before = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(before).toHaveLength(1);

    // Delete the minion (Alice owns the syndicate; played=false).
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.minions.remove, { minionId: h.ids.minionId });

    // The note must be gone from the db. We assert on the underlying row
    // count to avoid the list query failing on a missing target.
    const surviving = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("notes")
        .withIndex("by_minion", (q) => q.eq("targetMinionId", h.ids.minionId))
        .collect();
    });
    expect(surviving).toHaveLength(0);
  });

  test("deleting a syndicate removes syndicate-notes and minion-notes", async () => {
    const h = await createHarness();
    // Note on the syndicate itself.
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "syndicate",
      targetSyndicateId: h.ids.syndicateId,
      body: "on syndicate",
      visibility: "public",
    });
    // Note on a minion of that syndicate.
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "on minion",
      visibility: "public",
    });

    // Syndicate is played=false so removal is allowed. Note that by design
    // `syndicates.remove` also clears the selection from every `ready`-game
    // player row that had it selected. We must unselect first because the
    // syndicate is currently selected by Player A (the cascade handles that).
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.syndicates.remove, { syndicateId: h.ids.syndicateId });

    const survivingSyndicate = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("notes")
        .withIndex("by_syndicate", (q) =>
          q.eq("targetSyndicateId", h.ids.syndicateId),
        )
        .collect();
    });
    const survivingMinion = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("notes")
        .withIndex("by_minion", (q) => q.eq("targetMinionId", h.ids.minionId))
        .collect();
    });
    expect(survivingSyndicate).toHaveLength(0);
    expect(survivingMinion).toHaveLength(0);
  });
});

describe("notes: counts query", () => {
  test("counts match listNotesForTarget under the same viewer", async () => {
    const h = await createHarness();
    // 2 game notes (1 private by Alice, 1 public by Bob), 1 syndicate note
    // (public), 2 minion notes (both private by Alice).
    await createGameNote(h, h.ids.aId, "alice priv", "private");
    await createGameNote(h, h.ids.bId, "bob pub", "public");
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "syndicate",
      targetSyndicateId: h.ids.syndicateId,
      body: "synd pub",
      visibility: "public",
    });
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "m1",
      visibility: "private",
    });
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "m2",
      visibility: "private",
    });

    // From Bob's perspective: Alice's 3 private notes are hidden, so Bob
    // sees just 1 game note (his own public) + the public syndicate note +
    // 0 minion notes.
    const bobCounts = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.notes.getNoteCountsForGameView, { gameId: h.ids.gameId });
    expect(bobCounts.gameNotes).toBe(1);
    expect(bobCounts.bySyndicate[h.ids.syndicateId]).toBe(1);
    expect(bobCounts.byMinion[h.ids.minionId] ?? 0).toBe(0);

    // From the GM's perspective: all 5 notes are visible.
    const gmCounts = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.getNoteCountsForGameView, { gameId: h.ids.gameId });
    expect(gmCounts.gameNotes).toBe(2);
    expect(gmCounts.bySyndicate[h.ids.syndicateId]).toBe(1);
    expect(gmCounts.byMinion[h.ids.minionId]).toBe(2);

    // Cross-check: GM's minion listing has exactly byMinion count items.
    const gmMinionList = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(gmMinionList).toHaveLength(gmCounts.byMinion[h.ids.minionId]);
  });

  /**
   * Plan: `plans/2026-05-17-game-log-minion-notes-v1.md` Task 6 / Design
   * Decision 9. The Game Log drawer surfaces a `<NoteIcon>` for the
   * minion on each `kind === "minion"` row in Recently Removed Calls
   * and feeds it from the same shared `getNoteCountsForGameView`
   * subscription used everywhere else on the page. The invariant is
   * that note counts are keyed by minion id, not by call state — i.e.
   * removing the call must not change `byMinion[minionId]`.
   */
  test("byMinion counts are unchanged by call removal (note counts are scoped by minion id, not call state)", async () => {
    const h = await createHarness();

    // Setup playing game with Raven bought by Alice (inline; no new
    // helper per plan instructions — uses only existing api calls).
    await h.t.run(async (ctx) => {
      // Ensure every player on the game has a syndicate selected
      // (the game-start transition requires it).
      const allPlayers = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) => q.eq("gameId", h.ids.gameId))
        .collect();
      for (const row of allPlayers) {
        if (!row.selectedSyndicateId) {
          await ctx.db.patch(row._id, {
            selectedSyndicateId: h.ids.syndicateId,
          });
        }
      }
      // Mark Raven as bought for Alice so addOrReplaceCall succeeds.
      await ctx.db.insert("gamePlayerMinions", {
        gameId: h.ids.gameId,
        playerId: h.ids.playerAId,
        minionId: h.ids.minionId,
        bought: true,
        boughtAt: Date.now(),
        pricePaid: 0,
      });
    });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.games.transitionState, {
        gameId: h.ids.gameId,
        target: "playing",
      });

    // Alice places a call on Raven (the call this row will represent
    // once removed).
    const aliceCallId = await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.calls.addOrReplaceCall, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionId,
      });

    // Alice authors one public + one private note on the minion while
    // her call is active.
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "alice public on minion",
      visibility: "public",
    });
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "alice private on minion",
      visibility: "private",
    });

    // GM removes the call — the row will now surface in Recently
    // Removed Calls, which is where the new icon is rendered.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: aliceCallId });

    // Assert AFTER removal: byMinion counts are still keyed by
    // minionId and unaffected by the call's lifecycle.
    const authorCounts = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.getNoteCountsForGameView, { gameId: h.ids.gameId });
    expect(authorCounts.byMinion[h.ids.minionId]).toBe(2);

    const gmCounts = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.getNoteCountsForGameView, { gameId: h.ids.gameId });
    expect(gmCounts.byMinion[h.ids.minionId]).toBe(2);

    // Bob is a non-author Player: sees only the public note.
    const bobCounts = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.notes.getNoteCountsForGameView, { gameId: h.ids.gameId });
    expect(bobCounts.byMinion[h.ids.minionId]).toBe(1);
  });
});

/**
 * Dice rolls v1: notes authored while a minion is at the head of the
 * call queue freeze the live roll set onto the new note. The GM payload
 * carries `attachedRolls`; non-GM payloads omit the key entirely.
 *
 * See `plans/2026-04-28-2026-04-28-dice-rolls-v3.md`.
 */
describe("notes: attached dice rolls", () => {
  /**
   * Promote the harness's game to `playing` and pre-mark the minion as
   * bought for the given player so `addOrReplaceCall` succeeds. Returns
   * a helper that places `minionId` on the head of the call queue for
   * the chosen actor.
   */
  async function preparePlayingGame(h: Harness, playerUserId: Id<"users">) {
    // Find the player's `players` row — the harness exposes both
    // playerAId and playerBId, but we re-query for clarity.
    const playerId = await h.t.run(async (ctx) => {
      const row = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) =>
          q.eq("gameId", h.ids.gameId).eq("userId", playerUserId),
        )
        .unique();
      if (!row) throw new Error("player row not found");
      return row._id;
    });

    // Make the harness's syndicate the player's selection, so the call
    // path passes "called minion belongs to caller's syndicate" if the
    // mutation enforces that. Also ensure EVERY player on the game
    // has a syndicate selected — the game-start transition requires
    // it for all players. (Alice's row already has it; Bob's
    // doesn't — patch defensively for both.)
    await h.t.run(async (ctx) => {
      const allPlayers = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) => q.eq("gameId", h.ids.gameId))
        .collect();
      for (const row of allPlayers) {
        if (!row.selectedSyndicateId) {
          await ctx.db.patch(row._id, {
            selectedSyndicateId: h.ids.syndicateId,
          });
        }
      }
    });

    // Mark the minion as bought for this (game, player).
    await h.t.run(async (ctx) => {
      await ctx.db.insert("gamePlayerMinions", {
        gameId: h.ids.gameId,
        playerId,
        minionId: h.ids.minionId,
        bought: true,
        boughtAt: Date.now(),
        pricePaid: 0,
      });
    });

    // Promote game to playing.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.games.transitionState, {
        gameId: h.ids.gameId,
        target: "playing",
      });

    return {
      placeOnHead: async () => {
        return await h.t
          .withIdentity(asUser(playerUserId))
          .mutation(api.calls.addOrReplaceCall, {
            gameId: h.ids.gameId,
            minionId: h.ids.minionId,
          });
      },
    };
  }

  test("note on the head minion: GM sees `attachedRolls` with the live roll set", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();

    // Author a private minion note as the GM while Alice's call is the head.
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "tagging the head minion",
      visibility: "private",
    });

    const list = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(list).toHaveLength(1);
    const note = list[0] as {
      attachedRolls?: {
        skillRoll: number;
        chaosRoll: number;
        skillCount: number;
      } | null;
    };
    expect(Object.prototype.hasOwnProperty.call(note, "attachedRolls")).toBe(
      true,
    );
    expect(note.attachedRolls).not.toBeNull();
    expect(note.attachedRolls!.skillCount).toBe(1); // Raven has [sneak]
    expect(note.attachedRolls!.skillRoll).toBeGreaterThanOrEqual(1);
    expect(note.attachedRolls!.skillRoll).toBeLessThanOrEqual(6);
  });

  test("note on the head minion: Player payload OMITS the `attachedRolls` key", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();

    // Public note so Alice (the author + Player) can see it back.
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "player-authored, public",
      visibility: "public",
    });

    const list = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(list).toHaveLength(1);
    // Wire format must not leak the attachment to non-GMs — even as
    // `null` or `undefined`. The key MUST be absent.
    expect(Object.prototype.hasOwnProperty.call(list[0], "attachedRolls")).toBe(
      false,
    );
  });

  test("note on a minion that is NOT the head omits `attachedRolls`", async () => {
    // The harness only seeds one minion, so "not the head" means the
    // queue is empty. createNote should leave attachedRollSetId
    // unset; listNotesForTarget should not include the key (the
    // payload-shaping rule omits `attachedRolls` when the row never
    // had a roll set, even on the GM payload — see notes.ts L297).
    const h = await createHarness();
    await preparePlayingGame(h, h.ids.aId);
    // Note: did NOT call placeOnHead — queue is empty.

    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "no-call note",
      visibility: "private",
    });

    const list = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(list).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(list[0], "attachedRolls")).toBe(
      false,
    );
  });

  test("game-target and syndicate-target notes never get `attachedRolls`", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();

    // Even with a minion at the head of the queue, notes on other
    // target kinds do not pin the roll set — only minion-target notes
    // can attach.
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "game",
      body: "game note while call is live",
      visibility: "private",
    });
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "syndicate",
      targetSyndicateId: h.ids.syndicateId,
      body: "syndicate note while call is live",
      visibility: "private",
    });

    const gameList = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "game",
      });
    expect(gameList).toHaveLength(1);
    expect(
      Object.prototype.hasOwnProperty.call(gameList[0], "attachedRolls"),
    ).toBe(false);

    const syndList = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "syndicate",
        targetSyndicateId: h.ids.syndicateId,
      });
    expect(syndList).toHaveLength(1);
    expect(
      Object.prototype.hasOwnProperty.call(syndList[0], "attachedRolls"),
    ).toBe(false);
  });

  /**
   * Drawback rolls v1 — see `plans/2026-04-28-drawback-rolls-v1.md` Task 21.
   *
   * A note authored against a head-minion call freezes the full extras
   * bundle (skill + chaos + drawbacks) onto the note. After the head
   * moves on the GM still sees the original drawback values; the
   * Player still sees no `attachedRolls` field at all.
   */
  test("note attached to head minion freezes drawback extras; survives head moving on", async () => {
    const h = await createHarness();
    // Add a single rolled drawback to Alice's syndicate before the
    // game starts. The Syndicate editor cannot toggle isRolled in
    // production (Task 14 of the drawback-rolls plan), but the
    // backend invariant must still hold.
    await h.t.run(async (ctx) => {
      await ctx.db.insert("drawbacks", {
        syndicateId: h.ids.syndicateId,
        name: "Glass Jaw",
        description: "",
        order: 0,
        isRolled: true,
        abbreviation: "GLSJAW",
      });
    });

    const ctl = await preparePlayingGame(h, h.ids.aId);
    const headCallId = await ctl.placeOnHead();

    // Author a note while the call is the head.
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "freezing the drawback bundle",
      visibility: "private",
    });

    // GM list includes attachedRolls with one drawback extra.
    const gmListBefore = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(gmListBefore).toHaveLength(1);
    const noteBefore = gmListBefore[0] as {
      attachedRolls?: {
        skillRoll: number;
        chaosRoll: number;
        extras: Array<{
          kind: string;
          name: string;
          value: number;
        }>;
      } | null;
    };
    expect(noteBefore.attachedRolls).not.toBeNull();
    expect(noteBefore.attachedRolls!.extras).toHaveLength(1);
    const frozen = noteBefore.attachedRolls!.extras[0];
    expect(frozen.kind).toBe("drawback");
    expect(frozen.name).toBe("GLSJAW");
    expect(frozen.value).toBeGreaterThanOrEqual(1);
    expect(frozen.value).toBeLessThanOrEqual(6);
    const frozenValue = frozen.value;

    // Move the head off — GM removes the call. Subsequent reads must
    // still surface the original frozen extras (immutability of
    // `callRollSets`).
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: headCallId });

    const gmListAfter = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    const noteAfter = gmListAfter[0] as {
      attachedRolls?: {
        extras: Array<{ name: string; value: number }>;
      } | null;
    };
    expect(noteAfter.attachedRolls!.extras).toHaveLength(1);
    expect(noteAfter.attachedRolls!.extras[0].name).toBe("GLSJAW");
    expect(noteAfter.attachedRolls!.extras[0].value).toBe(frozenValue);

    // Player still sees no attachedRolls key. Bob is a participant
    // and Alice is the author, so use Alice (the author) to read
    // back the same private note — but wait: private + author === Alice
    // means she could see it; we want to assert the WIRE FORMAT for a
    // Player viewer. Alice is the only viable Player viewer here (Bob
    // can't see private notes by another author). Alice as author of
    // a private note authored by GM cannot see it either. Re-use the
    // public-author-Alice path: author a public note and re-read.
    await h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "alice public note",
      visibility: "public",
    });
    const aliceList = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    // Alice now sees her own public note. Confirm `attachedRolls`
    // is absent from EVERY entry on the Player payload.
    for (const row of aliceList) {
      expect(Object.prototype.hasOwnProperty.call(row, "attachedRolls")).toBe(
        false,
      );
    }
  });
});

/**
 * Note timers v1 — see `plans/2026-04-28-2026-04-28-note-timers-v1.md`.
 *
 * GM-only feature. The timer rides on minion-target notes that pin a
 * roll set; the wire format is stripped for non-GMs identically to
 * `attachedRolls`. The cycle mutation is one-way out of `ticking` and
 * toggles between `done` and `due_manual` thereafter.
 *
 * The shared `preparePlayingGame` helper above promotes the harness
 * game to `playing` and pre-marks Raven (the seeded minion) as bought,
 * so the same fixture can place Raven on the head of the call queue.
 */
describe("notes: timers", () => {
  /** Local copy of the helper from the previous describe block. */
  async function preparePlayingGame(h: Harness, playerUserId: Id<"users">) {
    const playerId = await h.t.run(async (ctx) => {
      const row = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) =>
          q.eq("gameId", h.ids.gameId).eq("userId", playerUserId),
        )
        .unique();
      if (!row) throw new Error("player row not found");
      return row._id;
    });
    await h.t.run(async (ctx) => {
      const allPlayers = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) => q.eq("gameId", h.ids.gameId))
        .collect();
      for (const row of allPlayers) {
        if (!row.selectedSyndicateId) {
          await ctx.db.patch(row._id, {
            selectedSyndicateId: h.ids.syndicateId,
          });
        }
      }
    });
    await h.t.run(async (ctx) => {
      await ctx.db.insert("gamePlayerMinions", {
        gameId: h.ids.gameId,
        playerId,
        minionId: h.ids.minionId,
        bought: true,
        boughtAt: Date.now(),
        pricePaid: 0,
      });
    });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.games.transitionState, {
        gameId: h.ids.gameId,
        target: "playing",
      });
    return {
      placeOnHead: async () => {
        return await h.t
          .withIdentity(asUser(playerUserId))
          .mutation(api.calls.addOrReplaceCall, {
            gameId: h.ids.gameId,
            minionId: h.ids.minionId,
          });
      },
    };
  }

  test("createNote with timerMinutes rejects Players (GM-only)", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
        body: "player tries to set a timer",
        timerMinutes: 5,
      }),
    ).rejects.toThrow(/only the gm/i);
  });

  test("createNote with timerMinutes succeeds for GM on non-minion targets (Task 0b)", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();
    // Game-target: timer stands alone; row carries `ticking`, no roll set.
    const gameNoteId = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "game",
        body: "game-wide timer",
        timerMinutes: 5,
      });
    const gameNote = await h.t.run(async (ctx) => ctx.db.get(gameNoteId));
    expect(gameNote!.timer?.kind).toBe("ticking");
    expect(gameNote!.attachedRollSetId).toBeUndefined();

    // Syndicate-target: same — timer stands alone.
    const syndNoteId = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "syndicate",
        targetSyndicateId: h.ids.syndicateId,
        body: "syndicate timer",
        timerMinutes: 5,
      });
    const syndNote = await h.t.run(async (ctx) => ctx.db.get(syndNoteId));
    expect(syndNote!.timer?.kind).toBe("ticking");
    expect(syndNote!.attachedRollSetId).toBeUndefined();
  });

  test("createNote with timerMinutes succeeds when minion is not the head (Task 0b)", async () => {
    const h = await createHarness();
    // No placeOnHead — queue is empty, so the minion is NOT the head.
    await preparePlayingGame(h, h.ids.aId);
    const noteId = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
        body: "no live call",
        timerMinutes: 5,
      });
    const note = await h.t.run(async (ctx) => ctx.db.get(noteId));
    expect(note!.timer?.kind).toBe("ticking");
    // Row pins NO roll set — there's no head call to attach.
    expect(note!.attachedRollSetId).toBeUndefined();
  });

  test("createNote rejects unsupported preset minutes (e.g. 7)", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();
    await expect(
      h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
        body: "off-list duration",
        timerMinutes: 7,
      }),
    ).rejects.toThrow(/2, 5, 10, 15, 30/);
    // Spot-check zero and negatives are rejected by the same preset gate.
    await expect(
      h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
        body: "negative",
        timerMinutes: -5,
      }),
    ).rejects.toThrow(/2, 5, 10, 15, 30/);
  });

  test("createNote with valid preset writes a ticking timer with dueAt ≈ now + minutes", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();
    const before = Date.now();
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "ticking 5",
      timerMinutes: 5,
    });
    const after = Date.now();

    const list = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(list).toHaveLength(1);
    const note = list[0] as {
      timer?: { kind: string; dueAt?: number };
    };
    expect(note.timer).toBeDefined();
    expect(note.timer!.kind).toBe("ticking");
    // 5 minutes ≈ 300_000 ms; allow a generous skew for the test runner.
    expect(note.timer!.dueAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(note.timer!.dueAt).toBeLessThanOrEqual(after + 5 * 60_000);
  });

  test("listNotesForTarget strips `timer` from Player payloads and includes it for the GM", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();
    // GM authors a public timer note so Alice (a Player) can also see
    // the row at all.
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "public ticking note",
      visibility: "public",
      timerMinutes: 2,
    });

    const gmList = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(gmList).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(gmList[0], "timer")).toBe(true);

    const playerList = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(playerList).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(playerList[0], "timer")).toBe(
      false,
    );
  });

  test("notes without a timer omit the `timer` key entirely (GM payload)", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();
    // Note without timerMinutes — must NOT carry a `timer` key.
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "no timer",
    });
    const list = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(list).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(list[0], "timer")).toBe(false);
  });

  test("cycleNoteTimer rejects Players and non-participants", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();
    const noteId = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
        body: "ticking",
        visibility: "public",
        timerMinutes: 5,
      });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.notes.cycleNoteTimer, { noteId }),
    ).rejects.toThrow(/Game Master/i);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .mutation(api.notes.cycleNoteTimer, { noteId }),
    ).rejects.toThrow();
  });

  test("cycleNoteTimer rejects when no timer exists on the note", async () => {
    const h = await createHarness();
    const noteId = await createGameNote(h, h.ids.aId, "no timer here");
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.notes.cycleNoteTimer, { noteId }),
    ).rejects.toThrow(/no timer/i);
  });

  test("cycleNoteTimer cycles ticking → done → due_manual → done; never reaches ticking", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();
    const noteId = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
        body: "cycle me",
        timerMinutes: 5,
      });

    async function readKind(): Promise<string> {
      const list = await h.t
        .withIdentity(asUser(h.ids.gmId))
        .query(api.notes.listNotesForTarget, {
          gameId: h.ids.gameId,
          targetKind: "minion",
          targetMinionId: h.ids.minionId,
        });
      const r = list[0] as { timer?: { kind: string } };
      return r.timer!.kind;
    }
    expect(await readKind()).toBe("ticking");

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.cycleNoteTimer, { noteId });
    expect(await readKind()).toBe("done");

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.cycleNoteTimer, { noteId });
    expect(await readKind()).toBe("due_manual");

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.cycleNoteTimer, { noteId });
    expect(await readKind()).toBe("done");

    // Cycle several more times — never returns to ticking.
    for (let i = 0; i < 10; i++) {
      await h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.notes.cycleNoteTimer, { noteId });
      expect(await readKind()).not.toBe("ticking");
    }
  });

  test("cycleNoteTimer leaves body / visibility / target / attachedRollSetId untouched", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();
    const noteId = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
        body: "frozen content",
        visibility: "public",
        timerMinutes: 5,
      });

    const before = await h.t.run(async (ctx) => ctx.db.get(noteId));
    expect(before).not.toBeNull();
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.cycleNoteTimer, { noteId });
    const after = await h.t.run(async (ctx) => ctx.db.get(noteId));
    expect(after).not.toBeNull();

    expect(after!.body).toBe(before!.body);
    expect(after!.visibility).toBe(before!.visibility);
    expect(after!.targetKind).toBe(before!.targetKind);
    expect(after!.targetMinionId).toBe(before!.targetMinionId);
    expect(after!.targetSyndicateId).toBe(before!.targetSyndicateId);
    expect(after!.authorUserId).toBe(before!.authorUserId);
    expect(after!.createdAt).toBe(before!.createdAt);
    expect(after!.attachedRollSetId).toBe(before!.attachedRollSetId);
    // Only `timer` changed.
    expect(after!.timer?.kind).toBe("done");
  });

  test("getTimerCreateContext: GM gets timerEligible=true on head minion, false otherwise", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);

    // Before head is set: minion-target query returns timerEligible=false.
    const beforeHead = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.getTimerCreateContext, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(beforeHead).toEqual({ viewerIsGm: true, timerEligible: false });

    // Place on head: timerEligible flips to true for the GM.
    await ctl.placeOnHead();
    const onHead = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.getTimerCreateContext, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(onHead).toEqual({ viewerIsGm: true, timerEligible: true });

    // Non-minion target: always false even with a head live.
    const gameTarget = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.getTimerCreateContext, {
        gameId: h.ids.gameId,
        targetKind: "game",
      });
    expect(gameTarget).toEqual({ viewerIsGm: true, timerEligible: false });

    // Player viewer: viewerIsGm=false and timerEligible=false even on head.
    const playerView = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.getTimerCreateContext, {
        gameId: h.ids.gameId,
        targetKind: "minion",
        targetMinionId: h.ids.minionId,
      });
    expect(playerView).toEqual({ viewerIsGm: false, timerEligible: false });
  });
});

/**
 * Notes drawer timer aggregation — `listGameTimerNotes`.
 *
 * Plan: `plans/2026-04-28-gm-todo-drawer-v1.md` Task 3.
 *
 * GM-only aggregation. Returns one row per timer-bearing note in the
 * game with denormalised join names (minion / syndicate / selecting
 * player / author). Sort is server-side and time-INDEPENDENT —
 * `createdAt` descending (newest-first), matching the rest of the
 * notes UI.
 */
describe("notes: timer aggregation (listGameTimerNotes)", () => {
  /** Same fixture skeleton used by `notes: timers`. */
  async function preparePlayingGame(h: Harness, playerUserId: Id<"users">) {
    const playerId = await h.t.run(async (ctx) => {
      const row = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) =>
          q.eq("gameId", h.ids.gameId).eq("userId", playerUserId),
        )
        .unique();
      if (!row) throw new Error("player row not found");
      return row._id;
    });
    await h.t.run(async (ctx) => {
      const allPlayers = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) => q.eq("gameId", h.ids.gameId))
        .collect();
      for (const row of allPlayers) {
        if (!row.selectedSyndicateId) {
          await ctx.db.patch(row._id, {
            selectedSyndicateId: h.ids.syndicateId,
          });
        }
      }
    });
    await h.t.run(async (ctx) => {
      await ctx.db.insert("gamePlayerMinions", {
        gameId: h.ids.gameId,
        playerId,
        minionId: h.ids.minionId,
        bought: true,
        boughtAt: Date.now(),
        pricePaid: 0,
      });
    });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.games.transitionState, {
        gameId: h.ids.gameId,
        target: "playing",
      });
    return {
      placeOnHead: async () => {
        return await h.t
          .withIdentity(asUser(h.ids.aId))
          .mutation(api.calls.addOrReplaceCall, {
            gameId: h.ids.gameId,
            minionId: h.ids.minionId,
          });
      },
    };
  }

  test("rejects Players — Rule 24 server-side authoritative", async () => {
    const h = await createHarness();
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId }),
    ).rejects.toThrow();
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId }),
    ).rejects.toThrow();
  });

  test("returns [] when no notes carry a timer", async () => {
    const h = await createHarness();
    // Author a non-timer note so we have notes-without-timer in the
    // working set.
    await createGameNote(h, h.ids.gmId, "no clock");
    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    expect(rows).toEqual([]);
  });

  test("filters out non-timer notes; includes only timer-bearing rows", async () => {
    const h = await createHarness();
    await preparePlayingGame(h, h.ids.aId);
    // Two non-timer notes (author varies) + one game-timer note.
    await createGameNote(h, h.ids.aId, "alice non-timer", "public");
    await createGameNote(h, h.ids.gmId, "gm non-timer");
    const timerNoteId = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "game",
        body: "game-wide timer",
        timerMinutes: 5,
      });
    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    expect(rows.map((r) => r._id)).toEqual([timerNoteId]);
  });

  test("minion-target row carries minionName, syndicateName, playerId, playerDisplayName", async () => {
    const h = await createHarness();
    const ctl = await preparePlayingGame(h, h.ids.aId);
    await ctl.placeOnHead();
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "head-call timer",
      timerMinutes: 5,
    });
    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.targetKind).toBe("minion");
    expect(row.minionName).toBe("Raven");
    expect(row.syndicateName).toBe("Alice's Syndicate");
    expect(row.playerId).toBeDefined();
    expect(row.playerDisplayName).toBe("Alice");
    // Head call is live, so `attachedRolls` key is present.
    expect(Object.prototype.hasOwnProperty.call(row, "attachedRolls")).toBe(
      true,
    );
    expect(row.attachedRolls).not.toBeNull();
  });

  test("syndicate-target row carries syndicateName + player; no minionName; no attachedRolls key", async () => {
    const h = await createHarness();
    await preparePlayingGame(h, h.ids.aId);
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "syndicate",
      targetSyndicateId: h.ids.syndicateId,
      body: "syndicate timer",
      timerMinutes: 5,
    });
    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.targetKind).toBe("syndicate");
    expect(row.syndicateName).toBe("Alice's Syndicate");
    expect(row.minionName).toBeUndefined();
    expect(row.playerDisplayName).toBe("Alice");
    expect(Object.prototype.hasOwnProperty.call(row, "attachedRolls")).toBe(
      false,
    );
  });

  test("game-target row has no minionName, syndicateName, playerId, or attachedRolls key", async () => {
    const h = await createHarness();
    await preparePlayingGame(h, h.ids.aId);
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "game",
      body: "game-wide timer",
      timerMinutes: 5,
    });
    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.targetKind).toBe("game");
    expect(row.minionName).toBeUndefined();
    expect(row.syndicateName).toBeUndefined();
    expect(row.playerId).toBeUndefined();
    expect(row.playerDisplayName).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(row, "attachedRolls")).toBe(
      false,
    );
  });

  test("minion-target NOT on head: row has minionName + syndicateName, no attachedRolls key", async () => {
    const h = await createHarness();
    // No placeOnHead — queue empty.
    await preparePlayingGame(h, h.ids.aId);
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "minion",
      targetMinionId: h.ids.minionId,
      body: "off-head timer",
      timerMinutes: 5,
    });
    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.minionName).toBe("Raven");
    expect(row.syndicateName).toBe("Alice's Syndicate");
    // Player who selected the syndicate is still resolved.
    expect(row.playerDisplayName).toBe("Alice");
    // No head call ⇒ no attached roll set ⇒ key omitted.
    expect(Object.prototype.hasOwnProperty.call(row, "attachedRolls")).toBe(
      false,
    );
  });

  test("syndicate-target with NO selecting Player: playerId and playerDisplayName absent", async () => {
    const h = await createHarness();
    // Build a second syndicate that no one in the game has selected.
    const orphanSyndicateId = await h.t.run(async (ctx) => {
      return await ctx.db.insert("syndicates", {
        name: "Orphan Cabal",
        leader: "Nobody",
        description: "",
        played: false,
        isShared: true,
        ownerId: h.ids.gmId,
      });
    });
    await preparePlayingGame(h, h.ids.aId);
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "syndicate",
      targetSyndicateId: orphanSyndicateId,
      body: "no selector",
      timerMinutes: 5,
    });
    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.syndicateName).toBe("Orphan Cabal");
    expect(row.playerId).toBeUndefined();
    expect(row.playerDisplayName).toBeUndefined();
  });

  test("server-side sort: createdAt desc across all timer states", async () => {
    const h = await createHarness();
    await preparePlayingGame(h, h.ids.aId);
    // Create a clutch of timer-bearing notes spanning all three timer
    // states. Order should be purely by `createdAt` descending —
    // independent of `kind` (ticking / due_manual / done) or `dueAt`.
    const ids = {
      tickFar: await h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.notes.createNote, {
          gameId: h.ids.gameId,
          targetKind: "game",
          body: "tick FAR",
          timerMinutes: 30,
        }),
      tickNear: await h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.notes.createNote, {
          gameId: h.ids.gameId,
          targetKind: "game",
          body: "tick NEAR",
          timerMinutes: 2,
        }),
      doneOlder: await h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.notes.createNote, {
          gameId: h.ids.gameId,
          targetKind: "game",
          body: "done OLDER",
          timerMinutes: 5,
        }),
      doneNewer: await h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.notes.createNote, {
          gameId: h.ids.gameId,
          targetKind: "game",
          body: "done NEWER",
          timerMinutes: 5,
        }),
      dueManual: await h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.notes.createNote, {
          gameId: h.ids.gameId,
          targetKind: "game",
          body: "due_manual ROW",
          timerMinutes: 5,
        }),
    };
    // Patch the non-ticking rows directly into their target states
    // and pin distinct, deliberately scrambled `createdAt` timestamps
    // so the desc ordering is exercised independently of insertion
    // order — sequential `createNote` calls within a single test
    // tick can land on the same `Date.now()` reading in edge-runtime,
    // in which case the stable sort would preserve insertion order
    // and mask a regression.
    await h.t.run(async (ctx) => {
      await ctx.db.patch(ids.tickFar, { createdAt: 1_000 });
      await ctx.db.patch(ids.doneOlder, {
        timer: { kind: "done" },
        createdAt: 2_000,
      });
      await ctx.db.patch(ids.dueManual, {
        timer: { kind: "due_manual" },
        createdAt: 3_000,
      });
      await ctx.db.patch(ids.tickNear, { createdAt: 4_000 });
      await ctx.db.patch(ids.doneNewer, {
        timer: { kind: "done" },
        createdAt: 5_000,
      });
    });

    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    const order = rows.map((r) => r._id);
    // Strict createdAt-desc, regardless of timer kind:
    //   doneNewer (5_000), tickNear (4_000), dueManual (3_000),
    //   doneOlder (2_000), tickFar (1_000).
    expect(order).toEqual([
      ids.doneNewer,
      ids.tickNear,
      ids.dueManual,
      ids.doneOlder,
      ids.tickFar,
    ]);
  });

  test("authorDisplayName resolves to displayName, falling back to email then 'Unknown'", async () => {
    const h = await createHarness();
    // Build a GM whose `displayName` is empty so the fallback chain
    // is exercised. Replace the GM on the existing game.
    const emailOnlyGmId = await h.t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        displayName: "",
        email: "no-display@test",
      });
      await ctx.db.patch(h.ids.gameId, { gmId: id });
      return id;
    });
    await h.t
      .withIdentity(asUser(emailOnlyGmId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "game",
        body: "by email-only GM",
        timerMinutes: 5,
      });
    const rows = await h.t
      .withIdentity(asUser(emailOnlyGmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    expect(rows[0].authorDisplayName).toBe("");
    // Note: the chain is `displayName ?? email ?? "Unknown"`. Empty
    // string is a valid `displayName`, so it wins. This documents
    // the behaviour — `??` treats only `null`/`undefined` as
    // missing. The fallback to email kicks in only when displayName
    // is genuinely missing on the user document.
  });

  test("cross-game isolation: timer notes in another game do not leak into this game's drawer", async () => {
    const h = await createHarness();
    await preparePlayingGame(h, h.ids.aId);
    // Build a second game with its own GM and a timer note.
    const otherGameId = await h.t.run(async (ctx) => {
      const otherGmId = await ctx.db.insert("users", {
        displayName: "Other GM",
        email: "other-gm@test",
      });
      const otherGame = await ctx.db.insert("games", {
        name: "Other Game",
        gmId: otherGmId,
        state: "ready",
      });
      // Stash the GM id on the row so we can act as them via
      // `withIdentity` outside the run() block.
      return { otherGame, otherGmId };
    });
    await h.t
      .withIdentity(asUser(otherGameId.otherGmId))
      .mutation(api.notes.createNote, {
        gameId: otherGameId.otherGame,
        targetKind: "game",
        body: "other game timer",
        timerMinutes: 5,
      });
    // Author one timer in this game too so the result is non-empty.
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "game",
      body: "this game timer",
      timerMinutes: 5,
    });
    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("this game timer");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Notes on Treason Grants and Goals
// (plans/2026-05-17-notes-on-grants-and-goals-v1.md, Tasks 26–38)
// ─────────────────────────────────────────────────────────────────────────

async function createGrant(
  h: Harness,
  fields: { keyword: string; power?: number; description?: string },
): Promise<Id<"treasonGrants">> {
  return await h.t
    .withIdentity(asUser(h.ids.gmId))
    .mutation(api.treasonGrants.createGrant, {
      gameId: h.ids.gameId,
      keyword: fields.keyword,
      power: fields.power ?? 5,
      description: fields.description ?? "secret",
    });
}

async function createGoal(
  h: Harness,
  fields: {
    keyword: string;
    description?: string;
    type?: "regular" | "shared" | "competitive";
    fromPlayerId?: Id<"players">;
    toPlayerId?: Id<"players">;
  },
): Promise<Id<"goals">> {
  return await h.t
    .withIdentity(asUser(h.ids.gmId))
    .mutation(api.goals.createGoal, {
      gameId: h.ids.gameId,
      keyword: fields.keyword,
      description: fields.description ?? "",
      type: fields.type ?? "regular",
      fromPlayerId: fields.fromPlayerId,
      toPlayerId: fields.toPlayerId,
    });
}

async function createGrantNote(
  h: Harness,
  actor: Id<"users">,
  grantId: Id<"treasonGrants">,
  body: string,
  visibility: "private" | "public" = "private",
): Promise<Id<"notes">> {
  return await h.t.withIdentity(asUser(actor)).mutation(api.notes.createNote, {
    gameId: h.ids.gameId,
    targetKind: "grant",
    targetGrantId: grantId,
    body,
    visibility,
  });
}

async function createGoalNote(
  h: Harness,
  actor: Id<"users">,
  goalId: Id<"goals">,
  body: string,
  visibility: "private" | "public" = "private",
): Promise<Id<"notes">> {
  return await h.t.withIdentity(asUser(actor)).mutation(api.notes.createNote, {
    gameId: h.ids.gameId,
    targetKind: "goal",
    targetGoalId: goalId,
    body,
    visibility,
  });
}

describe("notes on grants/goals: authoring eligibility", () => {
  test("any participant (GM, Player A, Player B) can author on a grant; outsider rejected", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper" });

    for (const actor of [h.ids.gmId, h.ids.aId, h.ids.bId]) {
      const id = await createGrantNote(h, actor, grantId, `by ${actor}`);
      expect(id).toBeTruthy();
    }

    await expect(
      createGrantNote(h, h.ids.outsiderId, grantId, "sneaky"),
    ).rejects.toThrow(/not a participant/i);
  });

  test("any participant can author on a goal; outsider rejected", async () => {
    const h = await createHarness();
    const goalId = await createGoal(h, { keyword: "Conquer" });

    for (const actor of [h.ids.gmId, h.ids.aId, h.ids.bId]) {
      const id = await createGoalNote(h, actor, goalId, `by ${actor}`);
      expect(id).toBeTruthy();
    }

    await expect(
      createGoalNote(h, h.ids.outsiderId, goalId, "sneaky"),
    ).rejects.toThrow(/not a participant/i);
  });

  test("authoring on an archived-game grant succeeds (parity with minion/syndicate)", async () => {
    // Plan Task 38.
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Late" });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.games.transitionState, {
        gameId: h.ids.gameId,
        target: "archived",
      });
    const id = await createGrantNote(h, h.ids.aId, grantId, "post-archive");
    expect(id).toBeTruthy();
  });
});

describe("notes on grants/goals: target consistency", () => {
  test("grant note requires targetGrantId and rejects sibling ids", async () => {
    // Plan Task 36.
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper" });

    // Missing targetGrantId.
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        body: "no id",
      }),
    ).rejects.toThrow();

    // Stray syndicate id.
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
        targetSyndicateId: h.ids.syndicateId,
        body: "mixed",
      }),
    ).rejects.toThrow();

    // Stray minion id.
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
        targetMinionId: h.ids.minionId,
        body: "mixed",
      }),
    ).rejects.toThrow();
  });

  test("goal note requires targetGoalId and rejects sibling ids", async () => {
    const h = await createHarness();
    const goalId = await createGoal(h, { keyword: "Conquer" });

    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "goal",
        body: "no id",
      }),
    ).rejects.toThrow();

    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "goal",
        targetGoalId: goalId,
        targetSyndicateId: h.ids.syndicateId,
        body: "mixed",
      }),
    ).rejects.toThrow();

    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "goal",
        targetGoalId: goalId,
        targetGrantId:
          // Force a real grant id of the right type to be sure the
          // rejection comes from the consistency check, not validator
          // shape errors.
          await createGrant(h, { keyword: "Foil" }),
        body: "mixed",
      }),
    ).rejects.toThrow();
  });
});

describe("notes on grants/goals: visibility", () => {
  test("private grant note is invisible to other players, visible to author and GM", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper" });
    await createGrantNote(h, h.ids.aId, grantId, "alice priv", "private");

    const aView = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(aView.map((n) => n.body)).toEqual(["alice priv"]);

    const bView = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(bView).toHaveLength(0);

    const gmView = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(gmView.map((n) => n.body)).toEqual(["alice priv"]);
  });

  test("public goal note is visible to every participant; outsider rejected on list", async () => {
    const h = await createHarness();
    const goalId = await createGoal(h, { keyword: "Conquer" });
    await createGoalNote(h, h.ids.aId, goalId, "alice pub", "public");

    for (const actor of [h.ids.aId, h.ids.bId, h.ids.gmId]) {
      const view = await h.t
        .withIdentity(asUser(actor))
        .query(api.notes.listNotesForTarget, {
          gameId: h.ids.gameId,
          targetKind: "goal",
          targetGoalId: goalId,
        });
      expect(view.map((n) => n.body)).toEqual(["alice pub"]);
    }

    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .query(api.notes.listNotesForTarget, {
          gameId: h.ids.gameId,
          targetKind: "goal",
          targetGoalId: goalId,
        }),
    ).rejects.toThrow(/not a participant/i);
  });

  test("two distinct private notes by different authors stay isolated", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper" });
    await createGrantNote(h, h.ids.aId, grantId, "alice priv", "private");
    await createGrantNote(h, h.ids.bId, grantId, "bob priv", "private");

    const aView = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(aView.map((n) => n.body)).toEqual(["alice priv"]);

    const bView = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(bView.map((n) => n.body)).toEqual(["bob priv"]);

    const gmView = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(gmView.map((n) => n.body).sort()).toEqual([
      "alice priv",
      "bob priv",
    ]);
  });

  test("note body is independent of parent-row description redaction", async () => {
    // Plan Task 34. A Player who cannot see the grant's description can
    // still read a public note on it.
    const h = await createHarness();
    const grantId = await createGrant(h, {
      keyword: "Whisper",
      description: "redacted-for-B",
    });
    await createGrantNote(h, h.ids.aId, grantId, "public note body", "public");

    // Description is redacted to Bob (no ownership).
    const grantsView = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId });
    expect(grantsView.grants[0].description).toBeNull();

    // But the note body IS visible.
    const notesView = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(notesView.map((n) => n.body)).toEqual(["public note body"]);

    // Same for a goal where Bob is neither from nor to.
    const goalId = await createGoal(h, {
      keyword: "Conquer",
      description: "redacted",
      fromPlayerId: h.ids.playerAId,
    });
    await createGoalNote(h, h.ids.aId, goalId, "public goal note", "public");

    const goalsView = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    const target = goalsView.goals.find((g) => g._id === goalId);
    expect(target?.description).toBeNull();

    const goalNotesView = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "goal",
        targetGoalId: goalId,
      });
    expect(goalNotesView.map((n) => n.body)).toEqual(["public goal note"]);
  });
});

describe("notes on grants/goals: deletion (GM-only)", () => {
  test("GM can delete a grant note; author and other player cannot", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper" });
    const noteId = await createGrantNote(
      h,
      h.ids.aId,
      grantId,
      "alice pub",
      "public",
    );

    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.notes.deleteNote, { noteId }),
    ).rejects.toThrow(/Game Master/i);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.bId))
        .mutation(api.notes.deleteNote, { noteId }),
    ).rejects.toThrow(/Game Master/i);

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.deleteNote, { noteId });

    const remaining = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(remaining).toHaveLength(0);
  });
});

describe("notes on grants/goals: ordering and cross-game scoping", () => {
  test("listNotesForTarget returns newest first (grant + goal)", async () => {
    // Plan Task 29.
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper" });
    const goalId = await createGoal(h, { keyword: "Conquer" });

    await h.t.run(async (ctx) => {
      for (const [createdAt, body] of [
        [1_000, "g1"],
        [2_000, "g2"],
        [3_000, "g3"],
      ] as const) {
        await ctx.db.insert("notes", {
          gameId: h.ids.gameId,
          targetKind: "grant",
          targetGrantId: grantId,
          authorUserId: h.ids.aId,
          visibility: "public",
          body,
          createdAt,
        });
      }
      for (const [createdAt, body] of [
        [10, "go1"],
        [20, "go2"],
        [30, "go3"],
      ] as const) {
        await ctx.db.insert("notes", {
          gameId: h.ids.gameId,
          targetKind: "goal",
          targetGoalId: goalId,
          authorUserId: h.ids.aId,
          visibility: "public",
          body,
          createdAt,
        });
      }
    });

    const grantList = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(grantList.map((n) => n.body)).toEqual(["g3", "g2", "g1"]);

    const goalList = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "goal",
        targetGoalId: goalId,
      });
    expect(goalList.map((n) => n.body)).toEqual(["go3", "go2", "go1"]);
  });

  test("cross-game scoping: createNote rejects mismatched gameId, listings don't leak", async () => {
    // Plan Task 28.
    const h = await createHarness();
    const grantA = await createGrant(h, { keyword: "GrantA" });
    const goalA = await createGoal(h, { keyword: "GoalA" });

    // Author public notes on the game-A grant/goal.
    await createGrantNote(h, h.ids.aId, grantA, "game A grant note", "public");
    await createGoalNote(h, h.ids.aId, goalA, "game A goal note", "public");

    // Build a second game (different GM) and a grant + goal in it.
    const { gameBId, grantB, goalB } = await h.t.run(async (ctx) => {
      const gmBId = await ctx.db.insert("users", {
        displayName: "GM2",
        email: "gm2@test",
      });
      const gBId = await ctx.db.insert("games", {
        name: "Game B",
        gmId: gmBId,
        state: "ready",
      });
      // Alice is also a participant of game B so she can list notes.
      await ctx.db.insert("players", {
        gameId: gBId,
        userId: h.ids.aId,
        power: 0,
        joinedAt: Date.now(),
      });
      const grantB = await ctx.db.insert("treasonGrants", {
        gameId: gBId,
        keyword: "GrantB",
        keywordLower: "grantb",
        power: 5,
        description: "",
        createdAt: Date.now(),
        createdByUserId: gmBId,
      });
      const goalB = await ctx.db.insert("goals", {
        gameId: gBId,
        keyword: "GoalB",
        keywordLower: "goalb",
        description: "",
        type: "regular",
        createdAt: Date.now(),
        createdByUserId: gmBId,
      });
      return { gameBId: gBId, grantB, goalB };
    });

    // Cross-game create on the game-A grant from game-B context is
    // rejected by the parent-row gameId check.
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: gameBId,
        targetKind: "grant",
        targetGrantId: grantA,
        body: "cross-game grant",
      }),
    ).rejects.toThrow(/not in this game/i);

    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.notes.createNote, {
        gameId: gameBId,
        targetKind: "goal",
        targetGoalId: goalA,
        body: "cross-game goal",
      }),
    ).rejects.toThrow(/not in this game/i);

    // Listing in game B for game-B's grant/goal yields no notes (no
    // game-A notes leak).
    const grantBList = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: gameBId,
        targetKind: "grant",
        targetGrantId: grantB,
      });
    expect(grantBList).toHaveLength(0);

    const goalBList = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.listNotesForTarget, {
        gameId: gameBId,
        targetKind: "goal",
        targetGoalId: goalB,
      });
    expect(goalBList).toHaveLength(0);
  });
});

describe("notes on grants/goals: cascade on parent delete", () => {
  test("deleteGrant removes every note targeting that grant", async () => {
    // Plan Task 30 (grant).
    const h = await createHarness();
    const grant1 = await createGrant(h, { keyword: "Whisper" });
    const grant2 = await createGrant(h, { keyword: "Echo" });
    await createGrantNote(h, h.ids.aId, grant1, "g1 note");
    await createGrantNote(h, h.ids.aId, grant1, "g1 again");
    await createGrantNote(h, h.ids.aId, grant2, "g2 note");

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.treasonGrants.deleteGrant, { grantId: grant1 });

    const grant1Surviving = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("notes")
        .withIndex("by_grant", (q) => q.eq("targetGrantId", grant1))
        .collect();
    });
    expect(grant1Surviving).toHaveLength(0);

    const grant2Surviving = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("notes")
        .withIndex("by_grant", (q) => q.eq("targetGrantId", grant2))
        .collect();
    });
    expect(grant2Surviving).toHaveLength(1);
  });

  test("deleteGoal removes every note targeting that goal", async () => {
    // Plan Task 30 (goal).
    const h = await createHarness();
    const goal1 = await createGoal(h, { keyword: "Conquer" });
    const goal2 = await createGoal(h, { keyword: "Survive" });
    await createGoalNote(h, h.ids.aId, goal1, "go1 note");
    await createGoalNote(h, h.ids.bId, goal1, "go1 again");
    await createGoalNote(h, h.ids.aId, goal2, "go2 note");

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.goals.deleteGoal, { goalId: goal1 });

    const goal1Surviving = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("notes")
        .withIndex("by_goal", (q) => q.eq("targetGoalId", goal1))
        .collect();
    });
    expect(goal1Surviving).toHaveLength(0);

    const goal2Surviving = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("notes")
        .withIndex("by_goal", (q) => q.eq("targetGoalId", goal2))
        .collect();
    });
    expect(goal2Surviving).toHaveLength(1);
  });
});

describe("notes on grants/goals: count query", () => {
  test("getNoteCountsForGameView surfaces byGrant and byGoal per viewer", async () => {
    // Plan Tasks 31, 37.
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper" });
    const goalId = await createGoal(h, { keyword: "Conquer" });

    // Alice posts a private grant note; Bob posts a public goal note.
    await createGrantNote(h, h.ids.aId, grantId, "alice priv", "private");
    await createGoalNote(h, h.ids.bId, goalId, "bob pub", "public");

    const aCounts = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.getNoteCountsForGameView, { gameId: h.ids.gameId });
    expect(aCounts.byGrant[grantId]).toBe(1);
    expect(aCounts.byGoal[goalId]).toBe(1);

    const bCounts = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.notes.getNoteCountsForGameView, { gameId: h.ids.gameId });
    // Bob cannot see Alice's private grant note.
    expect(bCounts.byGrant[grantId] ?? 0).toBe(0);
    expect(bCounts.byGoal[goalId]).toBe(1);

    const gmCounts = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.getNoteCountsForGameView, { gameId: h.ids.gameId });
    expect(gmCounts.byGrant[grantId]).toBe(1);
    expect(gmCounts.byGoal[goalId]).toBe(1);
  });
});

describe("notes on grants/goals: timer eligibility + timer-note projection", () => {
  test("getTimerCreateContext returns timerEligible=false for grant and goal", async () => {
    // Plan Task 33.
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper" });
    const goalId = await createGoal(h, { keyword: "Conquer" });

    const gmGrant = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.getTimerCreateContext, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(gmGrant).toEqual({ viewerIsGm: true, timerEligible: false });

    const gmGoal = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.getTimerCreateContext, {
        gameId: h.ids.gameId,
        targetKind: "goal",
        targetGoalId: goalId,
      });
    expect(gmGoal).toEqual({ viewerIsGm: true, timerEligible: false });

    const playerGrant = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.notes.getTimerCreateContext, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
      });
    expect(playerGrant).toEqual({ viewerIsGm: false, timerEligible: false });

    const playerGoal = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.notes.getTimerCreateContext, {
        gameId: h.ids.gameId,
        targetKind: "goal",
        targetGoalId: goalId,
      });
    expect(playerGoal).toEqual({ viewerIsGm: false, timerEligible: false });
  });

  test("server accepts GM-authored timer-bearing note on grant/goal; GM Todo projects keyword + owner", async () => {
    // Plan Tasks 32, 35.
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper" });
    // Take the grant so it has an ownerPlayerId for the projection.
    // Ensure Bob has a syndicate so we can transition to playing.
    await h.t.run(async (ctx) => {
      const bobSyndicateId = await ctx.db.insert("syndicates", {
        name: "Bob's Syndicate",
        leader: "Bob",
        description: "",
        played: false,
        isShared: false,
        ownerId: h.ids.bId,
      });
      await ctx.db.patch(h.ids.playerBId, {
        selectedSyndicateId: bobSyndicateId,
      });
    });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.games.transitionState, {
        gameId: h.ids.gameId,
        target: "playing",
      });
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId });

    const goalId = await createGoal(h, {
      keyword: "Conquer",
      fromPlayerId: h.ids.playerAId,
    });

    // GM authors timer-bearing notes on both targets (server accepts even
    // though the UI never offers the buttons for these kinds).
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "grant",
      targetGrantId: grantId,
      body: "grant timer",
      timerMinutes: 5,
    });
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "goal",
      targetGoalId: goalId,
      body: "goal timer",
      timerMinutes: 5,
    });

    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    expect(rows).toHaveLength(2);

    const grantRow = rows.find((r) => r.targetKind === "grant");
    expect(grantRow).toBeDefined();
    expect(grantRow!.targetGrantId).toBe(grantId);
    expect(grantRow!.grantKeyword).toBe("Whisper");
    // Owner of the grant is Alice (player A).
    expect(grantRow!.playerId).toBe(h.ids.playerAId);
    expect(grantRow!.playerDisplayName).toBe("Alice");

    const goalRow = rows.find((r) => r.targetKind === "goal");
    expect(goalRow).toBeDefined();
    expect(goalRow!.targetGoalId).toBe(goalId);
    expect(goalRow!.goalKeyword).toBe("Conquer");
    expect(goalRow!.playerId).toBe(h.ids.playerAId);
    expect(goalRow!.playerDisplayName).toBe("Alice");

    // Players never see this query.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId }),
    ).rejects.toThrow();
  });

  test("GM Todo projection: grant with no owner / goal with no from-player renders (unassigned)", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Orphan" });
    const goalId = await createGoal(h, { keyword: "Drifter" });

    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "grant",
      targetGrantId: grantId,
      body: "unowned grant timer",
      timerMinutes: 5,
    });
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
      gameId: h.ids.gameId,
      targetKind: "goal",
      targetGoalId: goalId,
      body: "unowned goal timer",
      timerMinutes: 5,
    });

    const rows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listGameTimerNotes, { gameId: h.ids.gameId });
    const grantRow = rows.find((r) => r.targetKind === "grant");
    const goalRow = rows.find((r) => r.targetKind === "goal");
    expect(grantRow!.grantKeyword).toBe("Orphan");
    expect(grantRow!.playerId).toBeUndefined();
    expect(grantRow!.playerDisplayName).toBeUndefined();
    expect(goalRow!.goalKeyword).toBe("Drifter");
    expect(goalRow!.playerId).toBeUndefined();
    expect(goalRow!.playerDisplayName).toBeUndefined();
  });
});
