/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/**
 * Convex Auth derives the user id from `identity.subject` by splitting on `|`
 * (mirrors the helper in `treasonGrants.test.ts`).
 */
function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * Shared setup: 4 users (GM, Alice, Bob, Outsider). Alice owns a
 * shared syndicate selected by both Players. Game starts in `ready`
 * and is promoted via `startGame(h)` for tests that need `playing`.
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
      selectedSyndicateId: syndicateId,
      power: 0,
      joinedAt: Date.now() + 1,
    });

    return {
      gmId,
      aId,
      bId,
      outsiderId,
      syndicateId,
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

async function archiveGame(h: Harness) {
  await h.t
    .withIdentity(asUser(h.ids.gmId))
    .mutation(api.games.transitionState, {
      gameId: h.ids.gameId,
      target: "archived",
    });
}

type CreateGoalArgs = {
  keyword: string;
  description?: string;
  type?: "regular" | "shared" | "competitive";
  fromPlayerId?: Id<"players">;
  toPlayerId?: Id<"players">;
  carrot?: number;
  stick?: number;
};

async function createGoalAsGm(
  h: Harness,
  fields: CreateGoalArgs,
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
      carrot: fields.carrot,
      stick: fields.stick,
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Create
// ─────────────────────────────────────────────────────────────────────────

describe("goals: create authorisation + validation", () => {
  test("GM can create with no from/to (v2: from is optional)", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "Conquer",
      description: "secret",
    });
    expect(id).toBeTruthy();
  });

  test("GM can create with only from", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "Solo",
      fromPlayerId: h.ids.playerAId,
    });
    expect(id).toBeTruthy();
  });

  test("GM can create with only to", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "Target",
      toPlayerId: h.ids.playerBId,
    });
    expect(id).toBeTruthy();
  });

  test("GM can create with both, all types", async () => {
    const h = await createHarness();
    for (const t of ["regular", "shared", "competitive"] as const) {
      await createGoalAsGm(h, {
        keyword: `K-${t}`,
        type: t,
        fromPlayerId: h.ids.playerAId,
        toPlayerId: h.ids.playerBId,
        carrot: 15,
        stick: -10,
      });
    }
  });

  test("non-GM cannot create", async () => {
    const h = await createHarness();
    for (const actor of [h.ids.aId, h.ids.bId, h.ids.outsiderId]) {
      await expect(
        h.t.withIdentity(asUser(actor)).mutation(api.goals.createGoal, {
          gameId: h.ids.gameId,
          keyword: "x",
          description: "",
          type: "regular",
        }),
      ).rejects.toThrow(/Game Master|not authenticated/i);
    }
  });

  test("from === to is rejected", async () => {
    const h = await createHarness();
    await expect(
      createGoalAsGm(h, {
        keyword: "Self",
        fromPlayerId: h.ids.playerAId,
        toPlayerId: h.ids.playerAId,
      }),
    ).rejects.toThrow(/different/i);
  });

  test("cross-game player ids are rejected", async () => {
    const h = await createHarness();
    const otherPlayerId = await h.t.run(async (ctx) => {
      const otherGameId = await ctx.db.insert("games", {
        name: "Other",
        gmId: h.ids.gmId,
        state: "ready",
      });
      return await ctx.db.insert("players", {
        gameId: otherGameId,
        userId: h.ids.aId,
        power: 0,
        joinedAt: Date.now(),
      });
    });
    await expect(
      createGoalAsGm(h, {
        keyword: "Foreign",
        fromPlayerId: otherPlayerId,
      }),
    ).rejects.toThrow(/does not belong/i);
    await expect(
      createGoalAsGm(h, {
        keyword: "Foreign2",
        toPlayerId: otherPlayerId,
      }),
    ).rejects.toThrow(/does not belong/i);
  });

  test("keyword length and uniqueness (case-insensitive)", async () => {
    const h = await createHarness();
    await createGoalAsGm(h, { keyword: "Echo" });
    await expect(createGoalAsGm(h, { keyword: "   " })).rejects.toThrow(
      /empty/i,
    );
    await expect(
      createGoalAsGm(h, { keyword: "a".repeat(41) }),
    ).rejects.toThrow(/40/);
    await expect(createGoalAsGm(h, { keyword: "echo" })).rejects.toThrow(
      /already exists/i,
    );
    await expect(createGoalAsGm(h, { keyword: "  ECHO  " })).rejects.toThrow(
      /already exists/i,
    );

    // Same keyword in a different game is fine.
    const otherGameId = await h.t.run(async (ctx) =>
      ctx.db.insert("games", {
        name: "Other",
        gmId: h.ids.gmId,
        state: "ready",
      }),
    );
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.createGoal, {
      gameId: otherGameId,
      keyword: "Echo",
      description: "",
      type: "regular",
    });
  });

  test("carrot range and stick range", async () => {
    const h = await createHarness();
    await expect(
      createGoalAsGm(h, { keyword: "C1", carrot: -1 }),
    ).rejects.toThrow(/non-negative|at least 0/i);
    await expect(
      createGoalAsGm(h, { keyword: "C2", carrot: 1.5 }),
    ).rejects.toThrow(/integer/i);
    await expect(
      createGoalAsGm(h, { keyword: "C3", carrot: 9999 }),
    ).rejects.toThrow(/at most/i);
    await expect(
      createGoalAsGm(h, { keyword: "S1", stick: 1 }),
    ).rejects.toThrow(/non-positive|at most 0/i);
    await expect(
      createGoalAsGm(h, { keyword: "S2", stick: -1.5 }),
    ).rejects.toThrow(/integer/i);
    await expect(
      createGoalAsGm(h, { keyword: "S3", stick: -9999 }),
    ).rejects.toThrow(/at least/i);
    // 0 is permitted on either field
    await createGoalAsGm(h, { keyword: "Zeros", carrot: 0, stick: 0 });
  });

  test("create rejected in archived game", async () => {
    const h = await createHarness();
    await archiveGame(h);
    await expect(createGoalAsGm(h, { keyword: "Late" })).rejects.toThrow(
      /archived/i,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Update
// ─────────────────────────────────────────────────────────────────────────

describe("goals: update", () => {
  test("GM can edit every field; non-GM cannot", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "Init",
      description: "old",
      type: "regular",
    });

    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.updateGoal, {
      goalId: id,
      keyword: "Renamed",
      description: "new",
      type: "shared",
      fromPlayerId: h.ids.playerAId,
      toPlayerId: h.ids.playerBId,
      carrot: 7,
      stick: -3,
    });

    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    expect(view.goals[0].keyword).toBe("Renamed");
    expect(view.goals[0].description).toBe("new");
    expect(view.goals[0].type).toBe("shared");
    expect(view.goals[0].fromPlayerId).toBe(h.ids.playerAId);
    expect(view.goals[0].toPlayerId).toBe(h.ids.playerBId);
    expect(view.goals[0].carrot).toBe(7);
    expect(view.goals[0].stick).toBe(-3);

    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.goals.updateGoal, {
        goalId: id,
        keyword: "Hijacked",
      }),
    ).rejects.toThrow(/Game Master/i);
  });

  test("clearing optional fields via explicit null", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "Clear",
      fromPlayerId: h.ids.playerAId,
      toPlayerId: h.ids.playerBId,
      carrot: 10,
      stick: -5,
    });
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.updateGoal, {
      goalId: id,
      fromPlayerId: null,
      toPlayerId: null,
      carrot: null,
      stick: null,
    });
    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    expect(view.goals[0].fromPlayerId).toBeNull();
    expect(view.goals[0].toPlayerId).toBeNull();
    expect(view.goals[0].carrot).toBeNull();
    expect(view.goals[0].stick).toBeNull();
  });

  test("rename to colliding keyword rejected; rename to own (case-only) succeeds", async () => {
    const h = await createHarness();
    const id1 = await createGoalAsGm(h, { keyword: "Echo" });
    await createGoalAsGm(h, { keyword: "Whisper" });

    await expect(
      h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.updateGoal, {
        goalId: id1,
        keyword: "whisper",
      }),
    ).rejects.toThrow(/already exists/i);

    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.updateGoal, {
      goalId: id1,
      keyword: "ECHO",
    });
  });

  test("auto-clear: setting from to existing toPlayerId clears toPlayerId", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "AutoClear",
      fromPlayerId: h.ids.playerAId,
      toPlayerId: h.ids.playerBId,
    });
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.updateGoal, {
      goalId: id,
      fromPlayerId: h.ids.playerBId,
    });
    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    expect(view.goals[0].fromPlayerId).toBe(h.ids.playerBId);
    expect(view.goals[0].toPlayerId).toBeNull();
  });

  test("setting to to existing fromPlayerId is rejected (no silent swap)", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "RejSwap",
      fromPlayerId: h.ids.playerAId,
      toPlayerId: h.ids.playerBId,
    });
    await expect(
      h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.updateGoal, {
        goalId: id,
        toPlayerId: h.ids.playerAId,
      }),
    ).rejects.toThrow(/Clear or change from-player/i);
  });

  test("swapping from and to in one call is allowed", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "Swap",
      fromPlayerId: h.ids.playerAId,
      toPlayerId: h.ids.playerBId,
    });
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.updateGoal, {
      goalId: id,
      fromPlayerId: h.ids.playerBId,
      toPlayerId: h.ids.playerAId,
    });
    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    expect(view.goals[0].fromPlayerId).toBe(h.ids.playerBId);
    expect(view.goals[0].toPlayerId).toBe(h.ids.playerAId);
  });

  test("update is rejected in archived game", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, { keyword: "Frozen" });
    await archiveGame(h);
    await expect(
      h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.updateGoal, {
        goalId: id,
        keyword: "X",
      }),
    ).rejects.toThrow(/archived/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// assignToPlayer (Player-driven path)
// ─────────────────────────────────────────────────────────────────────────

describe("goals: assignToPlayer", () => {
  test("from-player can assign to-player when initially unset", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "Assign",
      fromPlayerId: h.ids.playerAId,
    });
    await startGame(h);
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.goals.assignToPlayer, {
        goalId: id,
        toPlayerId: h.ids.playerBId,
      });
    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    expect(view.goals[0].toPlayerId).toBe(h.ids.playerBId);
  });

  test("GM is rejected (use Edit instead, even with no from)", async () => {
    const h = await createHarness();
    const idOrphan = await createGoalAsGm(h, { keyword: "GmAssignOrphan" });
    const idAlice = await createGoalAsGm(h, {
      keyword: "GmAssignAlice",
      fromPlayerId: h.ids.playerAId,
    });
    for (const id of [idOrphan, idAlice]) {
      await expect(
        h.t
          .withIdentity(asUser(h.ids.gmId))
          .mutation(api.goals.assignToPlayer, {
            goalId: id,
            toPlayerId: h.ids.playerBId,
          }),
      ).rejects.toThrow(/GM does not assign to-player here/i);
    }
  });

  test("rejects every Player when from is unset", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, { keyword: "Unanchored" });
    await startGame(h);
    for (const actor of [h.ids.aId, h.ids.bId]) {
      await expect(
        h.t.withIdentity(asUser(actor)).mutation(api.goals.assignToPlayer, {
          goalId: id,
          toPlayerId: h.ids.playerBId,
        }),
      ).rejects.toThrow(/no from-player/i);
    }
  });

  test("rejects non-from-player even when from is set", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "OnlyFromCan",
      fromPlayerId: h.ids.playerAId,
    });
    await startGame(h);
    await expect(
      h.t.withIdentity(asUser(h.ids.bId)).mutation(api.goals.assignToPlayer, {
        goalId: id,
        toPlayerId: h.ids.playerAId,
      }),
    ).rejects.toThrow(/Only the from-player can assign/i);
  });

  test("rejects non-participant", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "Outside",
      fromPlayerId: h.ids.playerAId,
    });
    await startGame(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .mutation(api.goals.assignToPlayer, {
          goalId: id,
          toPlayerId: h.ids.playerBId,
        }),
    ).rejects.toThrow(/not a participant/i);
  });

  test("rejects from-player after to is set; GM can still change it via updateGoal", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "OneShot",
      fromPlayerId: h.ids.playerAId,
    });
    await startGame(h);
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.goals.assignToPlayer, {
        goalId: id,
        toPlayerId: h.ids.playerBId,
      });
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.goals.assignToPlayer, {
        goalId: id,
        toPlayerId: h.ids.playerAId,
      }),
    ).rejects.toThrow(/already has a to-player/i);

    // GM can still override via updateGoal.
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.updateGoal, {
      goalId: id,
      toPlayerId: null,
    });
  });

  test("rejects from === to self-assign", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "SelfAssign",
      fromPlayerId: h.ids.playerAId,
    });
    await startGame(h);
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.goals.assignToPlayer, {
        goalId: id,
        toPlayerId: h.ids.playerAId,
      }),
    ).rejects.toThrow(/same as from-player/i);
  });

  test("rejected in archived game", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "Frozen",
      fromPlayerId: h.ids.playerAId,
    });
    await startGame(h);
    await archiveGame(h);
    await expect(
      h.t.withIdentity(asUser(h.ids.aId)).mutation(api.goals.assignToPlayer, {
        goalId: id,
        toPlayerId: h.ids.playerBId,
      }),
    ).rejects.toThrow(/archived/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// assignFromPlayer (GM-driven path)
// ─────────────────────────────────────────────────────────────────────────

describe("goals: assignFromPlayer", () => {
  test("GM can give a Goal a from-player when none is set", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, { keyword: "GiveMe" });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.goals.assignFromPlayer, {
        goalId: id,
        fromPlayerId: h.ids.playerAId,
      });
    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    expect(view.goals[0].fromPlayerId).toBe(h.ids.playerAId);
  });

  test("GM can assign-from in playing state too", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, { keyword: "Mid" });
    await startGame(h);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.goals.assignFromPlayer, {
        goalId: id,
        fromPlayerId: h.ids.playerBId,
      });
  });

  test("rejects when from-player is already set (use Edit)", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "Already",
      fromPlayerId: h.ids.playerAId,
    });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.goals.assignFromPlayer, {
          goalId: id,
          fromPlayerId: h.ids.playerBId,
        }),
    ).rejects.toThrow(/already has a from-player/i);
  });

  test("rejects every non-GM caller", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, { keyword: "GmOnly" });
    await startGame(h);
    for (const actor of [h.ids.aId, h.ids.bId, h.ids.outsiderId]) {
      await expect(
        h.t.withIdentity(asUser(actor)).mutation(api.goals.assignFromPlayer, {
          goalId: id,
          fromPlayerId: h.ids.playerAId,
        }),
      ).rejects.toThrow(/Game Master|not authenticated/i);
    }
  });

  test("rejects when new from equals existing to", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "OnlyTo",
      toPlayerId: h.ids.playerBId,
    });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.goals.assignFromPlayer, {
          goalId: id,
          fromPlayerId: h.ids.playerBId,
        }),
    ).rejects.toThrow(/different/i);
  });

  test("rejects cross-game player ids", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, { keyword: "Foreign" });
    const otherPlayerId = await h.t.run(async (ctx) => {
      const otherGameId = await ctx.db.insert("games", {
        name: "Other",
        gmId: h.ids.gmId,
        state: "ready",
      });
      return await ctx.db.insert("players", {
        gameId: otherGameId,
        userId: h.ids.aId,
        power: 0,
        joinedAt: Date.now(),
      });
    });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.goals.assignFromPlayer, {
          goalId: id,
          fromPlayerId: otherPlayerId,
        }),
    ).rejects.toThrow(/does not belong/i);
  });

  test("rejected in archived game", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, { keyword: "Frozen" });
    await startGame(h);
    await archiveGame(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.goals.assignFromPlayer, {
          goalId: id,
          fromPlayerId: h.ids.playerAId,
        }),
    ).rejects.toThrow(/archived/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// clearToPlayer
// ─────────────────────────────────────────────────────────────────────────

describe("goals: clearToPlayer", () => {
  test("GM can clear; idempotent if already cleared; non-GM cannot; archived blocks", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, {
      keyword: "ClearMe",
      fromPlayerId: h.ids.playerAId,
      toPlayerId: h.ids.playerBId,
    });

    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.goals.clearToPlayer, { goalId: id }),
    ).rejects.toThrow(/Game Master/i);

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.goals.clearToPlayer, { goalId: id });
    // idempotent
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.goals.clearToPlayer, { goalId: id });

    await archiveGame(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.goals.clearToPlayer, { goalId: id }),
    ).rejects.toThrow(/archived/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// delete + ledger invariant
// ─────────────────────────────────────────────────────────────────────────

describe("goals: delete and ledger no-op invariant", () => {
  test("GM deletes; non-GM cannot; archived blocks", async () => {
    const h = await createHarness();
    const id = await createGoalAsGm(h, { keyword: "Doomed" });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.goals.deleteGoal, { goalId: id }),
    ).rejects.toThrow(/Game Master/i);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.goals.deleteGoal, { goalId: id });
    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    expect(view.goals).toHaveLength(0);

    const id2 = await createGoalAsGm(h, { keyword: "Late" });
    await archiveGame(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.goals.deleteGoal, { goalId: id2 }),
    ).rejects.toThrow(/archived/i);
  });

  test("Goals never write ledger entries, even with carrot/stick set", async () => {
    const h = await createHarness();
    await createGoalAsGm(h, {
      keyword: "Stakes",
      carrot: 50,
      stick: -50,
      fromPlayerId: h.ids.playerAId,
      toPlayerId: h.ids.playerBId,
    });
    await startGame(h);

    // Player A creates a goal target on themselves (assign-to-player flow).
    const id2 = await createGoalAsGm(h, {
      keyword: "Active",
      fromPlayerId: h.ids.playerAId,
      carrot: 12,
    });
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.goals.assignToPlayer, {
        goalId: id2,
        toPlayerId: h.ids.playerBId,
      });

    // GM updates fields, clears + reassigns to-player.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.goals.clearToPlayer, { goalId: id2 });
    await h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.goals.updateGoal, {
      goalId: id2,
      carrot: null,
      stick: -25,
    });

    // Delete one of them.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.goals.deleteGoal, { goalId: id2 });

    // Reconciliation: both Players should still have power === 0 and
    // zero ledger entries.
    for (const playerId of [h.ids.playerAId, h.ids.playerBId]) {
      const player = await h.t.run(async (ctx) => ctx.db.get(playerId));
      expect(player?.power).toBe(0);
      const entries = await h.t.run(async (ctx) =>
        ctx.db
          .query("powerLedgerEntries")
          .withIndex("by_game_player_time", (q) =>
            q.eq("gameId", h.ids.gameId).eq("playerId", playerId),
          )
          .collect(),
      );
      expect(entries).toHaveLength(0);
      const sum = entries.reduce((s, e) => s + e.delta, 0);
      expect(sum).toBe(player?.power);
    }
  });

  test("deleting a goal cascades and removes its notes", async () => {
    // Plan Task 33.
    const h = await createHarness();
    const goalId = await createGoalAsGm(h, {
      keyword: "Conquer",
      fromPlayerId: h.ids.playerAId,
    });

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "goal",
        targetGoalId: goalId,
        body: "n1",
        visibility: "public",
      });
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "goal",
        targetGoalId: goalId,
        body: "n2",
        visibility: "public",
      });

    const before = await h.t.run(async (ctx) =>
      ctx.db.query("notes").collect(),
    );
    expect(before.filter((n) => n.targetGoalId === goalId)).toHaveLength(2);

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.goals.deleteGoal, { goalId });

    const after = await h.t.run(async (ctx) =>
      ctx.db.query("notes").collect(),
    );
    expect(after.filter((n) => n.targetGoalId === goalId)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Visibility
// ─────────────────────────────────────────────────────────────────────────

describe("goals: visibility (listGoalsForGame)", () => {
  test("GM sees all descriptions; from/to see theirs; others see null", async () => {
    const h = await createHarness();
    // Goal A: from = Alice, to = Bob — both should see description.
    await createGoalAsGm(h, {
      keyword: "Both",
      description: "AB-only payload",
      fromPlayerId: h.ids.playerAId,
      toPlayerId: h.ids.playerBId,
    });
    // Goal B: only from = Alice — only Alice sees description.
    await createGoalAsGm(h, {
      keyword: "FromOnly",
      description: "Alice-only payload",
      fromPlayerId: h.ids.playerAId,
    });
    // Goal C: neither set — only the GM sees description.
    await createGoalAsGm(h, {
      keyword: "Orphan",
      description: "GM-only payload",
    });

    const findByKeyword = async (userId: Id<"users">, keyword: string) => {
      const view = await h.t
        .withIdentity(asUser(userId))
        .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
      return view.goals.find((g) => g.keyword === keyword);
    };

    // GM sees every description.
    expect((await findByKeyword(h.ids.gmId, "Both"))?.description).toBe(
      "AB-only payload",
    );
    expect((await findByKeyword(h.ids.gmId, "FromOnly"))?.description).toBe(
      "Alice-only payload",
    );
    expect((await findByKeyword(h.ids.gmId, "Orphan"))?.description).toBe(
      "GM-only payload",
    );

    // Alice (from on Both + FromOnly) sees those, not Orphan.
    expect((await findByKeyword(h.ids.aId, "Both"))?.description).toBe(
      "AB-only payload",
    );
    expect((await findByKeyword(h.ids.aId, "FromOnly"))?.description).toBe(
      "Alice-only payload",
    );
    expect((await findByKeyword(h.ids.aId, "Orphan"))?.description).toBeNull();

    // Bob (to on Both only) sees Both only.
    expect((await findByKeyword(h.ids.bId, "Both"))?.description).toBe(
      "AB-only payload",
    );
    expect(
      (await findByKeyword(h.ids.bId, "FromOnly"))?.description,
    ).toBeNull();
    expect((await findByKeyword(h.ids.bId, "Orphan"))?.description).toBeNull();
  });

  test("non-participant cannot list", async () => {
    const h = await createHarness();
    await createGoalAsGm(h, { keyword: "Hidden" });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId }),
    ).rejects.toThrow(/not a participant/i);
  });

  test("eligiblePlayers excludes the GM (no players row, rule 11)", async () => {
    const h = await createHarness();
    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    const ids = view.eligiblePlayers.map((p) => p._id).sort();
    const expected = [h.ids.playerAId, h.ids.playerBId].sort();
    expect(ids).toEqual(expected);
  });

  test("canAssignFromPlayer + canAssignToPlayer flags reflect Rule 28 workflow", async () => {
    const h = await createHarness();
    // No from, no to: only GM can assign-from; nobody can assign-to.
    const idOrphan = await createGoalAsGm(h, { keyword: "Orphan" });
    // Alice is from, no to: only Alice can assign-to; nobody can assign-from
    // (use Edit).
    const idAlice = await createGoalAsGm(h, {
      keyword: "AliceFrom",
      fromPlayerId: h.ids.playerAId,
    });
    await startGame(h);

    const gmView = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    const aView = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    const bView = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });

    type FlagRow = {
      _id: Id<"goals">;
      canAssignFromPlayer: boolean;
      canAssignToPlayer: boolean;
    };
    const findFrom = (v: { goals: FlagRow[] }, id: Id<"goals">) =>
      v.goals.find((g) => g._id === id)?.canAssignFromPlayer ?? false;
    const findTo = (v: { goals: FlagRow[] }, id: Id<"goals">) =>
      v.goals.find((g) => g._id === id)?.canAssignToPlayer ?? false;

    // canAssignFromPlayer: only GM, only when from is unset.
    expect(findFrom(gmView, idOrphan)).toBe(true);
    expect(findFrom(gmView, idAlice)).toBe(false);
    expect(findFrom(aView, idOrphan)).toBe(false);
    expect(findFrom(aView, idAlice)).toBe(false);
    expect(findFrom(bView, idOrphan)).toBe(false);
    expect(findFrom(bView, idAlice)).toBe(false);

    // canAssignToPlayer: only the from-player, only when to is unset.
    expect(findTo(gmView, idOrphan)).toBe(false);
    expect(findTo(gmView, idAlice)).toBe(false);
    expect(findTo(aView, idOrphan)).toBe(false);
    expect(findTo(aView, idAlice)).toBe(true);
    expect(findTo(bView, idOrphan)).toBe(false);
    expect(findTo(bView, idAlice)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────

describe("goals: ordering", () => {
  test("listGoalsForGame sorts by viewer-relevance group then keyword (case-insensitive)", async () => {
    const h = await createHarness();
    // Create four goals exercising every group rank for viewer = Alice.
    //  Zulu:   to = Alice          → group 0 (to-me)
    //  Yankee: from = Alice        → group 1 (from-me)
    //  Alpha:  from = Bob          → group 2 (assigned, not Alice)
    //  Mango:  no assignment       → group 3 (unassigned)
    await createGoalAsGm(h, { keyword: "Zulu", toPlayerId: h.ids.playerAId });
    await createGoalAsGm(h, {
      keyword: "Yankee",
      fromPlayerId: h.ids.playerAId,
    });
    await createGoalAsGm(h, {
      keyword: "Alpha",
      fromPlayerId: h.ids.playerBId,
    });
    await createGoalAsGm(h, { keyword: "Mango" });

    const view = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.goals.listGoalsForGame, { gameId: h.ids.gameId });
    expect(view.goals.map((g) => g.keyword)).toEqual([
      "Zulu",
      "Yankee",
      "Alpha",
      "Mango",
    ]);
  });
});
