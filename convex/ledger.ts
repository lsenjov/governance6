import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireGame,
  requireGameGm,
  requireGamePlayer,
  requireUserId,
} from "./lib/auth";

/**
 * POWER ledger — Rules 17, 18, 19, 20, 23, 25.
 *
 * Append-only: no update/delete mutations on ledger entries.
 * `players.power` is a materialised cache of the ledger sum (Rule 25);
 * every write that inserts a ledger entry also patches the Player row in
 * the same transaction.
 */

export type LedgerSource =
  | "transfer_in"
  | "transfer_out"
  | "bank_in"
  | "bank_out"
  | "minion_buy"
  | "treason_grant"
  | "bid";

/**
 * Rule 20 (GM path): `gmEditPower(gameId, playerId, delta, reason?)`.
 * delta > 0 → bank_out (bank paid out).
 * delta < 0 → bank_in (bank took in).
 * delta === 0 is rejected.
 */
export const gmEditPower = mutation({
  args: {
    gameId: v.id("games"),
    playerId: v.id("players"),
    delta: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.delta) || !Number.isInteger(args.delta)) {
      throw new Error("POWER delta must be an integer.");
    }
    if (args.delta === 0) throw new Error("POWER delta must be non-zero.");
    const game = await requireGameGm(ctx, args.gameId);
    if (game.state === "archived") {
      throw new Error("Cannot edit POWER in an archived game.");
    }
    const player = await ctx.db.get(args.playerId);
    if (!player || player.gameId !== args.gameId) {
      throw new Error("Player not found in this game.");
    }
    const source: LedgerSource = args.delta > 0 ? "bank_out" : "bank_in";
    const reason = args.reason?.trim() ? args.reason.trim() : undefined;

    await ctx.db.insert("powerLedgerEntries", {
      gameId: args.gameId,
      playerId: args.playerId,
      delta: args.delta,
      reason,
      source,
      createdByUserId: game.gmId,
      createdAt: Date.now(),
    });
    await ctx.db.patch(args.playerId, { power: player.power + args.delta });
  },
});

/**
 * Rule 20 (Player→Player): paired entries, reason required, amount > 0.
 */
export const transferPlayerToPlayer = mutation({
  args: {
    gameId: v.id("games"),
    recipientPlayerId: v.id("players"),
    amount: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.amount) || !Number.isInteger(args.amount)) {
      throw new Error("Amount must be an integer.");
    }
    if (args.amount <= 0) throw new Error("Amount must be positive.");
    const reason = args.reason.trim();
    if (reason.length < 1) throw new Error("Reason is required.");
    if (reason.length > 500) throw new Error("Reason too long (max 500).");

    const { game, player: sender } = await requireGamePlayer(ctx, args.gameId);
    if (game.state !== "playing") {
      throw new Error("Transfers are only allowed while the game is playing.");
    }
    if (args.recipientPlayerId === sender._id) {
      throw new Error("You cannot transfer POWER to yourself.");
    }
    const recipient = await ctx.db.get(args.recipientPlayerId);
    if (!recipient || recipient.gameId !== args.gameId) {
      throw new Error("Recipient not found in this game.");
    }

    const now = Date.now();
    await ctx.db.insert("powerLedgerEntries", {
      gameId: args.gameId,
      playerId: sender._id,
      delta: -args.amount,
      reason,
      source: "transfer_out",
      counterpartyPlayerId: recipient._id,
      createdByUserId: sender.userId,
      createdAt: now,
    });
    await ctx.db.insert("powerLedgerEntries", {
      gameId: args.gameId,
      playerId: recipient._id,
      delta: args.amount,
      reason,
      source: "transfer_in",
      counterpartyPlayerId: sender._id,
      createdByUserId: sender.userId,
      createdAt: now,
    });
    await ctx.db.patch(sender._id, { power: sender.power - args.amount });
    await ctx.db.patch(recipient._id, {
      power: recipient.power + args.amount,
    });
  },
});

/**
 * Rule 20 (Player → Bank): one entry on Player's ledger, source = bank_in,
 * delta = -amount. Reason required, amount > 0.
 */
export const transferPlayerToBank = mutation({
  args: {
    gameId: v.id("games"),
    amount: v.number(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    if (!Number.isFinite(args.amount) || !Number.isInteger(args.amount)) {
      throw new Error("Amount must be an integer.");
    }
    if (args.amount <= 0) throw new Error("Amount must be positive.");
    const reason = args.reason.trim();
    if (reason.length < 1) throw new Error("Reason is required.");
    if (reason.length > 500) throw new Error("Reason too long (max 500).");

    const { game, player } = await requireGamePlayer(ctx, args.gameId);
    if (game.state !== "playing") {
      throw new Error("Transfers are only allowed while the game is playing.");
    }
    await ctx.db.insert("powerLedgerEntries", {
      gameId: args.gameId,
      playerId: player._id,
      delta: -args.amount,
      reason,
      source: "bank_in",
      createdByUserId: player.userId,
      createdAt: Date.now(),
    });
    await ctx.db.patch(player._id, { power: player.power - args.amount });
  },
});

/**
 * Rule 23: Own ledger for the calling Player.
 */
export const getOwnLedger = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args) => {
    const { player } = await requireGamePlayer(ctx, args.gameId);
    const entries = await ctx.db
      .query("powerLedgerEntries")
      .withIndex("by_game_player_time", (q) =>
        q.eq("gameId", args.gameId).eq("playerId", player._id),
      )
      .order("desc")
      .take(200);
    return await hydrateEntries(ctx, entries);
  },
});

/**
 * Rule 23: GM-only view of any Player's ledger.
 */
export const getAnyLedger = query({
  args: { gameId: v.id("games"), playerId: v.id("players") },
  handler: async (ctx, args) => {
    await requireGameGm(ctx, args.gameId);
    const target = await ctx.db.get(args.playerId);
    if (!target || target.gameId !== args.gameId) return [];
    const entries = await ctx.db
      .query("powerLedgerEntries")
      .withIndex("by_game_player_time", (q) =>
        q.eq("gameId", args.gameId).eq("playerId", args.playerId),
      )
      .order("desc")
      .take(500);
    return await hydrateEntries(ctx, entries);
  },
});

/**
 * Rule 23: Balances are visible to every game viewer. Returns one row per
 * Player with displayName and current POWER.
 */
export const getPlayerBalances = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const game = await requireGame(ctx, args.gameId);
    const isGm = game.gmId === userId;
    const players = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .collect();
    const me = players.find((p) => p.userId === userId);
    if (!isGm && !me)
      throw new Error("You are not a participant in this game.");

    return await Promise.all(
      players.map(async (p) => {
        const u = await ctx.db.get(p.userId);
        return {
          playerId: p._id,
          userId: p.userId,
          displayName: u?.displayName ?? u?.email ?? "Unknown",
          power: p.power,
        };
      }),
    );
  },
});

async function hydrateEntries(
  ctx: QueryCtx,
  entries: Doc<"powerLedgerEntries">[],
) {
  const counterpartyIds = new Set<Id<"players">>();
  for (const e of entries) {
    if (e.counterpartyPlayerId) counterpartyIds.add(e.counterpartyPlayerId);
  }
  const names: Record<string, string> = {};
  for (const pid of counterpartyIds) {
    const p = await ctx.db.get(pid);
    if (p) {
      const u = await ctx.db.get(p.userId);
      names[pid] = u?.displayName ?? u?.email ?? "Unknown";
    }
  }
  return entries.map((e) => ({
    ...e,
    counterpartyName: e.counterpartyPlayerId
      ? (names[e.counterpartyPlayerId] ?? null)
      : null,
  }));
}
