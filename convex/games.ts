import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  getOptionalGamePlayer,
  requireGameGm,
  requireGamePlayer,
  requireUserId,
} from "./lib/auth";

/**
 * Game lifecycle — Rules 10, 11, 12, 13, 14, 15, 16.
 */

const GAME_NAME_MAX = 120;

export const create = mutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    let name: string | undefined = undefined;
    if (args.name !== undefined) {
      const t = args.name.trim();
      if (t.length > GAME_NAME_MAX) {
        throw new Error(`Name must be at most ${GAME_NAME_MAX} characters.`);
      }
      if (t.length > 0) name = t;
    }
    return await ctx.db.insert("games", {
      name,
      gmId: userId,
      state: "ready",
    });
  },
});

/**
 * Rule 18: addPlayer.
 * - Caller must be the GM.
 * - Target user must NOT be the GM (rule 11).
 * - Game must be `ready` (rule 12).
 * - (gameId, userId) must be unique (enforced here; Convex has no unique).
 */
export const addPlayer = mutation({
  args: { gameId: v.id("games"), userId: v.id("users") },
  handler: async (ctx, args) => {
    const game = await requireGameGm(ctx, args.gameId);
    if (game.state !== "ready") {
      throw new Error("Roster can only change while the game is ready.");
    }
    if (game.gmId === args.userId) {
      throw new Error("The GM cannot be added as a Player in their own game.");
    }
    const user = await ctx.db.get(args.userId);
    if (!user) throw new Error("User not found.");
    const existing = await getOptionalGamePlayer(ctx, args.gameId, args.userId);
    if (existing) {
      throw new Error("That user is already a Player in this game.");
    }
    return await ctx.db.insert("players", {
      gameId: args.gameId,
      userId: args.userId,
      power: 0,
      joinedAt: Date.now(),
    });
  },
});

/**
 * Rule 12: removePlayer allowed only while `ready`.
 */
export const removePlayer = mutation({
  args: { gameId: v.id("games"), playerId: v.id("players") },
  handler: async (ctx, args) => {
    const game = await requireGameGm(ctx, args.gameId);
    if (game.state !== "ready") {
      throw new Error("Players cannot be removed once the game has started.");
    }
    const player = await ctx.db.get(args.playerId);
    if (!player || player.gameId !== args.gameId) {
      throw new Error("Player not in this game.");
    }
    await ctx.db.delete(args.playerId);
  },
});

/**
 * Rule 13: selectSyndicate.
 * - Caller must be the Player (self-service).
 * - Game must be `ready`.
 * - Syndicate must be owned by caller OR `isShared=true`.
 * - `syndicateId === null` clears the selection.
 * - Within-game uniqueness (added by GM Todo Drawer v1, Task 0d):
 *   no two Players in the same game may have the same Syndicate
 *   selected. Re-selecting a Syndicate the caller already has is
 *   idempotent. Note: this is a mutation-level invariant, not a
 *   schema constraint — existing test fixtures that bypass this
 *   mutation by direct `ctx.db.insert("players", …)` continue to
 *   load.
 */
export const selectSyndicate = mutation({
  args: {
    gameId: v.id("games"),
    syndicateId: v.union(v.id("syndicates"), v.null()),
  },
  handler: async (ctx, args) => {
    const { game, player } = await requireGamePlayer(ctx, args.gameId);
    if (game.state !== "ready") {
      throw new Error("Selection is locked once the game has started.");
    }
    if (args.syndicateId === null) {
      await ctx.db.patch(player._id, { selectedSyndicateId: undefined });
      return;
    }
    const targetSyndicateId = args.syndicateId;
    const syndicate = await ctx.db.get(targetSyndicateId);
    if (!syndicate) throw new Error("Syndicate not found.");
    if (syndicate.ownerId !== player.userId && !syndicate.isShared) {
      throw new Error(
        "You may only select a Syndicate you own or one that is shared.",
      );
    }
    // Within-game uniqueness (Task 0d). Walk the index for this
    // syndicateId and reject if any OTHER player in this game has it
    // selected. Self-match is idempotent.
    const existingSelectors = await ctx.db
      .query("players")
      .withIndex("by_selected_syndicate", (q) =>
        q.eq("selectedSyndicateId", targetSyndicateId),
      )
      .collect();
    for (const other of existingSelectors) {
      if (other.gameId === args.gameId && other._id !== player._id) {
        throw new Error(
          "Another Player in this game has already selected that Syndicate.",
        );
      }
    }
    await ctx.db.patch(player._id, { selectedSyndicateId: targetSyndicateId });
  },
});

/**
 * Rule 20 (transition). Only these arrows allowed:
 *   ready → playing
 *   ready → archived
 *   playing → archived
 * GM-only. On `ready → playing`:
 *   1. Reject if any Player lacks `selectedSyndicateId` (Rule 14).
 *   2. Set `startedAt = Date.now()`.
 *   3. Flip `played=true` on every distinct selected Syndicate.
 */
export const transitionState = mutation({
  args: {
    gameId: v.id("games"),
    target: v.union(v.literal("playing"), v.literal("archived")),
  },
  handler: async (ctx, args) => {
    const game = await requireGameGm(ctx, args.gameId);
    const current = game.state;
    const next = args.target;

    const allowed =
      (current === "ready" && next === "playing") ||
      (current === "ready" && next === "archived") ||
      (current === "playing" && next === "archived");
    if (!allowed) {
      throw new Error(`Cannot transition from ${current} to ${next}.`);
    }

    if (current === "ready" && next === "playing") {
      const players = await ctx.db
        .query("players")
        .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
        .collect();
      const unselected: string[] = [];
      for (const p of players) {
        if (!p.selectedSyndicateId) {
          const user = await ctx.db.get(p.userId);
          unselected.push(user?.displayName ?? user?.email ?? "Unknown user");
        }
      }
      if (unselected.length > 0) {
        throw new Error(
          `Cannot start game: these Players have no Syndicate selected: ${unselected.join(", ")}.`,
        );
      }
      const distinct = new Set<Id<"syndicates">>();
      for (const p of players) {
        if (p.selectedSyndicateId) distinct.add(p.selectedSyndicateId);
      }
      const now = Date.now();
      await ctx.db.patch(args.gameId, { state: "playing", startedAt: now });
      for (const sid of distinct) {
        const s = await ctx.db.get(sid);
        if (s && !s.played) {
          await ctx.db.patch(sid, { played: true });
        }
      }
      return;
    }

    // ready → archived or playing → archived
    await ctx.db.patch(args.gameId, {
      state: "archived",
      archivedAt: Date.now(),
    });
  },
});

/**
 * List games relevant to the current user: as GM or as Player.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const [asGm, asPlayerRows] = await Promise.all([
      ctx.db
        .query("games")
        .withIndex("by_gm", (q) => q.eq("gmId", userId))
        .collect(),
      ctx.db
        .query("players")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    ]);
    const seen = new Set<Id<"games">>();
    const games: Doc<"games">[] = [];
    for (const g of asGm) {
      if (!seen.has(g._id)) {
        seen.add(g._id);
        games.push(g);
      }
    }
    for (const p of asPlayerRows) {
      if (!seen.has(p.gameId)) {
        const g = await ctx.db.get(p.gameId);
        if (g) {
          seen.add(g._id);
          games.push(g);
        }
      }
    }
    games.sort((a, b) => b._creationTime - a._creationTime);

    // Annotate viewer role.
    return games.map((g) => ({
      ...g,
      isGm: g.gmId === userId,
    }));
  },
});

/**
 * Game detail view for a participant (GM or Player). Returns game, roster with
 * user display names + selected syndicate names + POWER, and the viewer's role
 * plus whether they are a Player (and if so, the playerId).
 *
 * Non-participants are rejected.
 */
export const getGameView = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const game = await ctx.db.get(args.gameId);
    if (!game) return null;

    const isGm = game.gmId === userId;
    const players = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .collect();
    const myPlayer = players.find((p) => p.userId === userId) ?? null;

    // Only participants can view. Authenticated non-participants see null.
    if (!isGm && !myPlayer) return null;

    const roster = await Promise.all(
      players.map(async (p) => {
        const u = await ctx.db.get(p.userId);
        const displayName = u?.displayName ?? u?.email ?? "Unknown";
        let syndicate: {
          _id: Id<"syndicates">;
          name: string;
          leader: string;
        } | null = null;
        if (p.selectedSyndicateId) {
          const s = await ctx.db.get(p.selectedSyndicateId);
          if (s) {
            syndicate = { _id: s._id, name: s.name, leader: s.leader };
          }
        }
        return {
          _id: p._id,
          userId: p.userId,
          displayName,
          power: p.power,
          selectedSyndicateId: p.selectedSyndicateId ?? null,
          selectedSyndicate: syndicate,
          joinedAt: p.joinedAt,
        };
      }),
    );
    roster.sort((a, b) => a.joinedAt - b.joinedAt);

    const gm = await ctx.db.get(game.gmId);
    const gmName = gm?.displayName ?? gm?.email ?? "Unknown";

    return {
      game,
      gm: { _id: game.gmId, displayName: gmName },
      roster,
      viewer: {
        userId,
        isGm,
        playerId: (myPlayer?._id ?? null) as Id<"players"> | null,
      },
    };
  },
});
