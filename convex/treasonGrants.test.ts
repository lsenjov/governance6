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
 * Shared setup: 3 users (GM, Alice, Bob, plus an outsider). Alice owns
 * a syndicate selected by both Players. The game is created in `ready`
 * and starts in tests that need `playing` via `startGame(h)`.
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

async function createGrant(
  h: Harness,
  fields: { keyword: string; power: number; description?: string },
): Promise<Id<"treasonGrants">> {
  return await h.t
    .withIdentity(asUser(h.ids.gmId))
    .mutation(api.treasonGrants.createGrant, {
      gameId: h.ids.gameId,
      keyword: fields.keyword,
      power: fields.power,
      description: fields.description ?? "",
    });
}

describe("treasonGrants: create authorisation + validation", () => {
  test("GM can create a grant; non-GM cannot", async () => {
    const h = await createHarness();
    const id = await createGrant(h, {
      keyword: "Whisper",
      power: 5,
      description: "Owner secret",
    });
    expect(id).toBeTruthy();

    for (const actor of [h.ids.aId, h.ids.bId, h.ids.outsiderId]) {
      await expect(
        h.t
          .withIdentity(asUser(actor))
          .mutation(api.treasonGrants.createGrant, {
            gameId: h.ids.gameId,
            keyword: "Sneaky",
            power: 3,
            description: "x",
          }),
      ).rejects.toThrow(/Game Master|not authenticated/i);
    }
  });

  test("keyword length and POWER bounds are enforced", async () => {
    const h = await createHarness();
    await expect(createGrant(h, { keyword: "   ", power: 1 })).rejects.toThrow(
      /empty/i,
    );
    await expect(
      createGrant(h, { keyword: "a".repeat(41), power: 1 }),
    ).rejects.toThrow(/40/);
    await expect(createGrant(h, { keyword: "ok", power: 0 })).rejects.toThrow(
      /at least 1/i,
    );
    await expect(createGrant(h, { keyword: "ok", power: -3 })).rejects.toThrow(
      /at least 1/i,
    );
    await expect(createGrant(h, { keyword: "ok", power: 1.5 })).rejects.toThrow(
      /integer/i,
    );
    await expect(
      createGrant(h, { keyword: "ok", power: 99999 }),
    ).rejects.toThrow(/at most/i);
  });

  test("keyword uniqueness is per-game and case-insensitive", async () => {
    const h = await createHarness();
    await createGrant(h, { keyword: "Whisper", power: 5 });
    await expect(
      createGrant(h, { keyword: "whisper", power: 7 }),
    ).rejects.toThrow(/already exists/i);
    await expect(
      createGrant(h, { keyword: "  WHISPER  ", power: 7 }),
    ).rejects.toThrow(/already exists/i);

    // Same keyword in a different game is fine.
    const otherGameId = await h.t.run(async (ctx) => {
      return await ctx.db.insert("games", {
        name: "Other",
        gmId: h.ids.gmId,
        state: "ready",
      });
    });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.treasonGrants.createGrant, {
        gameId: otherGameId,
        keyword: "Whisper",
        power: 5,
        description: "",
      });
  });

  test("create is rejected in archived game", async () => {
    const h = await createHarness();
    await archiveGame(h);
    await expect(createGrant(h, { keyword: "Late", power: 5 })).rejects.toThrow(
      /archived/i,
    );
  });
});

describe("treasonGrants: update", () => {
  test("GM can edit keyword and description on an unowned grant", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, {
      keyword: "Whisper",
      power: 5,
      description: "old",
    });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.treasonGrants.updateGrant, {
        grantId,
        keyword: "Murmur",
        description: "new",
        power: 9,
      });
    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId });
    expect(view.grants[0].keyword).toBe("Murmur");
    expect(view.grants[0].description).toBe("new");
    expect(view.grants[0].power).toBe(9);
  });

  test("non-GM cannot update", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 5 });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.treasonGrants.updateGrant, {
          grantId,
          keyword: "Hijack",
        }),
    ).rejects.toThrow(/Game Master/i);
  });

  test("rename to a colliding keyword is rejected; renaming to own keyword is a no-op", async () => {
    const h = await createHarness();
    const id1 = await createGrant(h, { keyword: "Whisper", power: 5 });
    await createGrant(h, { keyword: "Echo", power: 7 });

    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.treasonGrants.updateGrant, {
          grantId: id1,
          keyword: "echo",
        }),
    ).rejects.toThrow(/already exists/i);

    // Same keyword (different case) on self is allowed (it's the same row).
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.treasonGrants.updateGrant, {
        grantId: id1,
        keyword: "WHISPER",
      });
  });

  test("POWER is locked once a grant is taken; keyword and description still editable", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, {
      keyword: "Whisper",
      power: 5,
      description: "secret",
    });
    await startGame(h);
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId });

    // POWER edit rejected.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.treasonGrants.updateGrant, {
          grantId,
          power: 99,
        }),
    ).rejects.toThrow(/POWER cannot be changed/i);

    // Keyword + description still editable.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.treasonGrants.updateGrant, {
        grantId,
        keyword: "Murmur",
        description: "fixed typo",
      });
    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId });
    expect(view.grants[0].keyword).toBe("Murmur");
    expect(view.grants[0].description).toBe("fixed typo");
    expect(view.grants[0].power).toBe(5);
  });
});

describe("treasonGrants: delete", () => {
  test("GM can delete; non-GM cannot", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 5 });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.treasonGrants.deleteGrant, { grantId }),
    ).rejects.toThrow(/Game Master/i);

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.treasonGrants.deleteGrant, { grantId });

    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId });
    expect(view.grants).toHaveLength(0);
  });

  test("deleting a taken grant does NOT reverse POWER or write a ledger entry", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 7 });
    await startGame(h);
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId });

    const beforePlayer = await h.t.run(async (ctx) =>
      ctx.db.get(h.ids.playerAId),
    );
    const beforeLedgerCount = await h.t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("powerLedgerEntries")
            .withIndex("by_game_player_time", (q) =>
              q.eq("gameId", h.ids.gameId).eq("playerId", h.ids.playerAId),
            )
            .collect()
        ).length,
    );

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.treasonGrants.deleteGrant, { grantId });

    const afterPlayer = await h.t.run(async (ctx) =>
      ctx.db.get(h.ids.playerAId),
    );
    const afterLedgerCount = await h.t.run(
      async (ctx) =>
        (
          await ctx.db
            .query("powerLedgerEntries")
            .withIndex("by_game_player_time", (q) =>
              q.eq("gameId", h.ids.gameId).eq("playerId", h.ids.playerAId),
            )
            .collect()
        ).length,
    );
    expect(afterPlayer?.power).toBe(beforePlayer?.power);
    expect(afterLedgerCount).toBe(beforeLedgerCount);
  });

  test("delete is rejected in archived game", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 5 });
    await archiveGame(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.treasonGrants.deleteGrant, { grantId }),
    ).rejects.toThrow(/archived/i);
  });

  test("deleting a grant cascades and removes its notes", async () => {
    // Plan Task 33.
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 5 });

    // Author a couple of notes on the grant.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
        body: "n1",
        visibility: "public",
      });
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "grant",
        targetGrantId: grantId,
        body: "n2",
        visibility: "public",
      });

    const beforeAll = await h.t.run(async (ctx) =>
      ctx.db.query("notes").collect(),
    );
    expect(beforeAll.filter((n) => n.targetGrantId === grantId)).toHaveLength(
      2,
    );

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.treasonGrants.deleteGrant, { grantId });

    const afterAll = await h.t.run(async (ctx) =>
      ctx.db.query("notes").collect(),
    );
    expect(afterAll.filter((n) => n.targetGrantId === grantId)).toHaveLength(0);
  });
});

describe("treasonGrants: clearGrantOwner", () => {
  test("clearing owner does not refund POWER and re-opens the grant for re-take", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 6 });
    await startGame(h);

    // Alice takes; Alice's POWER goes from 0 → +6.
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId });
    const aAfterTake = await h.t.run(async (ctx) =>
      ctx.db.get(h.ids.playerAId),
    );
    expect(aAfterTake?.power).toBe(6);

    // GM clears the owner.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.treasonGrants.clearGrantOwner, { grantId });

    // Alice still has +6.
    const aAfterClear = await h.t.run(async (ctx) =>
      ctx.db.get(h.ids.playerAId),
    );
    expect(aAfterClear?.power).toBe(6);

    // Bob can now take it and gets +6 too.
    await h.t
      .withIdentity(asUser(h.ids.bId))
      .mutation(api.treasonGrants.takeGrant, { grantId });
    const bAfterTake = await h.t.run(async (ctx) =>
      ctx.db.get(h.ids.playerBId),
    );
    expect(bAfterTake?.power).toBe(6);
  });

  test("clearing an unowned grant is a no-op", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 5 });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.treasonGrants.clearGrantOwner, { grantId });
  });

  test("non-GM cannot clear; archived game blocks clear", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 5 });
    await startGame(h);
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId });

    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.treasonGrants.clearGrantOwner, { grantId }),
    ).rejects.toThrow(/Game Master/i);

    await archiveGame(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.treasonGrants.clearGrantOwner, { grantId }),
    ).rejects.toThrow(/archived/i);
  });
});

describe("treasonGrants: take", () => {
  test("Player can take an unowned grant in `playing`; POWER + ledger update atomically", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, {
      keyword: "Whisper",
      power: 7,
      description: "secret",
    });
    await startGame(h);
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId });

    const player = await h.t.run(async (ctx) => ctx.db.get(h.ids.playerAId));
    expect(player?.power).toBe(7);

    const entries = await h.t.run(async (ctx) =>
      ctx.db
        .query("powerLedgerEntries")
        .withIndex("by_game_player_time", (q) =>
          q.eq("gameId", h.ids.gameId).eq("playerId", h.ids.playerAId),
        )
        .collect(),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("treason_grant");
    expect(entries[0].delta).toBe(7);
    expect(entries[0].reason).toContain("Whisper");

    // Reconciliation: sum(deltas) === players.power for Alice.
    const sum = entries.reduce((s, e) => s + e.delta, 0);
    expect(sum).toBe(player?.power);
  });

  test("GM cannot take (no players row)", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 5 });
    await startGame(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.treasonGrants.takeGrant, { grantId }),
    ).rejects.toThrow(/not a Player/i);
  });

  test("non-participant cannot take", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 5 });
    await startGame(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .mutation(api.treasonGrants.takeGrant, { grantId }),
    ).rejects.toThrow(/not a Player/i);
  });

  test("take is rejected in `ready` and `archived`", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 5 });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.treasonGrants.takeGrant, { grantId }),
    ).rejects.toThrow(/playing/i);

    await startGame(h);
    await archiveGame(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.treasonGrants.takeGrant, { grantId }),
    ).rejects.toThrow(/playing/i);
  });

  test("taking an already-owned grant is rejected", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, { keyword: "Whisper", power: 5 });
    await startGame(h);
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.bId))
        .mutation(api.treasonGrants.takeGrant, { grantId }),
    ).rejects.toThrow(/already been taken/i);
  });

  test("a single player may take multiple grants (no per-player cap)", async () => {
    const h = await createHarness();
    const g1 = await createGrant(h, { keyword: "One", power: 3 });
    const g2 = await createGrant(h, { keyword: "Two", power: 4 });
    await startGame(h);
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId: g1 });
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId: g2 });
    const player = await h.t.run(async (ctx) => ctx.db.get(h.ids.playerAId));
    expect(player?.power).toBe(7);
  });
});

describe("treasonGrants: visibility", () => {
  test("GM sees every description; owner sees own description; others see null", async () => {
    const h = await createHarness();
    const grantId = await createGrant(h, {
      keyword: "Whisper",
      power: 7,
      description: "Alice's payload",
    });
    await startGame(h);

    // Before take: even Alice cannot see the description (she doesn't own it).
    const aBefore = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId });
    expect(aBefore.grants[0].description).toBeNull();
    expect(aBefore.grants[0].canTake).toBe(true);

    const gmView = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId });
    expect(gmView.grants[0].description).toBe("Alice's payload");
    expect(gmView.grants[0].canTake).toBe(false);
    expect(gmView.grants[0].canEditPower).toBe(true);

    // Alice takes; her view now includes the description.
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId });

    const aAfter = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId });
    expect(aAfter.grants[0].description).toBe("Alice's payload");
    expect(aAfter.grants[0].isMine).toBe(true);
    expect(aAfter.grants[0].canTake).toBe(false);

    // Bob cannot see the description.
    const bAfter = await h.t
      .withIdentity(asUser(h.ids.bId))
      .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId });
    expect(bAfter.grants[0].description).toBeNull();
    expect(bAfter.grants[0].isMine).toBe(false);
    expect(bAfter.grants[0].ownerDisplayName).toBe("Alice");
    expect(bAfter.grants[0].canTake).toBe(false);

    // Edit-power is locked for GM after take.
    const gmAfter = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId });
    expect(gmAfter.grants[0].canEditPower).toBe(false);
  });

  test("non-participants cannot list", async () => {
    const h = await createHarness();
    await createGrant(h, { keyword: "Whisper", power: 5 });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId }),
    ).rejects.toThrow(/not a participant/i);
  });
});

describe("treasonGrants: ordering", () => {
  test("listGrantsForGame sorts by ownership group then keyword (case-insensitive)", async () => {
    const h = await createHarness();
    // Create three grants in non-final order to exercise the sort.
    const zebra = await createGrant(h, { keyword: "Zebra", power: 1 });
    const alpha = await createGrant(h, { keyword: "Alpha", power: 1 });
    await createGrant(h, { keyword: "Mango", power: 1 });
    await startGame(h);

    // Alice takes Zebra → viewer-owned (group 0).
    await h.t
      .withIdentity(asUser(h.ids.aId))
      .mutation(api.treasonGrants.takeGrant, { grantId: zebra });
    // Bob takes Alpha → other-owned for Alice (group 1).
    await h.t
      .withIdentity(asUser(h.ids.bId))
      .mutation(api.treasonGrants.takeGrant, { grantId: alpha });
    // Mango remains unclaimed (group 2).

    const view = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.treasonGrants.listGrantsForGame, { gameId: h.ids.gameId });
    expect(view.grants.map((g) => g.keyword)).toEqual([
      "Zebra",
      "Alpha",
      "Mango",
    ]);
  });
});
