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
        }[],
        nextPrice: null as number | null,
        boughtCount: 0,
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
        };
      }),
      nextPrice,
      boughtCount,
    };
  },
});
