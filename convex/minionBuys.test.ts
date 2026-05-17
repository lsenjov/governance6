/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/**
 * Convex Auth derives the user id from `identity.subject` by splitting
 * on `|` (matches the helper used in `convex/calls.test.ts` and
 * `convex/notes.test.ts`).
 */
function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

/**
 * Smaller harness scoped to `toggleNextMinion`. Two players, one bought
 * minion each, plus an unbought minion. Game is created in `ready`;
 * tests that exercise the mutation transition it to `playing` first.
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
      isShared: true,
      ownerId: aId,
    });

    const minionAId = await ctx.db.insert("minions", {
      syndicateId,
      name: "Minion A",
      skills: ["s"],
      order: 0,
    });
    const minionBId = await ctx.db.insert("minions", {
      syndicateId,
      name: "Minion B",
      skills: ["s"],
      order: 1,
    });
    const unboughtMinionId = await ctx.db.insert("minions", {
      syndicateId,
      name: "Minion Unbought",
      skills: ["s"],
      order: 2,
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
      power: 10,
      joinedAt: Date.now(),
    });
    const playerBId = await ctx.db.insert("players", {
      gameId,
      userId: bId,
      selectedSyndicateId: syndicateId,
      power: 10,
      joinedAt: Date.now() + 1,
    });

    // Mark MinionA and MinionB as bought for Alice; MinionA bought for
    // Bob too. unboughtMinionId is intentionally left without a row.
    const gpmAliceAId = await ctx.db.insert("gamePlayerMinions", {
      gameId,
      playerId: playerAId,
      minionId: minionAId,
      bought: true,
      boughtAt: Date.now(),
      pricePaid: 0,
    });
    const gpmAliceBId = await ctx.db.insert("gamePlayerMinions", {
      gameId,
      playerId: playerAId,
      minionId: minionBId,
      bought: true,
      boughtAt: Date.now(),
      pricePaid: 2,
    });
    const gpmBobAId = await ctx.db.insert("gamePlayerMinions", {
      gameId,
      playerId: playerBId,
      minionId: minionAId,
      bought: true,
      boughtAt: Date.now(),
      pricePaid: 0,
    });

    return {
      gmId,
      aId,
      bId,
      outsiderId,
      syndicateId,
      minionAId,
      minionBId,
      unboughtMinionId,
      gameId,
      playerAId,
      playerBId,
      gpmAliceAId,
      gpmAliceBId,
      gpmBobAId,
    };
  });

  return { t, ids };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function startGame(h: Harness) {
  await h.t
    .withIdentity(asUser(h.ids.gmId))
    .mutation(api.games.transitionState, {
      gameId: h.ids.gameId,
      target: "playing",
    });
}

/**
 * Read the (game, player, minion) row directly so tests can assert on
 * the on-disk `isNext` value (including whether the underlying field is
 * `undefined` vs `true`).
 */
async function getGpm(
  h: Harness,
  playerId: Id<"players">,
  minionId: Id<"minions">,
) {
  return await h.t.run(async (ctx) => {
    return await ctx.db
      .query("gamePlayerMinions")
      .withIndex("by_game_player_minion", (q) =>
        q
          .eq("gameId", h.ids.gameId)
          .eq("playerId", playerId)
          .eq("minionId", minionId),
      )
      .unique();
  });
}

describe("minionBuys.toggleNextMinion", () => {
  test("set requires an active call", async () => {
    const h = await createHarness();
    await startGame(h);

    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.minionBuys.toggleNextMinion, {
          gameId: h.ids.gameId,
          minionId: h.ids.minionAId,
        }),
    ).rejects.toThrow(/active Call/i);

    const row = await getGpm(h, h.ids.playerAId, h.ids.minionAId);
    expect(row?.isNext === true).toBe(false);
  });

  test("set succeeds when an active call exists", async () => {
    const h = await createHarness();
    await startGame(h);

    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.calls.addOrReplaceCall, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionAId,
      });

    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.minionBuys.toggleNextMinion, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionBId,
      });

    const row = await getGpm(h, h.ids.playerAId, h.ids.minionBId);
    expect(row?.isNext).toBe(true);
  });

  test("toggle clears an already-set flag", async () => {
    const h = await createHarness();
    await startGame(h);

    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.calls.addOrReplaceCall, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionAId,
      });

    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.minionBuys.toggleNextMinion, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionBId,
      });
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.minionBuys.toggleNextMinion, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionBId,
      });

    const row = await getGpm(h, h.ids.playerAId, h.ids.minionBId);
    expect(row?.isNext === true).toBe(false);
    // Underlying value is `undefined` (clear writes undefined, not
    // false) so that wire shape matches "never set".
    expect(row?.isNext).toBeUndefined();
  });

  test("clear does NOT require an active call", async () => {
    const h = await createHarness();
    await startGame(h);

    // Force the flag on without going through the mutation, so the
    // player has no active call but a flagged row exists.
    await h.t.run(async (ctx) => {
      await ctx.db.patch(h.ids.gpmAliceBId, { isNext: true });
    });

    // No throw expected even though Alice has no active call.
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.minionBuys.toggleNextMinion, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionBId,
      });

    const row = await getGpm(h, h.ids.playerAId, h.ids.minionBId);
    expect(row?.isNext === true).toBe(false);
    expect(row?.isNext).toBeUndefined();
  });

  test("setting a second minion clears the first (uniqueness)", async () => {
    const h = await createHarness();
    await startGame(h);

    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.calls.addOrReplaceCall, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionAId,
      });

    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.minionBuys.toggleNextMinion, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionAId,
      });
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.minionBuys.toggleNextMinion, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionBId,
      });

    const rowA = await getGpm(h, h.ids.playerAId, h.ids.minionAId);
    const rowB = await getGpm(h, h.ids.playerAId, h.ids.minionBId);
    expect(rowA?.isNext === true).toBe(false);
    expect(rowB?.isNext).toBe(true);
  });

  test("rejects toggling a minion that is not bought", async () => {
    const h = await createHarness();
    await startGame(h);

    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.calls.addOrReplaceCall, {
        gameId: h.ids.gameId,
        minionId: h.ids.minionAId,
      });

    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.minionBuys.toggleNextMinion, {
          gameId: h.ids.gameId,
          minionId: h.ids.unboughtMinionId,
        }),
    ).rejects.toThrow(/buy this Minion/i);
  });

  test("rejects non-participants (outsiders and the GM)", async () => {
    const h = await createHarness();
    await startGame(h);

    // Outsider has no player row.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .mutation(api.minionBuys.toggleNextMinion, {
          gameId: h.ids.gameId,
          minionId: h.ids.minionAId,
        }),
    ).rejects.toThrow(/not a Player/i);

    // GM is in the game but has no player row.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.minionBuys.toggleNextMinion, {
          gameId: h.ids.gameId,
          minionId: h.ids.minionAId,
        }),
    ).rejects.toThrow(/not a Player/i);
  });

  test("rejects when the game is not in `playing` state", async () => {
    const h = await createHarness();
    // Do NOT start the game — it remains in `ready`.

    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.minionBuys.toggleNextMinion, {
          gameId: h.ids.gameId,
          minionId: h.ids.minionAId,
        }),
    ).rejects.toThrow(/playing/i);
  });
});
