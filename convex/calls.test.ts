/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/**
 * Convex Auth derives the user id from `identity.subject` by splitting on `|`
 * (mirrors the helper in `notes.test.ts`).
 */
function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * Shared setup for the `getCurrentCallDetails` tests:
 *  - GM, Alice, Bob, plus an outsider stranger.
 *  - Alice owns a syndicate (selected by both Players) with two drawbacks
 *    (created out-of-order so the test can verify `order` ascending) and
 *    two minions (Raven and Wraith).
 *  - Game is created in `ready`. Tests that need to add calls must first
 *    call `startGame(h)` so `game.state === "playing"`.
 *  - Both players have a `gamePlayerMinions` row with `bought=true` for
 *    both minions, so `addOrReplaceCall` accepts their requests directly.
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

    // Drawbacks created out-of-`order` to verify ordering in the response.
    const drawbackBId = await ctx.db.insert("drawbacks", {
      syndicateId,
      name: "Drawback B",
      description: "second by order",
      order: 1,
    });
    const drawbackAId = await ctx.db.insert("drawbacks", {
      syndicateId,
      name: "Drawback A",
      description: "first by order",
      order: 0,
    });

    const minionRavenId = await ctx.db.insert("minions", {
      syndicateId,
      name: "Raven",
      accent: "the silent one",
      description: "Tall and gaunt.",
      skills: ["sneak", "perceive"],
      order: 0,
    });
    const minionWraithId = await ctx.db.insert("minions", {
      syndicateId,
      name: "Wraith",
      skills: ["lie"],
      order: 1,
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

    // Pre-mark every minion as `bought` for both players so calls can be
    // added without going through the buy flow (which has its own rules
    // tested elsewhere).
    for (const playerId of [playerAId, playerBId]) {
      for (const minionId of [minionRavenId, minionWraithId]) {
        await ctx.db.insert("gamePlayerMinions", {
          gameId,
          playerId,
          minionId,
          bought: true,
          boughtAt: Date.now(),
          pricePaid: 0,
        });
      }
    }

    return {
      gmId,
      aId,
      bId,
      outsiderId,
      syndicateId,
      drawbackAId,
      drawbackBId,
      minionRavenId,
      minionWraithId,
      gameId,
      playerAId,
      playerBId,
    };
  });

  return { t, ids };
}

async function startGame(h: Harness) {
  await h.t
    .withIdentity(asUser(h.ids.gmId))
    .mutation(api.games.transitionState, {
      gameId: h.ids.gameId,
      target: "playing",
    });
}

async function addCall(
  h: Harness,
  caller: Id<"users">,
  minionId: Id<"minions">,
): Promise<Id<"calls">> {
  return await h.t
    .withIdentity(asUser(caller))
    .mutation(api.calls.addOrReplaceCall, {
      gameId: h.ids.gameId,
      minionId,
    });
}

describe("calls.getCurrentCallDetails", () => {
  test("returns null when the queue is empty", async () => {
    const h = await createHarness();
    await startGame(h);

    const result = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    expect(result).toBeNull();
  });

  test("returns the FIFO head when multiple calls exist", async () => {
    const h = await createHarness();
    await startGame(h);

    // Alice calls first (older `createdAt`), then Bob.
    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    // Tiny pause so the two `createdAt` timestamps are strictly ordered;
    // `addOrReplaceCall` uses `Date.now()` which has ms resolution.
    await new Promise((r) => setTimeout(r, 5));
    await addCall(h, h.ids.bId, h.ids.minionWraithId);

    const result = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    expect(result).not.toBeNull();
    expect(result!.call.playerId).toBe(h.ids.playerAId);
    expect(result!.call.playerName).toBe("Alice");
    expect(result!.minion._id).toBe(h.ids.minionRavenId);
    expect(result!.minion.name).toBe("Raven");
  });

  test("after removing the head, returns the next head", async () => {
    const h = await createHarness();
    await startGame(h);

    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    await new Promise((r) => setTimeout(r, 5));
    await addCall(h, h.ids.bId, h.ids.minionWraithId);

    // Confirm Alice is the head.
    const before = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    expect(before!.call.playerId).toBe(h.ids.playerAId);
    const aliceCallId = before!.call._id;

    // GM removes Alice's (the head) call.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: aliceCallId });

    // The new head is now Bob's call on Wraith.
    const after = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    expect(after).not.toBeNull();
    expect(after!.call.playerId).toBe(h.ids.playerBId);
    expect(after!.call.playerName).toBe("Bob");
    expect(after!.minion._id).toBe(h.ids.minionWraithId);

    // And after removing Bob's call too, the queue is empty.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: after!.call._id });

    const empty = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    expect(empty).toBeNull();
  });

  test("includes minion skills/accent/description and drawbacks sorted by order", async () => {
    const h = await createHarness();
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const result = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    expect(result).not.toBeNull();

    // Minion descriptors round-trip exactly.
    expect(result!.minion.skills).toEqual(["sneak", "perceive"]);
    expect(result!.minion.accent).toBe("the silent one");
    expect(result!.minion.description).toBe("Tall and gaunt.");

    // Syndicate-level fields.
    expect(result!.syndicate._id).toBe(h.ids.syndicateId);
    expect(result!.syndicate.name).toBe("Alice's Syndicate");
    expect(result!.syndicate.leader).toBe("Alice");

    // Drawbacks come back in `order` ascending, regardless of insertion
    // order. The harness inserts B (order 1) before A (order 0).
    expect(result!.syndicate.drawbacks.map((d) => d._id)).toEqual([
      h.ids.drawbackAId,
      h.ids.drawbackBId,
    ]);
    expect(result!.syndicate.drawbacks.map((d) => d.name)).toEqual([
      "Drawback A",
      "Drawback B",
    ]);
  });

  test("rejects non-GM participants and non-participants", async () => {
    const h = await createHarness();
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    // Alice is a Player on the game — still rejected.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId }),
    ).rejects.toThrow(/Game Master/i);

    // Bob is a Player on the game — still rejected.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.bId))
        .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId }),
    ).rejects.toThrow(/Game Master/i);

    // Outsider is not a participant — also rejected.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId }),
    ).rejects.toThrow(/Game Master/i);

    // Unauthenticated callers are rejected too.
    await expect(
      h.t.query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId }),
    ).rejects.toThrow(/not authenticated/i);
  });
});
