import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { requireGamePlayer, requireUserId } from "./lib/auth";

/**
 * Per-game Minion buy — Rule 21.
 *
 * Price sequence: 1st–8th buy costs [0,2,4,6,8,10,12,14] respectively.
 * Writes a `minion_buy` ledger entry in the same transaction; updates
 * `players.power` cache (Rule 25).
 */

const MINION_PRICES = [0, 2, 4, 6, 8, 10, 12, 14] as const;

export const buyMinion = mutation({
  args: { gameId: v.id("games"), minionId: v.id("minions") },
  handler: async (ctx, args) => {
    const { game, player } = await requireGamePlayer(ctx, args.gameId);
    if (game.state !== "playing") {
      throw new Error("Minions can only be bought while the game is playing.");
    }
    if (!player.selectedSyndicateId) {
      throw new Error("You have no Syndicate selected.");
    }
    const minion = await ctx.db.get(args.minionId);
    if (!minion) throw new Error("Minion not found.");
    if (minion.syndicateId !== player.selectedSyndicateId) {
      throw new Error(
        "That Minion does not belong to your selected Syndicate.",
      );
    }

    // Has this Player already bought this Minion?
    const existing = await ctx.db
      .query("gamePlayerMinions")
      .withIndex("by_game_player_minion", (q) =>
        q
          .eq("gameId", args.gameId)
          .eq("playerId", player._id)
          .eq("minionId", args.minionId),
      )
      .unique();
    if (existing && existing.bought) {
      throw new Error("You have already bought this Minion.");
    }

    const boughtRows = await ctx.db
      .query("gamePlayerMinions")
      .withIndex("by_game_player", (q) =>
        q.eq("gameId", args.gameId).eq("playerId", player._id),
      )
      .collect();
    const boughtCount = boughtRows.filter((r) => r.bought).length;
    if (boughtCount >= MINION_PRICES.length) {
      throw new Error("You have already bought the maximum number of Minions.");
    }
    const price = MINION_PRICES[boughtCount];
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        bought: true,
        boughtAt: now,
        pricePaid: price,
      });
    } else {
      await ctx.db.insert("gamePlayerMinions", {
        gameId: args.gameId,
        playerId: player._id,
        minionId: args.minionId,
        bought: true,
        boughtAt: now,
        pricePaid: price,
      });
    }

    await ctx.db.insert("powerLedgerEntries", {
      gameId: args.gameId,
      playerId: player._id,
      delta: -price,
      source: "minion_buy",
      createdByUserId: player.userId,
      createdAt: now,
    });
    await ctx.db.patch(player._id, { power: player.power - price });
  },
});

/**
 * Toggle the player's queued follow-up minion ("Next").
 *
 * At most one `gamePlayerMinions` row per `(gameId, playerId)` may
 * have `isNext === true`. Clicking Next on a different minion clears
 * the previous flag; clicking Next on the currently-marked minion
 * clears it (toggle-off).
 *
 * The "set" branch requires the player to currently have an active
 * call — without one there is nothing for the auto-promote in
 * `removeCall` to fire on. The "clear" branch is unconditional
 * (idempotent, safe under races).
 *
 * The auto-promote in `convex/calls.ts:removeCall` is the sole
 * consumer of this flag: when the GM removes a player's active call,
 * the player's `isNext` minion (if still bought) is auto-enqueued at
 * the tail of the FIFO queue and the flag is cleared. See
 * `plans/2026-05-17-next-minion-v1.md`.
 */
export const toggleNextMinion = mutation({
  args: { gameId: v.id("games"), minionId: v.id("minions") },
  handler: async (ctx, args) => {
    const { game, player } = await requireGamePlayer(ctx, args.gameId);
    if (game.state !== "playing") {
      throw new Error("Next can only be set while the game is playing.");
    }

    const row = await ctx.db
      .query("gamePlayerMinions")
      .withIndex("by_game_player_minion", (q) =>
        q
          .eq("gameId", args.gameId)
          .eq("playerId", player._id)
          .eq("minionId", args.minionId),
      )
      .unique();
    if (!row || !row.bought) {
      throw new Error("You must buy this Minion before marking it next.");
    }

    const shouldClear = row.isNext === true;

    if (!shouldClear) {
      // Set branch: require an active call.
      const activeCall = await ctx.db
        .query("calls")
        .withIndex("by_game_player_active", (q) =>
          q
            .eq("gameId", args.gameId)
            .eq("playerId", player._id)
            .eq("isActive", true),
        )
        .unique();
      if (!activeCall) {
        throw new Error(
          "You must have an active Call before marking a Minion next.",
        );
      }
    }

    // Defensive: clear any other rows for this (game, player) that
    // have `isNext === true`. Uniqueness is meant to be invariant
    // but we sweep in case a prior write left two rows true.
    const siblingRows = await ctx.db
      .query("gamePlayerMinions")
      .withIndex("by_game_player", (q) =>
        q.eq("gameId", args.gameId).eq("playerId", player._id),
      )
      .collect();
    for (const other of siblingRows) {
      if (other._id !== row._id && other.isNext === true) {
        await ctx.db.patch(other._id, { isNext: undefined });
      }
    }

    if (shouldClear) {
      await ctx.db.patch(row._id, { isNext: undefined });
    } else {
      await ctx.db.patch(row._id, { isNext: true });
    }
  },
});

/**
 * For a given Player in a Game: return every Minion of their selected
 * Syndicate with bought state, price paid, and the next-buy price.
 */
export const listForPlayer = query({
  args: { gameId: v.id("games"), playerId: v.id("players") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const player = await ctx.db.get(args.playerId);
    if (!player || player.gameId !== args.gameId) return null;
    const game = await ctx.db.get(args.gameId);
    if (!game) return null;
    const isGm = game.gmId === userId;
    const isSelf = player.userId === userId;
    // Any participant may view (GM + any Player in the game can see which
    // Minions have been bought — this is public per-game state).
    const meRow = await ctx.db
      .query("players")
      .withIndex("by_game_user", (q) =>
        q.eq("gameId", args.gameId).eq("userId", userId),
      )
      .unique();
    if (!isGm && !meRow) return null;

    // `hasActiveCall` is exposed so the UI can gate the Next button
    // without a separate query. Computed regardless of whether the
    // player has a selected syndicate (so the empty-syndicate branch
    // still returns it).
    const activeCallRow = await ctx.db
      .query("calls")
      .withIndex("by_game_player_active", (q) =>
        q
          .eq("gameId", args.gameId)
          .eq("playerId", args.playerId)
          .eq("isActive", true),
      )
      .unique();
    const hasActiveCall = activeCallRow !== null;

    if (!player.selectedSyndicateId) {
      return {
        isSelf,
        syndicateId: null as Id<"syndicates"> | null,
        minions: [] as {
          _id: Id<"minions">;
          name: string;
          accent?: string;
          description?: string;
          skills: string[];
          order: number;
          bought: boolean;
          pricePaid?: number;
          isNext: boolean;
        }[],
        nextPrice: null as number | null,
        boughtCount: 0,
        hasActiveCall,
      };
    }

    const [minions, gpms] = await Promise.all([
      ctx.db
        .query("minions")
        .withIndex("by_syndicate", (q) =>
          q.eq("syndicateId", player.selectedSyndicateId!),
        )
        .collect(),
      ctx.db
        .query("gamePlayerMinions")
        .withIndex("by_game_player", (q) =>
          q.eq("gameId", args.gameId).eq("playerId", args.playerId),
        )
        .collect(),
    ]);
    const byMinion = new Map<string, (typeof gpms)[number]>();
    for (const g of gpms) byMinion.set(g.minionId, g);
    minions.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    const boughtCount = gpms.filter((g) => g.bought).length;
    const nextPrice =
      boughtCount < MINION_PRICES.length ? MINION_PRICES[boughtCount] : null;

    return {
      isSelf,
      syndicateId: player.selectedSyndicateId,
      minions: minions.map((m) => {
        const row = byMinion.get(m._id);
        return {
          _id: m._id,
          name: m.name,
          accent: m.accent,
          description: m.description,
          skills: m.skills,
          order: m.order,
          bought: row?.bought ?? false,
          pricePaid: row?.pricePaid,
          isNext: row?.isNext === true,
        };
      }),
      nextPrice,
      boughtCount,
      hasActiveCall,
    };
  },
});
