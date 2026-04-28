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
      attachedRolls?:
        | { skillRoll: number; chaosRoll: number; skillCount: number }
        | null;
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
    expect(
      Object.prototype.hasOwnProperty.call(list[0], "attachedRolls"),
    ).toBe(false);
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
    expect(
      Object.prototype.hasOwnProperty.call(list[0], "attachedRolls"),
    ).toBe(false);
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
      attachedRolls?:
        | {
            skillRoll: number;
            chaosRoll: number;
            extras: Array<{
              kind: string;
              name: string;
              value: number;
            }>;
          }
        | null;
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
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.notes.createNote, {
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
      expect(
        Object.prototype.hasOwnProperty.call(row, "attachedRolls"),
      ).toBe(false);
    }
  });
});
