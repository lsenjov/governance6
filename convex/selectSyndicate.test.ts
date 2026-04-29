/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/**
 * `games.selectSyndicate` — within-game uniqueness invariant added by
 * `plans/2026-04-28-gm-todo-drawer-v1.md` Task 0d.
 *
 * The mutation rejects a second selection of the same Syndicate by a
 * different Player in the same game, while:
 *  - allowing the FIRST player's selection,
 *  - allowing the same Syndicate to be selected once per other game,
 *  - allowing a Player to re-select the same Syndicate they already
 *    have (idempotent).
 *
 * The check is mutation-level only (no schema constraint and no
 * backfill). Existing test fixtures elsewhere in the codebase that
 * insert two or three players in the same game with the same
 * `selectedSyndicateId` via direct `ctx.db.insert` continue to load.
 */

function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * Shared setup: 1 GM, 2 Players (Alice, Bob), 1 shared Syndicate, 1
 * game in `ready` state with neither Player having a selection yet.
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

    // Owned by Alice, but `isShared` so Bob can also pick it.
    const sharedSyndicateId = await ctx.db.insert("syndicates", {
      name: "Shared Cabal",
      leader: "Alice",
      description: "",
      played: false,
      isShared: true,
      ownerId: aId,
    });

    const gameId = await ctx.db.insert("games", {
      name: "Game A",
      gmId,
      state: "ready",
    });
    const playerAId = await ctx.db.insert("players", {
      gameId,
      userId: aId,
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
      sharedSyndicateId,
      gameId,
      playerAId,
      playerBId,
    };
  });

  return { t, ids };
}

async function readSelection(h: Harness, playerId: Id<"players">) {
  return await h.t.run(async (ctx) => {
    const row = await ctx.db.get(playerId);
    return row?.selectedSyndicateId ?? null;
  });
}

describe("selectSyndicate: within-game uniqueness (Task 0d)", () => {
  test("first Player to select a shared Syndicate succeeds", async () => {
    const h = await createHarness();
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.games.selectSyndicate, {
        gameId: h.ids.gameId,
        syndicateId: h.ids.sharedSyndicateId,
      });
    expect(await readSelection(h, h.ids.playerAId)).toBe(
      h.ids.sharedSyndicateId,
    );
  });

  test("a second Player in the same game cannot select the same Syndicate", async () => {
    const h = await createHarness();
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.games.selectSyndicate, {
        gameId: h.ids.gameId,
        syndicateId: h.ids.sharedSyndicateId,
      });
    await expect(
      h.t.withIdentity(asUser(h.ids.bId)).mutation(api.games.selectSyndicate, {
        gameId: h.ids.gameId,
        syndicateId: h.ids.sharedSyndicateId,
      }),
    ).rejects.toThrow(/already selected/i);
    // Bob's selection stays empty.
    expect(await readSelection(h, h.ids.playerBId)).toBeNull();
  });

  test("the same Syndicate may still be selected once per OTHER game", async () => {
    const h = await createHarness();
    // Alice selects in game A.
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.games.selectSyndicate, {
        gameId: h.ids.gameId,
        syndicateId: h.ids.sharedSyndicateId,
      });
    // Build a second independent game with Bob as the only Player.
    const gameBId = await h.t.run(async (ctx) => {
      const gBId = await ctx.db.insert("games", {
        name: "Game B",
        gmId: h.ids.gmId,
        state: "ready",
      });
      await ctx.db.insert("players", {
        gameId: gBId,
        userId: h.ids.bId,
        power: 0,
        joinedAt: Date.now(),
      });
      return gBId;
    });
    // Bob selects the same shared syndicate in game B — must succeed.
    await h.t
      .withIdentity(asUser(h.ids.bId))
      .mutation(api.games.selectSyndicate, {
        gameId: gameBId,
        syndicateId: h.ids.sharedSyndicateId,
      });
    // Bob's row in game B carries the selection; nothing changes in game A.
    const bobInB = await h.t.run(async (ctx) => {
      const row = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) =>
          q.eq("gameId", gameBId).eq("userId", h.ids.bId),
        )
        .unique();
      return row?.selectedSyndicateId ?? null;
    });
    expect(bobInB).toBe(h.ids.sharedSyndicateId);
  });

  test("a Player may re-select a Syndicate they already had (idempotent)", async () => {
    const h = await createHarness();
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.games.selectSyndicate, {
        gameId: h.ids.gameId,
        syndicateId: h.ids.sharedSyndicateId,
      });
    // Re-select — only the caller's own row matches the index walk.
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.games.selectSyndicate, {
        gameId: h.ids.gameId,
        syndicateId: h.ids.sharedSyndicateId,
      });
    expect(await readSelection(h, h.ids.playerAId)).toBe(
      h.ids.sharedSyndicateId,
    );
  });
});
