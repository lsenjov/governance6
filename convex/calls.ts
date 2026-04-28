import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  requireGame,
  requireGameGm,
  requireGamePlayer,
  requireUserId,
} from "./lib/auth";
import {
  generateRollSetForCall,
  getHeadCallId,
  getLatestRollSetForCall,
  projectRollSet,
  type RollSetView,
} from "./lib/rolls";
import type { Doc, Id } from "./_generated/dataModel";

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
 *
 * Dice rolls (plans/2026-04-28-2026-04-28-dice-rolls-v3.md): every time a
 * Call reaches the head of the queue, a new `callRollSets` row is
 * generated. Visible to the GM only.
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

      // Dice rolls: if this call is currently the head of the queue,
      // generate a fresh roll set because the new minion's skill count
      // changes the skill threshold. If the call is mid-queue, no
      // rolls fire here — they will fire when the call advances to the
      // head (see `removeCall`).
      const headId = await getHeadCallId(ctx, args.gameId);
      if (headId === existing._id) {
        await generateRollSetForCall(ctx, {
          callId: existing._id,
          reason: "minion_replaced",
        });
      }
      return existing._id;
    }

    const newCallId = await ctx.db.insert("calls", {
      gameId: args.gameId,
      playerId: player._id,
      minionId: args.minionId,
      createdAt: Date.now(),
      isActive: true,
    });

    // Dice rolls: only fire when the new call is actually the head of
    // the queue. The caller can only have one active call (enforced
    // above), but other players' older calls may already occupy the
    // head — in which case rolls wait until those clear.
    const headIdAfter = await getHeadCallId(ctx, args.gameId);
    if (headIdAfter === newCallId) {
      await generateRollSetForCall(ctx, {
        callId: newCallId,
        reason: "became_head",
      });
    }

    return newCallId;
  },
});

/**
 * Rule 22: GM may remove any Call. Soft-deletes: sets `isActive=false`,
 * `removedAt=Date.now()`, `removedByGmId=gmId`.
 *
 * Dice rolls: if the removed call WAS the head, the next-oldest active
 * call inherits the head slot and gets a fresh roll set. Removing a
 * mid-queue call leaves the head unchanged and fires no rolls.
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

    // Snapshot the head BEFORE the patch so we can detect whether the
    // removed call was the head. If it wasn't, no rolls need to fire
    // (the head is still the same call, which already has a roll set).
    const headBefore = await getHeadCallId(ctx, call.gameId);
    const removedWasHead = headBefore === call._id;

    await ctx.db.patch(args.callId, {
      isActive: false,
      removedAt: Date.now(),
      removedByGmId: game.gmId,
    });

    if (removedWasHead) {
      const newHead = await getHeadCallId(ctx, call.gameId);
      if (newHead !== null) {
        await generateRollSetForCall(ctx, {
          callId: newHead,
          reason: "became_head",
        });
      }
    }
  },
});

/**
 * Active Calls (FIFO by `createdAt` ascending). Any game viewer.
 *
 * Dice rolls: GM viewers receive a `rolls: RollSetView | null` field
 * on each entry; non-GM viewers receive the existing shape unchanged.
 * The field is OMITTED ENTIRELY (not set to `null` or `undefined`) for
 * non-GMs so the wire format never leaks the existence of rolls.
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

    // For GMs, bulk-load roll sets in a single per-game query and
    // index them by callId so we don't fan out N point reads.
    let rollsByCallId: Map<Id<"calls">, Doc<"callRollSets">> | null = null;
    if (isGm) {
      rollsByCallId = new Map();
      const allRolls = await ctx.db
        .query("callRollSets")
        .withIndex("by_game_call", (q) => q.eq("gameId", args.gameId))
        .collect();
      // Newest-first per call: iterate and only keep the latest by
      // `createdAt` for each callId.
      for (const r of allRolls) {
        const existing = rollsByCallId.get(r.callId);
        if (!existing || existing.createdAt < r.createdAt) {
          rollsByCallId.set(r.callId, r);
        }
      }
    }

    return await Promise.all(
      rows.map(async (c) => {
        const player = await ctx.db.get(c.playerId);
        const user = player ? await ctx.db.get(player.userId) : null;
        const minion = await ctx.db.get(c.minionId);
        const base = {
          _id: c._id,
          playerId: c.playerId,
          minionId: c.minionId,
          createdAt: c.createdAt,
          playerName: user?.displayName ?? user?.email ?? "Unknown",
          minionName: minion?.name ?? "Unknown Minion",
        };
        if (isGm && rollsByCallId) {
          const row = rollsByCallId.get(c._id) ?? null;
          // GM payload: include `rolls` (possibly null while the helper
          // is mid-flight in a race; the UI handles null).
          return {
            ...base,
            rolls: row ? projectRollSet(row) : (null as RollSetView | null),
          };
        }
        // Player payload: no `rolls` key at all. Tests assert via
        // hasOwnProperty that the key is genuinely absent.
        return base;
      }),
    );
  },
});

/**
 * GM-only deep-dive on the head of the FIFO call queue.
 *
 * Returns `null` when the queue is empty, when the head call's minion has
 * been removed, or when the minion's owning syndicate is missing. The
 * defensive nulls keep the rendering contract simple: the UI just shows
 * the empty state in those cases. A successful result joins the call,
 * the called minion (with skills/accent/description), the minion's owning
 * syndicate, that syndicate's drawbacks (sorted by `order` ascending,
 * matching `drawbacks.listForSyndicate`), and the latest roll set for
 * that head call.
 */
export const getCurrentCallDetails = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args) => {
    // GM-only — Rule 24, enforced server-side regardless of UI.
    await requireGameGm(ctx, args.gameId);

    // FIFO head: oldest active call, mirroring `activeCalls`'s ordering.
    const head = await ctx.db
      .query("calls")
      .withIndex("by_game_active_time", (q) =>
        q.eq("gameId", args.gameId).eq("isActive", true),
      )
      .order("asc")
      .take(1);
    if (head.length === 0) return null;
    const call = head[0];

    const minion = await ctx.db.get(call.minionId);
    if (!minion) return null;

    const syndicate = await ctx.db.get(minion.syndicateId);
    if (!syndicate) return null;

    const player = await ctx.db.get(call.playerId);
    const user = player ? await ctx.db.get(player.userId) : null;
    const playerName = user?.displayName ?? user?.email ?? "Unknown";

    const drawbackRows = await ctx.db
      .query("drawbacks")
      .withIndex("by_syndicate", (q) => q.eq("syndicateId", syndicate._id))
      .collect();
    drawbackRows.sort((a, b) => a.order - b.order);

    const rollRow = await getLatestRollSetForCall(ctx, call._id);
    const rolls: RollSetView | null = rollRow ? projectRollSet(rollRow) : null;

    return {
      call: {
        _id: call._id,
        createdAt: call.createdAt,
        playerId: call.playerId,
        playerName,
      },
      minion: {
        _id: minion._id,
        name: minion.name,
        accent: minion.accent ?? null,
        description: minion.description ?? null,
        skills: minion.skills,
      },
      syndicate: {
        _id: syndicate._id,
        name: syndicate.name,
        leader: syndicate.leader,
        drawbacks: drawbackRows.map((d) => ({
          _id: d._id,
          name: d.name,
          description: d.description,
        })),
      },
      rolls,
    };
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
