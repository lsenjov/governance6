/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { normaliseExtraRoll } from "./lib/rolls";

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

/**
 * Dice rolls v1 — see `plans/2026-04-28-2026-04-28-dice-rolls-v3.md`.
 *
 * `Math.random()` is stubbed in each test so the d6 outcomes are
 * deterministic. The helper calls `Math.random()` twice per generate
 * (skill, then chaos), in that order. With six faces:
 *   value = 1 + floor(rand * 6)
 *   → rand ≤ 0.16  → 1
 *   → rand 0.50    → 4
 *   → rand 0.999   → 6
 */
describe("calls: dice rolls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("becoming the head produces a roll set with valid d6 values", async () => {
    const h = await createHarness();
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const result = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    expect(result).not.toBeNull();
    expect(result!.rolls).not.toBeNull();
    const rolls = result!.rolls!;
    expect(rolls.skillRoll).toBeGreaterThanOrEqual(1);
    expect(rolls.skillRoll).toBeLessThanOrEqual(6);
    expect(rolls.chaosRoll).toBeGreaterThanOrEqual(1);
    expect(rolls.chaosRoll).toBeLessThanOrEqual(6);
    expect(rolls.skillCount).toBe(2); // Raven has [sneak, perceive]
    expect(rolls.extras).toEqual([]);
  });

  test("skill result tracks skillCount: roll > count is success, roll <= count is failure", async () => {
    // Success case: skill=6 (rand 0.99), chaos=4 (rand 0.5). Raven
    // has 2 skills, so 6 > 2 → success.
    {
      const h = await createHarness();
      await startGame(h);
      vi.spyOn(Math, "random")
        .mockReturnValueOnce(0.99) // skillRoll = 6
        .mockReturnValueOnce(0.5); // chaosRoll = 4
      await addCall(h, h.ids.aId, h.ids.minionRavenId);

      const r = await h.t
        .withIdentity(asUser(h.ids.gmId))
        .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
      expect(r!.rolls!.skillRoll).toBe(6);
      expect(r!.rolls!.skillResult).toBe("success");
      expect(r!.rolls!.chaosRoll).toBe(4);
      expect(r!.rolls!.chaosResult).toBeNull();
      vi.restoreAllMocks();
    }

    // Failure case: skill=2 (rand 0.2), chaos=4. 2 <= 2 → failure.
    {
      const h = await createHarness();
      await startGame(h);
      vi.spyOn(Math, "random")
        .mockReturnValueOnce(0.2) // skillRoll = 2
        .mockReturnValueOnce(0.5); // chaosRoll = 4
      await addCall(h, h.ids.aId, h.ids.minionRavenId);

      const r = await h.t
        .withIdentity(asUser(h.ids.gmId))
        .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
      expect(r!.rolls!.skillRoll).toBe(2);
      expect(r!.rolls!.skillResult).toBe("failure");
    }
  });

  test("natural-1 on chaos sets chaosResult to failure; non-1 keeps it null", async () => {
    // Chaos=1 case.
    {
      const h = await createHarness();
      await startGame(h);
      vi.spyOn(Math, "random")
        .mockReturnValueOnce(0.99) // skillRoll = 6 (success, isolates chaos)
        .mockReturnValueOnce(0); //   chaosRoll = 1
      await addCall(h, h.ids.aId, h.ids.minionRavenId);

      const r = await h.t
        .withIdentity(asUser(h.ids.gmId))
        .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
      expect(r!.rolls!.chaosRoll).toBe(1);
      expect(r!.rolls!.chaosResult).toBe("failure");
      vi.restoreAllMocks();
    }

    // Chaos=4 (non-1) case: chaosResult projected as null.
    {
      const h = await createHarness();
      await startGame(h);
      vi.spyOn(Math, "random")
        .mockReturnValueOnce(0.99)
        .mockReturnValueOnce(0.5);
      await addCall(h, h.ids.aId, h.ids.minionRavenId);

      const r = await h.t
        .withIdentity(asUser(h.ids.gmId))
        .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
      expect(r!.rolls!.chaosResult).toBeNull();
    }
  });

  test("replace-in-place at the head with a different minion re-rolls", async () => {
    const h = await createHarness();
    await startGame(h);

    // Alice calls Raven → first roll set.
    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    const before = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    expect(before!.minion._id).toBe(h.ids.minionRavenId);
    expect(before!.rolls!.skillCount).toBe(2);

    // Alice now calls Wraith (1 skill) — replace-in-place at the head.
    await addCall(h, h.ids.aId, h.ids.minionWraithId);

    const after = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    // Same call id (replace-in-place preserves the document).
    expect(after!.call._id).toBe(before!.call._id);
    // New minion → new skillCount → new roll set.
    expect(after!.minion._id).toBe(h.ids.minionWraithId);
    expect(after!.rolls!.skillCount).toBe(1);

    // Two roll-set rows now exist for this call (older + newer).
    const stored = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", after!.call._id))
        .collect();
    });
    expect(stored).toHaveLength(2);
    expect(stored.map((s) => s.createdReason).sort()).toEqual([
      "became_head",
      "minion_replaced",
    ]);
  });

  test("same-minion replace is a no-op and does NOT create a new roll set", async () => {
    const h = await createHarness();
    await startGame(h);

    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    // Re-call the same minion: should be a no-op.
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const r = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    const stored = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", r!.call._id))
        .collect();
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].createdReason).toBe("became_head");
  });

  test("a non-head call is added without rolling; rolls fire only when it advances", async () => {
    const h = await createHarness();
    await startGame(h);

    // Alice calls first → becomes head, rolls.
    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    await new Promise((r) => setTimeout(r, 5));
    // Bob calls second → NOT the head, no roll yet.
    const bobCallId = await addCall(h, h.ids.bId, h.ids.minionWraithId);

    const bobRollsBefore = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", bobCallId))
        .collect();
    });
    expect(bobRollsBefore).toHaveLength(0);

    // GM removes Alice's head → Bob's advances and gets rolled.
    const before = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: before!.call._id });

    const after = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    expect(after!.call._id).toBe(bobCallId);
    expect(after!.rolls).not.toBeNull();
    expect(after!.rolls!.skillCount).toBe(1); // Wraith has 1 skill

    const bobRollsAfter = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", bobCallId))
        .collect();
    });
    expect(bobRollsAfter).toHaveLength(1);
    expect(bobRollsAfter[0].createdReason).toBe("became_head");
  });

  test("replace-in-place on a NON-head call does not roll until it advances", async () => {
    const h = await createHarness();
    await startGame(h);

    // Alice is head. Bob's call sits behind.
    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    await new Promise((r) => setTimeout(r, 5));
    const bobCallId = await addCall(h, h.ids.bId, h.ids.minionRavenId);

    // Bob switches his queued call to Wraith — still mid-queue, no roll.
    await addCall(h, h.ids.bId, h.ids.minionWraithId);

    const bobRolls = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", bobCallId))
        .collect();
    });
    expect(bobRolls).toHaveLength(0);
  });

  test("removing a mid-queue call does NOT touch the head's roll set", async () => {
    const h = await createHarness();
    await startGame(h);

    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    await new Promise((r) => setTimeout(r, 5));
    const bobCallId = await addCall(h, h.ids.bId, h.ids.minionWraithId);

    const headBefore = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    const aliceCallId = headBefore!.call._id;

    // GM removes Bob's mid-queue call.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: bobCallId });

    // Alice's roll set is unchanged: still exactly 1 row, same id.
    const aliceRolls = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", aliceCallId))
        .collect();
    });
    expect(aliceRolls).toHaveLength(1);
  });

  test("activeCalls: GM payload includes `rolls` per entry; head has rolls, tail null", async () => {
    const h = await createHarness();
    await startGame(h);

    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    await new Promise((r) => setTimeout(r, 5));
    await addCall(h, h.ids.bId, h.ids.minionWraithId);

    const list = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.activeCalls, { gameId: h.ids.gameId });
    expect(list).toHaveLength(2);

    // FIFO: index 0 is the head (Alice), index 1 is the tail (Bob).
    expect(Object.prototype.hasOwnProperty.call(list[0], "rolls")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(list[1], "rolls")).toBe(true);
    const head = list[0] as { rolls: { skillCount: number } | null };
    const tail = list[1] as { rolls: unknown };
    expect(head.rolls).not.toBeNull();
    expect(head.rolls!.skillCount).toBe(2);
    expect(tail.rolls).toBeNull();
  });

  test("activeCalls: Player payload OMITS the `rolls` key entirely", async () => {
    const h = await createHarness();
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    // Alice (Player) lists active calls.
    const list = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.calls.activeCalls, { gameId: h.ids.gameId });
    expect(list).toHaveLength(1);
    // The wire format MUST NOT include `rolls` at all — not even as
    // null/undefined. Tests assert via hasOwnProperty.
    expect(Object.prototype.hasOwnProperty.call(list[0], "rolls")).toBe(false);
  });
});

/**
 * Extras validator — direct unit tests for `normaliseExtraRoll` so
 * the schema-level invariants ("name required", "natural-1 coercion",
 * "value 1..6") are locked from day one. The validator runs inside
 * `generateRollSetForCall` for every extras item, so callers cannot
 * smuggle in unnamed dice or out-of-range values.
 */
describe("rolls.normaliseExtraRoll", () => {
  test("rejects empty kind", () => {
    expect(() =>
      normaliseExtraRoll({ kind: "  ", name: "Luck", value: 3 }),
    ).toThrow(/kind/i);
  });

  test("rejects empty name", () => {
    expect(() =>
      normaliseExtraRoll({ kind: "luck", name: "   ", value: 3 }),
    ).toThrow(/name/i);
  });

  test("rejects name longer than 24 characters", () => {
    expect(() =>
      normaliseExtraRoll({ kind: "luck", name: "x".repeat(25), value: 3 }),
    ).toThrow(/24/);
  });

  test("rejects non-integer or out-of-range values", () => {
    for (const bad of [0, 7, 1.5, -1]) {
      expect(() =>
        normaliseExtraRoll({ kind: "luck", name: "Luck", value: bad }),
      ).toThrow(/integer in \[1, 6\]/);
    }
  });

  test("trims kind and name", () => {
    const out = normaliseExtraRoll({
      kind: "  luck  ",
      name: "  Luck  ",
      value: 3,
    });
    expect(out.kind).toBe("luck");
    expect(out.name).toBe("Luck");
  });

  test("natural-1 coercion overrides caller-supplied success", () => {
    const out = normaliseExtraRoll({
      kind: "luck",
      name: "Luck",
      value: 1,
      result: "success",
    });
    expect(out.result).toBe("failure");
  });

  test("non-1 values keep caller-supplied result", () => {
    const out = normaliseExtraRoll({
      kind: "luck",
      name: "Luck",
      value: 6,
      result: "success",
    });
    expect(out.result).toBe("success");
  });

  test("non-1 values omit `result` when caller passes none", () => {
    const out = normaliseExtraRoll({ kind: "luck", name: "Luck", value: 4 });
    expect(out.result).toBeUndefined();
  });
});
