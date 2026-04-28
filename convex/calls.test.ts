/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import type { CurrentCallDetails } from "./calls";
import { normaliseExtraRoll } from "./lib/rolls";

type MinionHead = Extract<CurrentCallDetails, { kind: "minion" }>;
type CustomHead = Extract<CurrentCallDetails, { kind: "custom" }>;

/**
 * Narrowing helper used after `getCurrentCallDetails` queries: confirms
 * the head is a minion-call (the union variant carrying `minion`,
 * `syndicate`, and `rolls`) and lets the rest of each test access those
 * fields without a `kind` switch in every assertion.
 */
function assertMinionHead(
  r: CurrentCallDetails | null,
): asserts r is MinionHead {
  expect(r).not.toBeNull();
  expect(r?.kind).toBe("minion");
  if (r?.kind !== "minion") {
    throw new Error("expected minion-kind head");
  }
}

function assertCustomHead(
  r: CurrentCallDetails | null,
): asserts r is CustomHead {
  expect(r).not.toBeNull();
  expect(r?.kind).toBe("custom");
  if (r?.kind !== "custom") {
    throw new Error("expected custom-kind head");
  }
}

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
    assertMinionHead(result);
    expect(result.call.playerId).toBe(h.ids.playerAId);
    expect(result.call.playerName).toBe("Alice");
    expect(result.minion._id).toBe(h.ids.minionRavenId);
    expect(result.minion.name).toBe("Raven");
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
    assertMinionHead(before);
    expect(before.call.playerId).toBe(h.ids.playerAId);
    const aliceCallId = before.call._id;

    // GM removes Alice's (the head) call.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: aliceCallId });

    // The new head is now Bob's call on Wraith.
    const after = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(after);
    expect(after.call.playerId).toBe(h.ids.playerBId);
    expect(after.call.playerName).toBe("Bob");
    expect(after.minion._id).toBe(h.ids.minionWraithId);

    // And after removing Bob's call too, the queue is empty.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: after.call._id });

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
    assertMinionHead(result);

    // Minion descriptors round-trip exactly.
    expect(result.minion.skills).toEqual(["sneak", "perceive"]);
    expect(result.minion.accent).toBe("the silent one");
    expect(result.minion.description).toBe("Tall and gaunt.");

    // Syndicate-level fields.
    expect(result.syndicate._id).toBe(h.ids.syndicateId);
    expect(result.syndicate.name).toBe("Alice's Syndicate");
    expect(result.syndicate.leader).toBe("Alice");

    // Drawbacks come back in `order` ascending, regardless of insertion
    // order. The harness inserts B (order 1) before A (order 0).
    expect(result.syndicate.drawbacks.map((d) => d._id)).toEqual([
      h.ids.drawbackAId,
      h.ids.drawbackBId,
    ]);
    expect(result.syndicate.drawbacks.map((d) => d.name)).toEqual([
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
    assertMinionHead(result);
    expect(result.rolls).not.toBeNull();
    const rolls = result.rolls!;
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
      assertMinionHead(r);
      expect(r.rolls!.skillRoll).toBe(6);
      expect(r.rolls!.skillResult).toBe("success");
      expect(r.rolls!.chaosRoll).toBe(4);
      expect(r.rolls!.chaosResult).toBeNull();
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
      assertMinionHead(r);
      expect(r.rolls!.skillRoll).toBe(2);
      expect(r.rolls!.skillResult).toBe("failure");
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
      assertMinionHead(r);
      expect(r.rolls!.chaosRoll).toBe(1);
      expect(r.rolls!.chaosResult).toBe("failure");
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
      assertMinionHead(r);
      expect(r.rolls!.chaosResult).toBeNull();
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
    assertMinionHead(before);
    expect(before.minion._id).toBe(h.ids.minionRavenId);
    expect(before.rolls!.skillCount).toBe(2);

    // Alice now calls Wraith (1 skill) — replace-in-place at the head.
    await addCall(h, h.ids.aId, h.ids.minionWraithId);

    const after = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(after);
    // Same call id (replace-in-place preserves the document).
    expect(after.call._id).toBe(before.call._id);
    // New minion → new skillCount → new roll set.
    expect(after.minion._id).toBe(h.ids.minionWraithId);
    expect(after.rolls!.skillCount).toBe(1);

    // Two roll-set rows now exist for this call (older + newer).
    const stored = await h.t.run(async (ctx) => {
      return await ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", after.call._id))
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
    assertMinionHead(after);
    expect(after.call._id).toBe(bobCallId);
    expect(after.rolls).not.toBeNull();
    expect(after.rolls!.skillCount).toBe(1); // Wraith has 1 skill

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
 * Drawback rolls v1 — see `plans/2026-04-28-drawback-rolls-v1.md` Task 20.
 *
 * Drawback dice ride along on every becoming-the-head event for a
 * minion call: one d6 per `isRolled === true` drawback on the called
 * minion's syndicate, in `order` ascending. Each die's caption is the
 * abbreviation (truncated to 6 chars) or the drawback name truncated
 * to 6 chars when no abbreviation is set. Captions are not uppercased
 * by the backend — `RollSetDisplay` does that at render time. The
 * universal natural-1 rule applies via `normaliseExtraRoll`.
 *
 * The harness's two seeded drawbacks (`drawbackAId`, `drawbackBId`)
 * are inserted with neither field set, so they default to
 * `isRolled: undefined` (which projects to `false`). Tests below
 * patch them directly via `ctx.db.patch` to opt them in — the
 * Syndicate editor cannot toggle `isRolled` in production (Task 14)
 * but the backend invariant must still hold for any code path that
 * does (admin DB-shell scripts, future tooling).
 */
describe("calls: drawback rolls", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Patch the harness's two seeded drawbacks to set `isRolled`,
   * `abbreviation`, and (optionally) `name`. Bypasses the editor by
   * design — the editor does not expose these fields.
   */
  async function configureDrawbacks(
    h: Harness,
    config: {
      a?: { isRolled?: boolean; abbreviation?: string; name?: string };
      b?: { isRolled?: boolean; abbreviation?: string; name?: string };
    },
  ) {
    await h.t.run(async (ctx) => {
      if (config.a) {
        await ctx.db.patch(h.ids.drawbackAId, config.a);
      }
      if (config.b) {
        await ctx.db.patch(h.ids.drawbackBId, config.b);
      }
    });
  }

  test("two isRolled drawbacks emit two extras with valid d6 values, in order, with truncated names", async () => {
    const h = await createHarness();
    await configureDrawbacks(h, {
      a: { isRolled: true, abbreviation: "GLSJAW" },
      b: { isRolled: true, abbreviation: "SLOW" },
    });
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const r = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(r);
    const rolls = r.rolls!;
    expect(rolls.extras).toHaveLength(2);
    // Order ascending: A (order 0) first, B (order 1) second.
    expect(rolls.extras[0].kind).toBe("drawback");
    expect(rolls.extras[0].name).toBe("GLSJAW");
    expect(rolls.extras[1].kind).toBe("drawback");
    expect(rolls.extras[1].name).toBe("SLOW");
    for (const e of rolls.extras) {
      expect(e.value).toBeGreaterThanOrEqual(1);
      expect(e.value).toBeLessThanOrEqual(6);
    }
  });

  test("non-rolled drawbacks emit no extras", async () => {
    const h = await createHarness();
    // Only A is opt-in; B stays at its default `isRolled: undefined`.
    await configureDrawbacks(h, {
      a: { isRolled: true, abbreviation: "AAAA" },
    });
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const r = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(r);
    expect(r.rolls!.extras).toHaveLength(1);
    expect(r.rolls!.extras[0].name).toBe("AAAA");
  });

  test("free-form drawbacks (no preset prefill) do not roll", async () => {
    // Default seeded drawbacks (`isRolled: undefined`,
    // `abbreviation: undefined`) are the same shape produced by a
    // free-form editor entry. They must not generate any extras.
    const h = await createHarness();
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const r = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(r);
    expect(r.rolls!.extras).toHaveLength(0);
  });

  test("empty-after-trim abbreviation falls back to the drawback name", async () => {
    const h = await createHarness();
    await configureDrawbacks(h, {
      a: { isRolled: true, abbreviation: "", name: "Quiet" },
    });
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const r = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(r);
    expect(r.rolls!.extras).toHaveLength(1);
    // Abbreviation absent → name fallback (≤6 chars naturally).
    expect(r.rolls!.extras[0].name).toBe("Quiet");
  });

  test("name longer than 6 chars is truncated at the trigger site", async () => {
    const h = await createHarness();
    // No abbreviation → name fallback. Name is 22 chars; helper
    // validator caps at 24 but the trigger site truncates to 6 first.
    await configureDrawbacks(h, {
      a: { isRolled: true, name: "VeryLongDrawbackName!!" },
    });
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const r = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(r);
    expect(r.rolls!.extras).toHaveLength(1);
    expect(r.rolls!.extras[0].name).toBe("VeryLo");
    expect(r.rolls!.extras[0].name.length).toBe(6);
  });

  test("natural-1 on a drawback die is coerced to result: failure", async () => {
    const h = await createHarness();
    await configureDrawbacks(h, {
      a: { isRolled: true, abbreviation: "GLSJAW" },
    });
    await startGame(h);

    // Random sequence: drawback (1), then skill (6), then chaos (1).
    // The drawback rolls FIRST in the trigger site (extras computed
    // before generateRollSetForCall), so the very first random pull
    // is the drawback.
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0) //    drawback A = 1 → failure
      .mockReturnValueOnce(0.99) // skillRoll = 6 → success
      .mockReturnValueOnce(0); //   chaosRoll = 1 → failure
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const r = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(r);
    expect(r.rolls!.extras[0].value).toBe(1);
    expect(r.rolls!.extras[0].result).toBe("failure");
    // Sanity-check chaos natural-1 still records failure too — guards
    // against natural-1 drift across cells.
    expect(r.rolls!.chaosRoll).toBe(1);
    expect(r.rolls!.chaosResult).toBe("failure");
  });

  test("replace-in-place re-rolls the drawback dice independently", async () => {
    const h = await createHarness();
    await configureDrawbacks(h, {
      a: { isRolled: true, abbreviation: "GLSJAW" },
    });
    await startGame(h);

    // First roll (Raven): drawback=4, skill=4, chaos=4.
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.5)
      // Replace-in-place (Wraith): drawback=6, skill=6, chaos=6.
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0.99)
      .mockReturnValueOnce(0.99);

    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    const before = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(before);
    expect(before.rolls!.extras).toHaveLength(1);
    expect(before.rolls!.extras[0].value).toBe(4);

    await addCall(h, h.ids.aId, h.ids.minionWraithId);
    const after = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(after);
    expect(after.rolls!.extras).toHaveLength(1);
    expect(after.rolls!.extras[0].value).toBe(6);

    // Two separate `callRollSets` rows now exist for this call —
    // confirm the extras differ between rows.
    const rows = await h.t.run((ctx) =>
      ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", after.call._id))
        .order("asc")
        .collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].extras[0].value).toBe(4);
    expect(rows[1].extras[0].value).toBe(6);
  });

  test("toggle-then-replace: flipping isRolled before a replace picks up on the new roll set", async () => {
    // Starting state: drawback A is non-rolled; head call has no
    // drawback extras.
    const h = await createHarness();
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    const before = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(before);
    expect(before.rolls!.extras).toHaveLength(0);

    // Flip A's `isRolled` directly via db.patch — the editor cannot
    // do this in production (Task 14), but the backend invariant
    // must still hold for admin tooling. After the flip, the head's
    // existing roll set is unchanged (immutability) but the next
    // becoming-the-head event must include the now-rolled drawback.
    await h.t.run(async (ctx) => {
      await ctx.db.patch(h.ids.drawbackAId, {
        isRolled: true,
        abbreviation: "TOG",
      });
    });

    // Replace-in-place on the head with a different minion — fires
    // `minion_replaced`, which re-reads drawbacks AFTER the patch
    // commits. Asserts the trigger-site re-read order.
    await addCall(h, h.ids.aId, h.ids.minionWraithId);
    const after = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(after);
    expect(after.rolls!.extras).toHaveLength(1);
    expect(after.rolls!.extras[0].name).toBe("TOG");
  });

  test("removal advancing to a new head includes that minion's syndicate's drawbacks", async () => {
    // Build a second syndicate (owned by Bob) whose minion has
    // a different `isRolled` drawback. Removing Alice's head call
    // promotes Bob's call and rolls Bob's syndicate's drawbacks.
    const h = await createHarness();
    const bobSetup = await h.t.run(async (ctx) => {
      const bobSyndicateId = await ctx.db.insert("syndicates", {
        name: "Bob's Syndicate",
        leader: "Bob",
        description: "",
        played: false,
        isShared: true,
        ownerId: h.ids.bId,
      });
      await ctx.db.insert("drawbacks", {
        syndicateId: bobSyndicateId,
        name: "Loud",
        description: "",
        order: 0,
        isRolled: true,
        abbreviation: "LOUD",
      });
      const bobMinionId = await ctx.db.insert("minions", {
        syndicateId: bobSyndicateId,
        name: "Sparrow",
        skills: ["lie", "sneak"],
        order: 0,
      });
      // Bob now selects HIS own syndicate (must change his player row).
      const bobPlayer = (await ctx.db.get(h.ids.playerBId))!;
      await ctx.db.patch(h.ids.playerBId, {
        selectedSyndicateId: bobSyndicateId,
      });
      // Mark Bob's minion bought for Bob.
      await ctx.db.insert("gamePlayerMinions", {
        gameId: h.ids.gameId,
        playerId: h.ids.playerBId,
        minionId: bobMinionId,
        bought: true,
        boughtAt: Date.now(),
        pricePaid: 0,
      });
      return { bobSyndicateId, bobMinionId, bobPlayer };
    });
    await startGame(h);

    // Alice calls Raven (head, no drawback extras — Alice's
    // syndicate has none rolled).
    const aliceCallId = await addCall(h, h.ids.aId, h.ids.minionRavenId);
    await new Promise((r) => setTimeout(r, 5));
    // Bob calls Sparrow — mid-queue, no roll yet.
    const bobCallId = await addCall(h, h.ids.bId, bobSetup.bobMinionId);

    // GM removes Alice's head — Bob's call advances and rolls.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: aliceCallId });

    const r = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(r);
    expect(r.call._id).toBe(bobCallId);
    expect(r.rolls!.extras).toHaveLength(1);
    expect(r.rolls!.extras[0].kind).toBe("drawback");
    expect(r.rolls!.extras[0].name).toBe("LOUD");
  });

  test("custom calls emit no drawback extras even when the player's syndicate has rolled drawbacks", async () => {
    const h = await createHarness();
    await configureDrawbacks(h, {
      a: { isRolled: true, abbreviation: "GLSJAW" },
    });
    await startGame(h);
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.calls.addOrReplaceCustomCall, {
        gameId: h.ids.gameId,
        label: "Need GM",
      });

    const r = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    expect(r?.kind).toBe("custom");
    // No callRollSets row for a custom call.
    const callId = (r as CustomHead).call._id;
    const rows = await h.t.run((ctx) =>
      ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", callId))
        .collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("Player activeCalls payload still omits `rolls` when drawback extras are present", async () => {
    const h = await createHarness();
    await configureDrawbacks(h, {
      a: { isRolled: true, abbreviation: "GLSJAW" },
    });
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const list = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.calls.activeCalls, { gameId: h.ids.gameId });
    expect(list).toHaveLength(1);
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

// ───────────────────────────────────────────────────────────────────────────
// Custom calls — see `plans/2026-04-28-private-and-custom-calls-v2.md`.
//
// The `addOrReplaceCustomCall` mutation is the player-facing entry point
// for non-minion calls (free-form "Need GM"-style notices and the
// "Private Call" client shortcut, which is just a custom call with the
// literal label "Private Call"). Both paths share the same active-row
// upsert helper as `addOrReplaceCall`, so all the queue-shape invariants
// (one active row per player, FIFO head, `_id`/`createdAt` preserved on
// replace-in-place) are exercised across both kinds here.
// ───────────────────────────────────────────────────────────────────────────

async function addCustomCall(
  h: Harness,
  caller: Id<"users">,
  label: string,
): Promise<Id<"calls">> {
  return await h.t
    .withIdentity(asUser(caller))
    .mutation(api.calls.addOrReplaceCustomCall, {
      gameId: h.ids.gameId,
      label,
    });
}

describe("addOrReplaceCustomCall", () => {
  test("inserts a custom row when no active call exists", async () => {
    const h = await createHarness();
    await startGame(h);
    const id = await addCustomCall(h, h.ids.aId, "Need GM");
    const row = await h.t.run((ctx) => ctx.db.get(id));
    expect(row).not.toBeNull();
    expect(row!.kind).toBe("custom");
    expect(row!.label).toBe("Need GM");
    expect(row!.minionId).toBeUndefined();
    expect(row!.isActive).toBe(true);
  });

  test("`Private Call` is a custom call with that exact label", async () => {
    const h = await createHarness();
    await startGame(h);
    const id = await addCustomCall(h, h.ids.aId, "Private Call");
    const row = await h.t.run((ctx) => ctx.db.get(id));
    expect(row!.kind).toBe("custom");
    expect(row!.label).toBe("Private Call");
    expect(row!.minionId).toBeUndefined();
  });

  test("trims whitespace at the mutation boundary", async () => {
    const h = await createHarness();
    await startGame(h);
    const id = await addCustomCall(h, h.ids.aId, "   Need GM   ");
    const row = await h.t.run((ctx) => ctx.db.get(id));
    expect(row!.label).toBe("Need GM");
  });

  test("same-label resubmission is a no-op (no new row, unchanged createdAt)", async () => {
    const h = await createHarness();
    await startGame(h);
    const id = await addCustomCall(h, h.ids.aId, "Need GM");
    const before = await h.t.run((ctx) => ctx.db.get(id));
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await addCustomCall(h, h.ids.aId, "Need GM");
    const after = await h.t.run((ctx) => ctx.db.get(id));
    expect(id2).toBe(id);
    expect(after!.createdAt).toBe(before!.createdAt);

    // Only one row exists for Alice.
    const allForAlice = await h.t.run((ctx) =>
      ctx.db
        .query("calls")
        .withIndex("by_game_player_active", (q) =>
          q
            .eq("gameId", h.ids.gameId)
            .eq("playerId", h.ids.playerAId)
            .eq("isActive", true),
        )
        .collect(),
    );
    expect(allForAlice).toHaveLength(1);
  });

  test("replace minion → custom preserves _id and createdAt, flips kind, clears minionId", async () => {
    const h = await createHarness();
    await startGame(h);
    const minionCallId = await addCall(h, h.ids.aId, h.ids.minionRavenId);
    const before = await h.t.run((ctx) => ctx.db.get(minionCallId));
    expect(before!.kind).toBe("minion");
    expect(before!.minionId).toBe(h.ids.minionRavenId);

    const id2 = await addCustomCall(h, h.ids.aId, "Need GM");
    expect(id2).toBe(minionCallId);

    const after = await h.t.run((ctx) => ctx.db.get(minionCallId));
    expect(after!._id).toBe(before!._id);
    expect(after!.createdAt).toBe(before!.createdAt);
    expect(after!.kind).toBe("custom");
    expect(after!.label).toBe("Need GM");
    expect(after!.minionId).toBeUndefined();
  });

  test("replace custom → minion preserves _id and createdAt, flips kind, clears label", async () => {
    const h = await createHarness();
    await startGame(h);
    const customCallId = await addCustomCall(h, h.ids.aId, "Need GM");
    const before = await h.t.run((ctx) => ctx.db.get(customCallId));
    expect(before!.kind).toBe("custom");
    expect(before!.label).toBe("Need GM");

    const id2 = await addCall(h, h.ids.aId, h.ids.minionRavenId);
    expect(id2).toBe(customCallId);

    const after = await h.t.run((ctx) => ctx.db.get(customCallId));
    expect(after!._id).toBe(before!._id);
    expect(after!.createdAt).toBe(before!.createdAt);
    expect(after!.kind).toBe("minion");
    expect(after!.minionId).toBe(h.ids.minionRavenId);
    expect(after!.label).toBeUndefined();
  });

  test("rejects empty / whitespace-only labels", async () => {
    const h = await createHarness();
    await startGame(h);
    await expect(addCustomCall(h, h.ids.aId, "")).rejects.toThrow(/empty/i);
    await expect(addCustomCall(h, h.ids.aId, "   ")).rejects.toThrow(/empty/i);
  });

  test("rejects labels longer than 80 characters", async () => {
    const h = await createHarness();
    await startGame(h);
    await expect(addCustomCall(h, h.ids.aId, "x".repeat(81))).rejects.toThrow(
      /80/,
    );
  });

  test("rejects non-Player callers (GM, outsider, anonymous)", async () => {
    const h = await createHarness();
    await startGame(h);
    await expect(addCustomCall(h, h.ids.gmId, "Need GM")).rejects.toThrow();
    await expect(
      addCustomCall(h, h.ids.outsiderId, "Need GM"),
    ).rejects.toThrow();
    await expect(
      h.t.mutation(api.calls.addOrReplaceCustomCall, {
        gameId: h.ids.gameId,
        label: "Need GM",
      }),
    ).rejects.toThrow();
  });

  test("rejects when game.state is not 'playing'", async () => {
    // ready
    {
      const h = await createHarness();
      await expect(addCustomCall(h, h.ids.aId, "Need GM")).rejects.toThrow(
        /playing/i,
      );
    }
    // archived
    {
      const h = await createHarness();
      await startGame(h);
      await h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.games.transitionState, {
          gameId: h.ids.gameId,
          target: "archived",
        });
      await expect(addCustomCall(h, h.ids.aId, "Need GM")).rejects.toThrow(
        /playing/i,
      );
    }
  });
});

describe("calls: dice rolls (cross-kind)", () => {
  test("custom head call generates no roll set", async () => {
    const h = await createHarness();
    await startGame(h);
    const id = await addCustomCall(h, h.ids.aId, "Need GM");

    const stored = await h.t.run((ctx) =>
      ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", id))
        .collect(),
    );
    expect(stored).toHaveLength(0);
  });

  test("replace-in-place across kinds: minion → custom does not roll, custom → minion fires `became_head`, minion → minion(diff) fires `minion_replaced`", async () => {
    const h = await createHarness();
    await startGame(h);

    // Step 1: minion(Raven) head — fires `became_head`.
    const callId = await addCall(h, h.ids.aId, h.ids.minionRavenId);
    {
      const rolls = await h.t.run((ctx) =>
        ctx.db
          .query("callRollSets")
          .withIndex("by_call_created", (q) => q.eq("callId", callId))
          .collect(),
      );
      expect(rolls).toHaveLength(1);
      expect(rolls[0].createdReason).toBe("became_head");
    }

    // Step 2: replace minion → custom (in-place). No new roll set.
    await addCustomCall(h, h.ids.aId, "Need GM");
    {
      const rolls = await h.t.run((ctx) =>
        ctx.db
          .query("callRollSets")
          .withIndex("by_call_created", (q) => q.eq("callId", callId))
          .collect(),
      );
      // Still exactly the original `became_head` row.
      expect(rolls).toHaveLength(1);
      expect(rolls[0].createdReason).toBe("became_head");
    }

    // Step 3: replace custom → minion(Wraith). Fresh roll set with
    // `became_head` because the prior head's kind was `custom` (the
    // row's minion is becoming a head minion for the first time on
    // this row's lifetime; `minion_replaced` requires a *prior minion*
    // on the same row).
    await addCall(h, h.ids.aId, h.ids.minionWraithId);
    {
      const rolls = await h.t.run((ctx) =>
        ctx.db
          .query("callRollSets")
          .withIndex("by_call_created", (q) => q.eq("callId", callId))
          .order("desc")
          .collect(),
      );
      expect(rolls).toHaveLength(2);
      // newest is the one we just added
      expect(rolls[0].createdReason).toBe("became_head");
    }

    // Step 4: replace minion(Wraith) → minion(Raven) on the same row.
    // This is the only path that produces `minion_replaced` and must
    // remain unchanged from today.
    await addCall(h, h.ids.aId, h.ids.minionRavenId);
    {
      const rolls = await h.t.run((ctx) =>
        ctx.db
          .query("callRollSets")
          .withIndex("by_call_created", (q) => q.eq("callId", callId))
          .order("desc")
          .collect(),
      );
      expect(rolls).toHaveLength(3);
      expect(rolls[0].createdReason).toBe("minion_replaced");
    }
  });

  test("removal advancing to a custom new head fires no roll set", async () => {
    const h = await createHarness();
    await startGame(h);

    // [minion(Raven) for Alice (head), custom for Bob]
    const aliceCallId = await addCall(h, h.ids.aId, h.ids.minionRavenId);
    await new Promise((r) => setTimeout(r, 5));
    const bobCallId = await addCustomCall(h, h.ids.bId, "Need GM");

    // GM removes Alice's head. Bob's custom advances.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: aliceCallId });

    const bobRolls = await h.t.run((ctx) =>
      ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", bobCallId))
        .collect(),
    );
    expect(bobRolls).toHaveLength(0);
  });

  test("removal advancing from a custom head to a minion call fires `became_head`", async () => {
    const h = await createHarness();
    await startGame(h);

    // [custom for Alice (head), minion(Wraith) for Bob]
    const aliceCallId = await addCustomCall(h, h.ids.aId, "Need GM");
    await new Promise((r) => setTimeout(r, 5));
    const bobCallId = await addCall(h, h.ids.bId, h.ids.minionWraithId);

    // Bob's call is mid-queue, no roll yet.
    {
      const bobRolls = await h.t.run((ctx) =>
        ctx.db
          .query("callRollSets")
          .withIndex("by_call_created", (q) => q.eq("callId", bobCallId))
          .collect(),
      );
      expect(bobRolls).toHaveLength(0);
    }

    // GM removes Alice's custom head. Bob's minion advances and rolls.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: aliceCallId });

    const bobRolls = await h.t.run((ctx) =>
      ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", bobCallId))
        .collect(),
    );
    expect(bobRolls).toHaveLength(1);
    expect(bobRolls[0].createdReason).toBe("became_head");
  });
});

describe("calls.getCurrentCallDetails: kind variants", () => {
  test("custom head returns kind:'custom' with caller name + label and no minion/syndicate/rolls keys", async () => {
    const h = await createHarness();
    await startGame(h);
    await addCustomCall(h, h.ids.aId, "Need GM");

    const result = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertCustomHead(result);
    expect(result.call.playerId).toBe(h.ids.playerAId);
    expect(result.call.playerName).toBe("Alice");
    expect(result.label).toBe("Need GM");

    // No minion/syndicate/rolls keys are present (asserted via
    // hasOwnProperty so a `null`/`undefined` value would still fail).
    expect(Object.prototype.hasOwnProperty.call(result, "minion")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "syndicate")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(result, "rolls")).toBe(false);
  });

  test("minion head still returns kind:'minion' with the existing fields (regression guard)", async () => {
    const h = await createHarness();
    await startGame(h);
    await addCall(h, h.ids.aId, h.ids.minionRavenId);

    const result = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.getCurrentCallDetails, { gameId: h.ids.gameId });
    assertMinionHead(result);
    expect(result.minion._id).toBe(h.ids.minionRavenId);
    expect(result.syndicate._id).toBe(h.ids.syndicateId);
    expect(Object.prototype.hasOwnProperty.call(result, "label")).toBe(false);
  });
});

describe("calls.activeCalls + recentlyRemovedCalls: kind discrimination", () => {
  test("activeCalls projects custom rows with `label` (not `minionName`) and minion rows with `minionName` (not `label`)", async () => {
    const h = await createHarness();
    await startGame(h);

    // Alice posts custom; Bob calls a minion.
    await addCustomCall(h, h.ids.aId, "Need GM");
    await new Promise((r) => setTimeout(r, 5));
    await addCall(h, h.ids.bId, h.ids.minionWraithId);

    const list = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.activeCalls, { gameId: h.ids.gameId });
    expect(list).toHaveLength(2);

    const alice = list.find((c) => c.playerName === "Alice")!;
    const bob = list.find((c) => c.playerName === "Bob")!;

    expect(alice.kind).toBe("custom");
    expect(Object.prototype.hasOwnProperty.call(alice, "label")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(alice, "minionName")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(alice, "minionId")).toBe(false);

    expect(bob.kind).toBe("minion");
    expect(Object.prototype.hasOwnProperty.call(bob, "minionName")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(bob, "label")).toBe(false);
  });

  test("Player payload omits the `rolls` key on both minion and custom rows", async () => {
    const h = await createHarness();
    await startGame(h);

    await addCustomCall(h, h.ids.aId, "Need GM");
    await new Promise((r) => setTimeout(r, 5));
    await addCall(h, h.ids.bId, h.ids.minionWraithId);

    const list = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.calls.activeCalls, { gameId: h.ids.gameId });
    expect(list).toHaveLength(2);
    for (const row of list) {
      expect(Object.prototype.hasOwnProperty.call(row, "rolls")).toBe(false);
    }
  });

  test("recentlyRemovedCalls projects kind discriminator with the right shape", async () => {
    const h = await createHarness();
    await startGame(h);

    // Alice posts custom, then GM removes; Bob calls minion, then GM removes.
    const aliceCallId = await addCustomCall(h, h.ids.aId, "Need GM");
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: aliceCallId });

    const bobCallId = await addCall(h, h.ids.bId, h.ids.minionWraithId);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: bobCallId });

    const removed = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.recentlyRemovedCalls, { gameId: h.ids.gameId });
    expect(removed).toHaveLength(2);

    const alice = removed.find((c) => c.playerName === "Alice")!;
    const bob = removed.find((c) => c.playerName === "Bob")!;

    expect(alice.kind).toBe("custom");
    expect(Object.prototype.hasOwnProperty.call(alice, "label")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(alice, "minionName")).toBe(
      false,
    );
    expect(Object.prototype.hasOwnProperty.call(alice, "minionId")).toBe(false);

    expect(bob.kind).toBe("minion");
    expect(Object.prototype.hasOwnProperty.call(bob, "minionName")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(bob, "label")).toBe(false);
  });

  test("legacy back-compat: rows without a `kind` field project as kind:'minion' and idempotent re-call is a no-op", async () => {
    const h = await createHarness();
    await startGame(h);

    // Insert a `calls` row directly with no `kind` field, mirroring rows
    // written before this plan shipped (Risk 1 mitigation).
    const legacyCallId = await h.t.run(async (ctx) => {
      return await ctx.db.insert("calls", {
        gameId: h.ids.gameId,
        playerId: h.ids.playerAId,
        minionId: h.ids.minionRavenId,
        createdAt: Date.now(),
        isActive: true,
      });
    });

    // activeCalls projects the legacy row as kind:'minion'.
    const active = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.activeCalls, { gameId: h.ids.gameId });
    expect(active).toHaveLength(1);
    expect(active[0].kind).toBe("minion");
    expect(active[0]._id).toBe(legacyCallId);
    if (active[0].kind === "minion") {
      expect(active[0].minionName).toBe("Raven");
    }

    // Idempotent re-call: same minionId on the same legacy row is a
    // no-op even though `existing.kind === undefined` in the helper.
    const before = await h.t.run((ctx) => ctx.db.get(legacyCallId));
    await new Promise((r) => setTimeout(r, 5));
    const id2 = await addCall(h, h.ids.aId, h.ids.minionRavenId);
    expect(id2).toBe(legacyCallId);
    const after = await h.t.run((ctx) => ctx.db.get(legacyCallId));
    expect(after!.createdAt).toBe(before!.createdAt);

    // No rolls were added for the legacy row by the no-op path.
    // (The legacy row never went through a `became_head` event because
    // it was inserted directly.)
    const rolls = await h.t.run((ctx) =>
      ctx.db
        .query("callRollSets")
        .withIndex("by_call_created", (q) => q.eq("callId", legacyCallId))
        .collect(),
    );
    expect(rolls).toHaveLength(0);

    // Now soft-delete and verify recentlyRemovedCalls also projects
    // the legacy row as kind:'minion'.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.calls.removeCall, { callId: legacyCallId });
    const removed = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.calls.recentlyRemovedCalls, { gameId: h.ids.gameId });
    expect(removed).toHaveLength(1);
    expect(removed[0].kind).toBe("minion");
    if (removed[0].kind === "minion") {
      expect(removed[0].minionName).toBe("Raven");
    }
  });
});
