import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireGame,
  requireGameGm,
  requireGamePlayer,
  requireGameParticipant,
} from "./lib/auth";

/**
 * Public Bids — Rule 27.
 *
 * Per-game GM-driven ceremony. The GM opens a round; every Player
 * simultaneously submits a non-negative integer POWER amount; everyone
 * sees everyone else's bids sorted by amount descending in real time;
 * non-zero bid amounts must be unique across the round; on close, every
 * non-zero bid is paid to the bank atomically (one ledger entry per
 * non-zero bidder, `players.power` patched in the same transaction);
 * on archive, the round disappears from the main panel and is only
 * viewable from the Game Log drawer.
 *
 * Lifecycle (Decision 3):
 *   open → closed   (GM Close (collect): settles non-zero bids).
 *   open → archived (GM Cancel (no payment): no settlement.)
 *   closed → archived (GM Archive: hides the result snapshot.)
 *
 * Game-state gates (Decision 4):
 *   start / place / close: game must be `playing`.
 *   archive: game may be `playing` OR `archived` (so the GM can clean
 *            up rounds left active when the game itself was archived).
 *
 * At most one non-archived round per game at any time (Decision 4).
 *
 * Rule 19's `source` enum is extended with `"bid"` (Decision 13).
 *
 * See `plans/2026-04-27-public-bids-v1.md`.
 */

const LABEL_MIN = 1;
const LABEL_MAX = 120;
const AMOUNT_MIN = 0;
const AMOUNT_MAX = 100;

/**
 * Decision 4: every POWER-moving operation requires `playing`. Returns
 * the loaded game doc. Used by `startBidRound`, `placeBid`,
 * `closeBidRound`. NOT used by `archiveBidRound`, which is allowed
 * in `archived` games (Decision 4) so the GM can clean up rounds left
 * active when the game itself was archived.
 */
async function assertGameLive(
  ctx: MutationCtx,
  gameId: Id<"games">,
): Promise<Doc<"games">> {
  const game = await requireGame(ctx, gameId);
  if (game.state !== "playing") {
    throw new Error(
      "Public Bids actions are only allowed while the game is playing.",
    );
  }
  return game;
}

/**
 * Loads the round, asserts `status === "open"`, asserts the parent
 * game is `"playing"`. Returns `{ round, game }`. Auth (GM vs Player)
 * is the caller's responsibility.
 */
async function requireOpenRound(
  ctx: MutationCtx,
  roundId: Id<"bidRounds">,
): Promise<{ round: Doc<"bidRounds">; game: Doc<"games"> }> {
  const round = await ctx.db.get(roundId);
  if (!round) throw new Error("Bid round not found.");
  if (round.status !== "open") {
    throw new Error("This bid round is not open.");
  }
  const game = await assertGameLive(ctx, round.gameId);
  return { round, game };
}

/**
 * Loads the round, asserts `status !== "archived"`. Does NOT assert
 * game state (archive is allowed even when the game is archived per
 * Decision 4). Returns `{ round, game }`. Auth is the caller's.
 */
async function requireUnarchivedRound(
  ctx: MutationCtx,
  roundId: Id<"bidRounds">,
): Promise<{ round: Doc<"bidRounds">; game: Doc<"games"> }> {
  const round = await ctx.db.get(roundId);
  if (!round) throw new Error("Bid round not found.");
  if (round.status === "archived") {
    throw new Error("This bid round is already archived.");
  }
  const game = await requireGame(ctx, round.gameId);
  return { round, game };
}

/**
 * Decision 6: integer, [0, 100]. POWER may go negative on settlement
 * (Rule 17) — affordability is NOT checked here.
 */
function validateBidAmount(amount: number): number {
  if (!Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw new Error("Bid amount must be an integer.");
  }
  if (amount < AMOUNT_MIN) {
    throw new Error(`Bid amount must be at least ${AMOUNT_MIN}.`);
  }
  if (amount > AMOUNT_MAX) {
    throw new Error(`Bid amount must be at most ${AMOUNT_MAX}.`);
  }
  return amount;
}

/**
 * Trim and validate an optional label. Decision 15: trimmed at insert
 * time; absent or empty after trim → stored as `undefined` and
 * settlement falls back to the literal "Public bid" reason.
 */
function normaliseLabel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length < LABEL_MIN) {
    throw new Error("Label must not be empty.");
  }
  if (trimmed.length > LABEL_MAX) {
    throw new Error(`Label must be at most ${LABEL_MAX} characters.`);
  }
  return trimmed;
}

export const startBidRound = mutation({
  args: {
    gameId: v.id("games"),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"bidRounds">> => {
    const game = await requireGameGm(ctx, args.gameId);
    if (game.state !== "playing") {
      throw new Error(
        "A public bid can only be started while the game is playing.",
      );
    }
    // Decision 4: at most one non-archived round per game.
    // The `by_game_status` index lets us check open and closed in two
    // O(1) lookups.
    const openExisting = await ctx.db
      .query("bidRounds")
      .withIndex("by_game_status", (q) =>
        q.eq("gameId", args.gameId).eq("status", "open"),
      )
      .first();
    if (openExisting) {
      throw new Error(
        "A public bid round is already active in this game. Archive it before starting another.",
      );
    }
    const closedExisting = await ctx.db
      .query("bidRounds")
      .withIndex("by_game_status", (q) =>
        q.eq("gameId", args.gameId).eq("status", "closed"),
      )
      .first();
    if (closedExisting) {
      throw new Error(
        "A public bid round is already active in this game. Archive it before starting another.",
      );
    }

    const label = normaliseLabel(args.label);
    return await ctx.db.insert("bidRounds", {
      gameId: game._id,
      status: "open",
      label,
      createdAt: Date.now(),
      createdByUserId: game.gmId,
      closedAt: undefined,
      closedByUserId: undefined,
      archivedAt: undefined,
      archivedByUserId: undefined,
    });
  },
});

export const placeBid = mutation({
  args: {
    roundId: v.id("bidRounds"),
    amount: v.number(),
  },
  handler: async (ctx, args) => {
    const { round } = await requireOpenRound(ctx, args.roundId);
    // Caller must be a Player in the round's game (this also rejects
    // the GM by Rule 11 — the GM has no `players` row).
    const { player } = await requireGamePlayer(ctx, round.gameId);
    const amount = validateBidAmount(args.amount);

    // Decision 7: two bids may both be 0; two non-zero bids may not
    // share an amount. Enforced via the `by_round_amount` index +
    // `.unique()`.
    if (amount > 0) {
      const collision = await ctx.db
        .query("bids")
        .withIndex("by_round_amount", (q) =>
          q.eq("roundId", round._id).eq("amount", amount),
        )
        .unique();
      if (collision && collision.playerId !== player._id) {
        throw new Error("That bid amount is already taken in this round.");
      }
    }

    const existing = await ctx.db
      .query("bids")
      .withIndex("by_round_player", (q) =>
        q.eq("roundId", round._id).eq("playerId", player._id),
      )
      .unique();

    const now = Date.now();
    if (!existing) {
      await ctx.db.insert("bids", {
        roundId: round._id,
        gameId: round.gameId,
        playerId: player._id,
        amount,
        updatedAt: now,
        updatedByUserId: player.userId,
      });
      return;
    }
    if (existing.amount === amount) {
      // Decision 9: idempotent re-submit.
      return;
    }
    await ctx.db.patch(existing._id, {
      amount,
      updatedAt: now,
      updatedByUserId: player.userId,
    });
  },
});

/**
 * Decision 11: GM Close (collect). open → closed. Settles every
 * non-zero bid in one transaction (one ledger entry per non-zero
 * bidder, `players.power` patched). Bids with `amount === 0` write
 * NO ledger entry. The closed round remains visible in the main panel
 * as a result snapshot until archived.
 */
export const closeBidRound = mutation({
  args: { roundId: v.id("bidRounds") },
  handler: async (ctx, args) => {
    const { round } = await requireOpenRound(ctx, args.roundId);
    const game = await requireGameGm(ctx, round.gameId);
    // Defence-in-depth: assertGameLive already ran in requireOpenRound.

    const allBids = await ctx.db
      .query("bids")
      .withIndex("by_round", (q) => q.eq("roundId", round._id))
      .collect();

    const reason =
      round.label && round.label.length > 0 ? round.label : "Public bid";
    const now = Date.now();

    for (const bid of allBids) {
      if (bid.amount <= 0) continue; // Decision 11: zeros write nothing.
      const player = await ctx.db.get(bid.playerId);
      if (!player) {
        throw new Error("Bidder's player row no longer exists.");
      }
      if (player.gameId !== round.gameId) {
        throw new Error(
          "Bidder's player row no longer belongs to this game.",
        );
      }
      await ctx.db.insert("powerLedgerEntries", {
        gameId: round.gameId,
        playerId: bid.playerId,
        delta: -bid.amount,
        reason,
        source: "bid",
        createdByUserId: game.gmId,
        createdAt: now,
      });
      // Rule 25: materialised cache patched in the same transaction.
      // POWER may go negative (Rule 17) — no floor check.
      await ctx.db.patch(player._id, { power: player.power - bid.amount });
    }

    await ctx.db.patch(round._id, {
      status: "closed",
      closedAt: now,
      closedByUserId: game.gmId,
    });
  },
});

/**
 * Decision 12: GM Archive (no POWER moves). Two paths in:
 *   open → archived     — cancellation (no settlement, `closedAt`
 *                         remains undefined as the audit signature).
 *   closed → archived   — hides an already-settled round.
 *
 * Allowed even when `game.state === "archived"` (Decision 4) so the GM
 * can clean up rounds left active when the game itself was archived.
 */
export const archiveBidRound = mutation({
  args: { roundId: v.id("bidRounds") },
  handler: async (ctx, args) => {
    const { round } = await requireUnarchivedRound(ctx, args.roundId);
    const game = await requireGameGm(ctx, round.gameId);
    // Note: NO game-state gate here — see Decision 4.

    const now = Date.now();
    await ctx.db.patch(round._id, {
      status: "archived",
      archivedAt: now,
      archivedByUserId: game.gmId,
      // Do NOT touch `closedAt` — its presence/absence is the audit
      // signature for whether the round was settled before archive.
    });
  },
});

// ─── Queries ─────────────────────────────────────────────────────────

export type ActiveBidRound = {
  _id: Id<"bidRounds">;
  status: "open" | "closed";
  label: string | undefined;
  createdAt: number;
  createdByUserId: Id<"users">;
  closedAt: number | null;
  closedByUserId: Id<"users"> | null;
};

export type ActiveBidRow = {
  _id: Id<"bids">;
  playerId: Id<"players">;
  displayName: string;
  amount: number;
  updatedAt: number;
  isMine: boolean;
};

export type PendingBidder = {
  playerId: Id<"players">;
  displayName: string;
};

export type ActiveBidView = {
  round: ActiveBidRound | null;
  bids: ActiveBidRow[];
  pending: PendingBidder[];
  viewerRole: "gm" | "player";
  viewerPlayerId: Id<"players"> | null;
};

/**
 * Decision 14 (visibility model): every participant sees the active
 * round, the full sorted bid list with display names and amounts, and
 * the "not yet bid" list. Non-participants are rejected at the query
 * layer per Rule 24. Returns the closed-round result snapshot the same
 * way (status: "closed") so the UI can render the post-settlement view
 * without an extra round-trip.
 *
 * Visibility note: this query intentionally exposes every participant's
 * bid amount to every other participant — public bids are explicitly
 * public. If a sealed-bid mode is ever added, gate the `bids` array
 * here behind `round.status !== "open"` for non-callers.
 */
export const getActiveBidRound = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args): Promise<ActiveBidView> => {
    const { role, player } = await requireGameParticipant(ctx, args.gameId);

    let round = await ctx.db
      .query("bidRounds")
      .withIndex("by_game_status", (q) =>
        q.eq("gameId", args.gameId).eq("status", "open"),
      )
      .first();
    if (!round) {
      round = await ctx.db
        .query("bidRounds")
        .withIndex("by_game_status", (q) =>
          q.eq("gameId", args.gameId).eq("status", "closed"),
        )
        .first();
    }

    const viewerPlayerId: Id<"players"> | null = player?._id ?? null;

    if (!round) {
      return {
        round: null,
        bids: [],
        pending: [],
        viewerRole: role,
        viewerPlayerId,
      };
    }

    const bids = await ctx.db
      .query("bids")
      .withIndex("by_round", (q) => q.eq("roundId", round._id))
      .collect();

    const playerIds = new Set<Id<"players">>();
    for (const b of bids) playerIds.add(b.playerId);

    // Roster, used for the "not yet bid" list.
    const roster = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .collect();

    const allPlayerIds = new Set<Id<"players">>();
    for (const p of roster) {
      allPlayerIds.add(p._id);
      playerIds.add(p._id);
    }

    const displayNames = await hydrateDisplayNames(ctx, playerIds);

    // Sort: descending by amount, then ascending by updatedAt (earliest
    // commit wins display order at amount=0).
    const sortedBids = [...bids].sort((a, b) => {
      if (a.amount !== b.amount) return b.amount - a.amount;
      return a.updatedAt - b.updatedAt;
    });

    const bidPlayerIds = new Set<Id<"players">>();
    for (const b of bids) bidPlayerIds.add(b.playerId);

    const pending: PendingBidder[] = [];
    for (const p of roster) {
      if (!bidPlayerIds.has(p._id)) {
        pending.push({
          playerId: p._id,
          displayName: displayNames[p._id] ?? "Unknown",
        });
      }
    }
    pending.sort((a, b) => a.displayName.localeCompare(b.displayName));

    const status: "open" | "closed" = round.status === "closed" ? "closed" : "open";

    return {
      round: {
        _id: round._id,
        status,
        label: round.label,
        createdAt: round.createdAt,
        createdByUserId: round.createdByUserId,
        closedAt: round.closedAt ?? null,
        closedByUserId: round.closedByUserId ?? null,
      },
      bids: sortedBids.map((b) => ({
        _id: b._id,
        playerId: b.playerId,
        displayName: displayNames[b.playerId] ?? "Unknown",
        amount: b.amount,
        updatedAt: b.updatedAt,
        isMine: viewerPlayerId !== null && b.playerId === viewerPlayerId,
      })),
      pending,
      viewerRole: role,
      viewerPlayerId,
    };
  },
});

export type ArchivedBidRoundRow = {
  _id: Id<"bidRounds">;
  label: string | undefined;
  createdAt: number;
  closedAt: number | null;
  archivedAt: number;
  wasSettled: boolean;
  bidCount: number;
  totalPaid: number;
};

/**
 * Drives the Game Log drawer's "Past Public Bids" section. Returns the
 * most recent N archived rounds, with a count of bids and total POWER
 * paid out for each. Cancelled rounds (`closedAt === undefined`) are
 * flagged `wasSettled: false` and `totalPaid: 0`.
 */
export const listArchivedBidRounds = query({
  args: {
    gameId: v.id("games"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ArchivedBidRoundRow[]> => {
    await requireGameParticipant(ctx, args.gameId);
    const limit = args.limit ?? 20;
    const rounds = await ctx.db
      .query("bidRounds")
      .withIndex("by_game_archivedAt", (q) => q.eq("gameId", args.gameId))
      .order("desc")
      .take(limit);

    const out: ArchivedBidRoundRow[] = [];
    for (const r of rounds) {
      if (r.archivedAt === undefined) continue; // sanity
      const bids = await ctx.db
        .query("bids")
        .withIndex("by_round", (q) => q.eq("roundId", r._id))
        .collect();
      const wasSettled = r.closedAt !== undefined;
      let totalPaid = 0;
      if (wasSettled) {
        for (const b of bids) {
          if (b.amount > 0) totalPaid += b.amount;
        }
      }
      out.push({
        _id: r._id,
        label: r.label,
        createdAt: r.createdAt,
        closedAt: r.closedAt ?? null,
        archivedAt: r.archivedAt,
        wasSettled,
        bidCount: bids.length,
        totalPaid,
      });
    }
    return out;
  },
});

export type RoundBidsView = {
  round: {
    _id: Id<"bidRounds">;
    status: "open" | "closed" | "archived";
    label: string | undefined;
    createdAt: number;
    closedAt: number | null;
    archivedAt: number | null;
  };
  bids: ActiveBidRow[];
};

/**
 * Drilldown query for any round the caller participates in (active,
 * closed, or archived). Hydrates display names. Used by the Game Log
 * drawer's per-row expansion.
 */
export const getRoundBids = query({
  args: { roundId: v.id("bidRounds") },
  handler: async (ctx, args): Promise<RoundBidsView | null> => {
    const round = await ctx.db.get(args.roundId);
    if (!round) return null;
    const { player } = await requireGameParticipant(ctx, round.gameId);
    const viewerPlayerId: Id<"players"> | null = player?._id ?? null;

    const bids = await ctx.db
      .query("bids")
      .withIndex("by_round", (q) => q.eq("roundId", round._id))
      .collect();
    const playerIds = new Set<Id<"players">>();
    for (const b of bids) playerIds.add(b.playerId);
    const displayNames = await hydrateDisplayNames(ctx, playerIds);

    const sortedBids = [...bids].sort((a, b) => {
      if (a.amount !== b.amount) return b.amount - a.amount;
      return a.updatedAt - b.updatedAt;
    });

    return {
      round: {
        _id: round._id,
        status: round.status,
        label: round.label,
        createdAt: round.createdAt,
        closedAt: round.closedAt ?? null,
        archivedAt: round.archivedAt ?? null,
      },
      bids: sortedBids.map((b) => ({
        _id: b._id,
        playerId: b.playerId,
        displayName: displayNames[b.playerId] ?? "Unknown",
        amount: b.amount,
        updatedAt: b.updatedAt,
        isMine: viewerPlayerId !== null && b.playerId === viewerPlayerId,
      })),
    };
  },
});

/**
 * Bulk-resolve player → user → display name. Mirrors the hydration
 * pattern in `convex/ledger.ts:235-256` and
 * `convex/treasonGrants.ts:371-386`.
 */
async function hydrateDisplayNames(
  ctx: QueryCtx,
  playerIds: Set<Id<"players">>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const pid of playerIds) {
    const p = await ctx.db.get(pid);
    if (!p) continue;
    const u = await ctx.db.get(p.userId);
    out[pid] = u?.displayName ?? u?.email ?? "Unknown";
  }
  return out;
}
