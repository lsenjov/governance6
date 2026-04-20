import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  requireGame,
  requireGameGm,
  requireGamePlayer,
  requireUserId,
} from "./lib/auth";

/**
 * Call Queue — Rule 22.
 *
 * FIFO by `createdAt` ascending. At most one active Call per Player.
 * Adding a new Call while one exists REPLACES the existing Call's `minionId`
 * in place, preserving `createdAt` and document id (queue position preserved).
 * Same-minion replace is a no-op.
 *
 * Removed Calls are soft-deleted (`isActive=false`, `removedAt` set); the last
 * 10 are visible in a history panel.
 */

export const addOrReplaceCall = mutation({
  args: { gameId: v.id("games"), minionId: v.id("minions") },
  handler: async (ctx, args) => {
    const { game, player } = await requireGamePlayer(ctx, args.gameId);
    if (game.state !== "playing") {
      throw new Error("Calls can only be added while the game is playing.");
    }

    // Rule 22: Minion must be bought in this (game, player).
    const gpm = await ctx.db
      .query("gamePlayerMinions")
      .withIndex("by_game_player_minion", (q) =>
        q
          .eq("gameId", args.gameId)
          .eq("playerId", player._id)
          .eq("minionId", args.minionId),
      )
      .unique();
    if (!gpm || !gpm.bought) {
      throw new Error("You must buy this Minion before calling it.");
    }

    // Existing active Call for this Player?
    const existing = await ctx.db
      .query("calls")
      .withIndex("by_game_player_active", (q) =>
        q.eq("gameId", args.gameId).eq("playerId", player._id).eq("isActive", true),
      )
      .unique();

    if (existing) {
      if (existing.minionId === args.minionId) {
        // Rule 22: idempotent no-op.
        return existing._id;
      }
      // Rule 22: replace-in-place; preserve createdAt and document id.
      await ctx.db.patch(existing._id, { minionId: args.minionId });
      return existing._id;
    }

    return await ctx.db.insert("calls", {
      gameId: args.gameId,
      playerId: player._id,
      minionId: args.minionId,
      createdAt: Date.now(),
      isActive: true,
    });
  },
});

/**
 * Rule 22: GM may remove any Call. Soft-deletes: sets `isActive=false`,
 * `removedAt=Date.now()`, `removedByGmId=gmId`.
 */
export const removeCall = mutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Call not found.");
    const game = await requireGameGm(ctx, call.gameId);
    if (!call.isActive) {
      // Idempotent.
      return;
    }
    await ctx.db.patch(args.callId, {
      isActive: false,
      removedAt: Date.now(),
      removedByGmId: game.gmId,
    });
  },
});

/**
 * Active Calls (FIFO by `createdAt` ascending). Any game viewer.
 */
export const activeCalls = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const game = await requireGame(ctx, args.gameId);
    const isGm = game.gmId === userId;
    if (!isGm) {
      // Ensure participant.
      const meRow = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) =>
          q.eq("gameId", args.gameId).eq("userId", userId),
        )
        .unique();
      if (!meRow) throw new Error("You are not a participant in this game.");
    }

    const rows = await ctx.db
      .query("calls")
      .withIndex("by_game_active_time", (q) =>
        q.eq("gameId", args.gameId).eq("isActive", true),
      )
      .order("asc")
      .collect();

    return await Promise.all(
      rows.map(async (c) => {
        const player = await ctx.db.get(c.playerId);
        const user = player ? await ctx.db.get(player.userId) : null;
        const minion = await ctx.db.get(c.minionId);
        return {
          _id: c._id,
          playerId: c.playerId,
          minionId: c.minionId,
          createdAt: c.createdAt,
          playerName: user?.displayName ?? user?.email ?? "Unknown",
          minionName: minion?.name ?? "Unknown Minion",
        };
      }),
    );
  },
});

/**
 * Recently removed Calls — up to 10, ordered by `removedAt` descending.
 */
export const recentlyRemovedCalls = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const game = await requireGame(ctx, args.gameId);
    const isGm = game.gmId === userId;
    if (!isGm) {
      const meRow = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) =>
          q.eq("gameId", args.gameId).eq("userId", userId),
        )
        .unique();
      if (!meRow) throw new Error("You are not a participant in this game.");
    }
    const rows = await ctx.db
      .query("calls")
      .withIndex("by_game_removed_time", (q) => q.eq("gameId", args.gameId))
      .order("desc")
      .take(20); // over-fetch because some rows have removedAt=undefined
    const removed = rows.filter((r) => !r.isActive && r.removedAt).slice(0, 10);
    return await Promise.all(
      removed.map(async (c) => {
        const player = await ctx.db.get(c.playerId);
        const user = player ? await ctx.db.get(player.userId) : null;
        const minion = await ctx.db.get(c.minionId);
        return {
          _id: c._id,
          playerId: c.playerId,
          minionId: c.minionId,
          createdAt: c.createdAt,
          removedAt: c.removedAt!,
          playerName: user?.displayName ?? user?.email ?? "Unknown",
          minionName: minion?.name ?? "Unknown Minion",
        };
      }),
    );
  },
});
