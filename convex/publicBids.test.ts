/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/**
 * Convex Auth derives the user id from `identity.subject` by splitting
 * on `|` (mirrors the helper in `treasonGrants.test.ts`).
 */
function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * 4 users: GM, Alice, Bob, Carol (all Players), and an Outsider. All
 * three players join the same game with a shared syndicate. Started
 * via `startGame(h)` in tests that need `playing`.
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
    const cId = await ctx.db.insert("users", {
      displayName: "Carol",
      email: "c@test",
    });
    const outsiderId = await ctx.db.insert("users", {
      displayName: "Outsider",
      email: "o@test",
    });

    const syndicateId = await ctx.db.insert("syndicates", {
      name: "Shared",
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
    const playerCId = await ctx.db.insert("players", {
      gameId,
      userId: cId,
      selectedSyndicateId: syndicateId,
      power: 0,
      joinedAt: Date.now() + 2,
    });

    return {
      gmId,
      aId,
      bId,
      cId,
      outsiderId,
      syndicateId,
      gameId,
      playerAId,
      playerBId,
      playerCId,
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

async function startBidRound(
  h: Harness,
  label?: string,
): Promise<Id<"bidRounds">> {
  return await h.t
    .withIdentity(asUser(h.ids.gmId))
    .mutation(api.publicBids.startBidRound, {
      gameId: h.ids.gameId,
      label,
    });
}

async function placeBid(
  h: Harness,
  userId: Id<"users">,
  roundId: Id<"bidRounds">,
  amount: number,
) {
  await h.t
    .withIdentity(asUser(userId))
    .mutation(api.publicBids.placeBid, { roundId, amount });
}

async function getLedger(h: Harness, playerId: Id<"players">) {
  return await h.t.run(async (ctx) =>
    ctx.db
      .query("powerLedgerEntries")
      .withIndex("by_game_player_time", (q) =>
        q.eq("gameId", h.ids.gameId).eq("playerId", playerId),
      )
      .collect(),
  );
}

async function getPlayerPower(h: Harness, playerId: Id<"players">) {
  const p = await h.t.run(async (ctx) => ctx.db.get(playerId));
  return p?.power ?? null;
}

// ─── Task 22: start round ─────────────────────────────────────────────

describe("publicBids: startBidRound", () => {
  test("GM can start in `playing`; players + outsider cannot", async () => {
    const h = await createHarness();
    await startGame(h);
    const id = await startBidRound(h, "Auction");
    expect(id).toBeTruthy();

    // Need to archive before starting another.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: id });

    for (const actor of [h.ids.aId, h.ids.bId, h.ids.outsiderId]) {
      await expect(
        h.t.withIdentity(asUser(actor)).mutation(api.publicBids.startBidRound, {
          gameId: h.ids.gameId,
        }),
      ).rejects.toThrow(/Game Master|not authenticated/i);
    }
  });

  test("starting in `ready` is rejected", async () => {
    const h = await createHarness();
    await expect(startBidRound(h)).rejects.toThrow(/playing/i);
  });

  test("starting in `archived` is rejected", async () => {
    const h = await createHarness();
    await startGame(h);
    await archiveGame(h);
    await expect(startBidRound(h)).rejects.toThrow(/playing/i);
  });

  test("only one non-archived round at a time (open blocks)", async () => {
    const h = await createHarness();
    await startGame(h);
    await startBidRound(h);
    await expect(startBidRound(h)).rejects.toThrow(/already active/i);
  });

  test("only one non-archived round at a time (closed blocks)", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 3);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.closeBidRound, { roundId: r });
    await expect(startBidRound(h)).rejects.toThrow(/already active/i);
  });

  test("starting after the previous round was archived succeeds", async () => {
    const h = await createHarness();
    await startGame(h);
    const r1 = await startBidRound(h);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r1 });
    const r2 = await startBidRound(h);
    expect(r2).toBeTruthy();
  });

  test("label is trimmed; empty/whitespace becomes undefined; >120 chars rejected", async () => {
    const h = await createHarness();
    await startGame(h);

    // Trims to "Auction".
    const r1 = await startBidRound(h, "  Auction  ");
    const r1Doc = await h.t.run(async (ctx) => ctx.db.get(r1));
    expect(r1Doc?.label).toBe("Auction");

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r1 });

    // Whitespace-only → undefined.
    const r2 = await startBidRound(h, "   ");
    const r2Doc = await h.t.run(async (ctx) => ctx.db.get(r2));
    expect(r2Doc?.label).toBeUndefined();

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r2 });

    await expect(startBidRound(h, "x".repeat(121))).rejects.toThrow(/120/);
  });
});

// ─── Task 23: place bid ───────────────────────────────────────────────

describe("publicBids: placeBid", () => {
  test("Player can place 0 / positive; re-submit same; change amount; change to 0", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 0);
    await placeBid(h, h.ids.aId, r, 5);
    await placeBid(h, h.ids.aId, r, 5); // idempotent re-submit
    await placeBid(h, h.ids.aId, r, 7); // change amount
    await placeBid(h, h.ids.aId, r, 0); // withdraw

    // Should be exactly one bid row for Alice.
    const bids = await h.t.run(async (ctx) =>
      ctx.db
        .query("bids")
        .withIndex("by_round_player", (q) =>
          q.eq("roundId", r).eq("playerId", h.ids.playerAId),
        )
        .collect(),
    );
    expect(bids).toHaveLength(1);
    expect(bids[0].amount).toBe(0);
  });

  test("two players cannot share a non-zero amount; both can be 0", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 5);
    await expect(placeBid(h, h.ids.bId, r, 5)).rejects.toThrow(
      /already taken/i,
    );
    // Both can bid 0.
    await placeBid(h, h.ids.aId, r, 0);
    await placeBid(h, h.ids.bId, r, 0);
  });

  test("non-participant rejected; GM rejected (no players row)", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await expect(placeBid(h, h.ids.outsiderId, r, 1)).rejects.toThrow(
      /not a Player/i,
    );
    await expect(placeBid(h, h.ids.gmId, r, 1)).rejects.toThrow(
      /not a Player/i,
    );
  });

  test("placeBid rejected on closed/archived round", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 1);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.closeBidRound, { roundId: r });
    await expect(placeBid(h, h.ids.bId, r, 2)).rejects.toThrow(/not open/i);

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r });
    await expect(placeBid(h, h.ids.bId, r, 2)).rejects.toThrow(/not open/i);
  });

  test("placeBid rejected when game is archived", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await archiveGame(h);
    await expect(placeBid(h, h.ids.aId, r, 1)).rejects.toThrow(/playing/i);
  });

  test("negative, non-integer, and above-cap amounts rejected", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await expect(placeBid(h, h.ids.aId, r, -1)).rejects.toThrow(/at least 0/i);
    await expect(placeBid(h, h.ids.aId, r, 1.5)).rejects.toThrow(/integer/i);
    await expect(placeBid(h, h.ids.aId, r, 9999)).rejects.toThrow(/at most/i);
  });
});

// ─── Task 24: close round (settle) ────────────────────────────────────

describe("publicBids: closeBidRound", () => {
  test("settles non-zero bids, skips zeros, ledger reconciles", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h, "Auction A");

    await placeBid(h, h.ids.aId, r, 7);
    await placeBid(h, h.ids.bId, r, 3);
    await placeBid(h, h.ids.cId, r, 0);

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.closeBidRound, { roundId: r });

    // Alice: -7
    const aLedger = await getLedger(h, h.ids.playerAId);
    expect(aLedger).toHaveLength(1);
    expect(aLedger[0].source).toBe("bid");
    expect(aLedger[0].delta).toBe(-7);
    expect(aLedger[0].reason).toBe("Auction A");
    expect(await getPlayerPower(h, h.ids.playerAId)).toBe(-7);

    // Bob: -3
    const bLedger = await getLedger(h, h.ids.playerBId);
    expect(bLedger).toHaveLength(1);
    expect(bLedger[0].source).toBe("bid");
    expect(bLedger[0].delta).toBe(-3);
    expect(await getPlayerPower(h, h.ids.playerBId)).toBe(-3);

    // Carol: zero bid → no ledger entry, no power change.
    const cLedger = await getLedger(h, h.ids.playerCId);
    expect(cLedger).toHaveLength(0);
    expect(await getPlayerPower(h, h.ids.playerCId)).toBe(0);

    // Round transitions to closed.
    const round = await h.t.run(async (ctx) => ctx.db.get(r));
    expect(round?.status).toBe("closed");
    expect(round?.closedAt).toBeTypeOf("number");
    expect(round?.archivedAt).toBeUndefined();

    // Subsequent place/close rejected.
    await expect(placeBid(h, h.ids.aId, r, 4)).rejects.toThrow(/not open/i);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.publicBids.closeBidRound, { roundId: r }),
    ).rejects.toThrow(/not open/i);

    // Archive succeeds.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r });
    const r2 = await h.t.run(async (ctx) => ctx.db.get(r));
    expect(r2?.status).toBe("archived");
  });

  test("missing label falls back to 'Public bid' in ledger reason", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 2);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.closeBidRound, { roundId: r });
    const aLedger = await getLedger(h, h.ids.playerAId);
    expect(aLedger[0].reason).toBe("Public bid");
  });

  test("non-GM cannot close", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.aId))
        .mutation(api.publicBids.closeBidRound, { roundId: r }),
    ).rejects.toThrow(/Game Master/i);
  });
});

// ─── Task 25: archive from open (cancel) ──────────────────────────────

describe("publicBids: archive from open (cancel)", () => {
  test("no settlement; closedAt remains undefined; subsequent ops rejected", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 5);
    await placeBid(h, h.ids.bId, r, 3);

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r });

    const round = await h.t.run(async (ctx) => ctx.db.get(r));
    expect(round?.status).toBe("archived");
    expect(round?.archivedAt).toBeTypeOf("number");
    expect(round?.closedAt).toBeUndefined();

    // No ledger entries written.
    expect(await getLedger(h, h.ids.playerAId)).toHaveLength(0);
    expect(await getLedger(h, h.ids.playerBId)).toHaveLength(0);
    expect(await getPlayerPower(h, h.ids.playerAId)).toBe(0);
    expect(await getPlayerPower(h, h.ids.playerBId)).toBe(0);

    await expect(placeBid(h, h.ids.aId, r, 1)).rejects.toThrow(/not open/i);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.publicBids.closeBidRound, { roundId: r }),
    ).rejects.toThrow(/not open/i);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.publicBids.archiveBidRound, { roundId: r }),
    ).rejects.toThrow(/already archived/i);

    // A new round can be started.
    const r2 = await startBidRound(h);
    expect(r2).toBeTruthy();
  });
});

// ─── Task 26: archive from closed ─────────────────────────────────────

describe("publicBids: archive from closed", () => {
  test("preserves closedAt, no extra ledger entries, power unchanged", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 4);

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.closeBidRound, { roundId: r });

    const beforeLedger = await getLedger(h, h.ids.playerAId);
    const beforePower = await getPlayerPower(h, h.ids.playerAId);

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r });

    const round = await h.t.run(async (ctx) => ctx.db.get(r));
    expect(round?.status).toBe("archived");
    expect(round?.closedAt).toBeTypeOf("number");
    expect(round?.archivedAt).toBeTypeOf("number");

    expect(await getLedger(h, h.ids.playerAId)).toHaveLength(
      beforeLedger.length,
    );
    expect(await getPlayerPower(h, h.ids.playerAId)).toBe(beforePower);

    // A new round can be started.
    const r2 = await startBidRound(h);
    expect(r2).toBeTruthy();
  });
});

// ─── Task 27: archive in archived game ────────────────────────────────

describe("publicBids: archive in archived game", () => {
  test("closed round can still be archived after game is archived", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 2);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.closeBidRound, { roundId: r });
    await archiveGame(h);
    // Archive bid succeeds even though game is archived.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r });
    const round = await h.t.run(async (ctx) => ctx.db.get(r));
    expect(round?.status).toBe("archived");
  });

  test("open round can still be cancel-archived after game is archived", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 2);
    await archiveGame(h);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r });
    const round = await h.t.run(async (ctx) => ctx.db.get(r));
    expect(round?.status).toBe("archived");
    expect(round?.closedAt).toBeUndefined();
    // No ledger entries written.
    expect(await getLedger(h, h.ids.playerAId)).toHaveLength(0);
  });
});

// ─── Task 28: negative POWER ──────────────────────────────────────────

describe("publicBids: negative POWER on close", () => {
  test("a player with power=2 bidding 5 ends at -3", async () => {
    const h = await createHarness();
    await startGame(h);

    // Seed Alice's power to 2 via a GM bank credit.
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.ledger.gmEditPower, {
        gameId: h.ids.gameId,
        playerId: h.ids.playerAId,
        delta: 2,
        reason: "seed",
      });
    expect(await getPlayerPower(h, h.ids.playerAId)).toBe(2);

    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 5);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.closeBidRound, { roundId: r });

    expect(await getPlayerPower(h, h.ids.playerAId)).toBe(-3);

    // Reconciliation invariant.
    const aLedger = await getLedger(h, h.ids.playerAId);
    const sum = aLedger.reduce((s, e) => s + e.delta, 0);
    expect(sum).toBe(-3);
  });
});

// ─── Task 29: visibility (active) ─────────────────────────────────────

describe("publicBids: visibility (active round)", () => {
  test("getActiveBidRound returns same shape to GM and Players; outsider rejected", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h, "Bid 1");
    await placeBid(h, h.ids.aId, r, 5);
    await placeBid(h, h.ids.bId, r, 0);
    // Carol does not bid.

    const gmView = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.publicBids.getActiveBidRound, { gameId: h.ids.gameId });
    expect(gmView.round?._id).toBe(r);
    expect(gmView.round?.status).toBe("open");
    expect(gmView.round?.label).toBe("Bid 1");
    expect(gmView.bids).toHaveLength(2);
    expect(gmView.bids[0].amount).toBe(5);
    expect(gmView.bids[0].displayName).toBe("Alice");
    expect(gmView.bids[1].amount).toBe(0);
    expect(gmView.viewerRole).toBe("gm");
    // Carol still pending; Alice and Bob are not.
    expect(gmView.pending.map((p) => p.displayName)).toEqual(["Carol"]);

    const aView = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.publicBids.getActiveBidRound, { gameId: h.ids.gameId });
    expect(aView.viewerRole).toBe("player");
    expect(aView.viewerPlayerId).toBe(h.ids.playerAId);
    const aliceRow = aView.bids.find((b) => b.playerId === h.ids.playerAId);
    expect(aliceRow?.isMine).toBe(true);
    const bobRow = aView.bids.find((b) => b.playerId === h.ids.playerBId);
    expect(bobRow?.isMine).toBe(false);

    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .query(api.publicBids.getActiveBidRound, { gameId: h.ids.gameId }),
    ).rejects.toThrow(/not a participant/i);
  });

  test("closed round still surfaced via getActiveBidRound (status=closed)", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 3);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.closeBidRound, { roundId: r });

    const view = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.publicBids.getActiveBidRound, { gameId: h.ids.gameId });
    expect(view.round?.status).toBe("closed");
    expect(view.round?.closedAt).toBeTypeOf("number");
  });
});

// ─── Task 30: visibility (archived) ───────────────────────────────────

describe("publicBids: visibility (archived)", () => {
  test("getActiveBidRound is null after archive; listArchivedBidRounds + getRoundBids work", async () => {
    const h = await createHarness();
    await startGame(h);

    // Settled round.
    const r1 = await startBidRound(h, "Settled");
    await placeBid(h, h.ids.aId, r1, 5);
    await placeBid(h, h.ids.bId, r1, 3);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.closeBidRound, { roundId: r1 });
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r1 });

    // Cancelled round.
    const r2 = await startBidRound(h, "Cancelled");
    await placeBid(h, h.ids.cId, r2, 2);
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.publicBids.archiveBidRound, { roundId: r2 });

    // No active round visible.
    const gmActive = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.publicBids.getActiveBidRound, { gameId: h.ids.gameId });
    expect(gmActive.round).toBeNull();

    const aActive = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.publicBids.getActiveBidRound, { gameId: h.ids.gameId });
    expect(aActive.round).toBeNull();

    // Archived list, descending by archivedAt: r2 (most recent) first.
    const list = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.publicBids.listArchivedBidRounds, { gameId: h.ids.gameId });
    expect(list).toHaveLength(2);
    expect(list[0]._id).toBe(r2);
    expect(list[0].wasSettled).toBe(false);
    expect(list[0].totalPaid).toBe(0);
    expect(list[0].bidCount).toBe(1);
    expect(list[1]._id).toBe(r1);
    expect(list[1].wasSettled).toBe(true);
    expect(list[1].totalPaid).toBe(8);
    expect(list[1].bidCount).toBe(2);

    // Drilldown.
    const drill = await h.t
      .withIdentity(asUser(h.ids.aId))
      .query(api.publicBids.getRoundBids, { roundId: r1 });
    expect(drill?.round.status).toBe("archived");
    expect(drill?.bids.map((b) => b.displayName).sort()).toEqual([
      "Alice",
      "Bob",
    ]);

    // Outsider rejected from list/drill.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .query(api.publicBids.listArchivedBidRounds, { gameId: h.ids.gameId }),
    ).rejects.toThrow(/not a participant/i);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .query(api.publicBids.getRoundBids, { roundId: r1 }),
    ).rejects.toThrow(/not a participant/i);
  });
});

// ─── Task 31: race on uniqueness (sequential) ─────────────────────────

describe("publicBids: uniqueness race (sequential)", () => {
  test("after one player commits at amount=5, another at amount=5 is rejected", async () => {
    const h = await createHarness();
    await startGame(h);
    const r = await startBidRound(h);
    await placeBid(h, h.ids.aId, r, 5);
    await expect(placeBid(h, h.ids.bId, r, 5)).rejects.toThrow(
      /already taken/i,
    );
  });
});
