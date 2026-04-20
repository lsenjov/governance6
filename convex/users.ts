import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { getCurrentUser, requireUser } from "./lib/auth";

/**
 * Rule 1: display name editable anytime; 1–40 chars, trimmed, duplicates OK.
 */

export const getMe = query({
  args: {},
  handler: async (ctx) => {
    return await getCurrentUser(ctx);
  },
});

export const updateDisplayName = mutation({
  args: { displayName: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const name = args.displayName.trim();
    if (name.length < 1 || name.length > 40) {
      throw new Error("Display name must be 1–40 characters.");
    }
    await ctx.db.patch(user._id, { displayName: name });
  },
});

/**
 * Bulk lookup helper: takes user ids and returns their display names.
 * Used by the `useUserDisplayNames` hook (Task 45).
 */
export const getDisplayNames = query({
  args: { userIds: v.array(v.id("users")) },
  handler: async (ctx, args) => {
    const out: Record<string, string> = {};
    for (const uid of args.userIds) {
      const u = await ctx.db.get(uid);
      if (u) {
        out[uid] = u.displayName ?? u.email ?? "Unknown";
      }
    }
    return out;
  },
});

/**
 * Search users by display name substring or email exact match. Used by the GM
 * roster picker (Task 18). Excludes the current user (GMs can't add
 * themselves — rule 11) and users already in the given game.
 */
export const searchUsers = query({
  args: {
    query: v.string(),
    excludeGameId: v.optional(v.id("games")),
  },
  handler: async (ctx, args) => {
    const meId = await getAuthUserId(ctx);
    const q = args.query.trim().toLowerCase();
    if (q.length < 1) return [];

    const allUsers = await ctx.db.query("users").collect();
    const excludedUserIds = new Set<string>();

    if (args.excludeGameId) {
      const existingPlayers = await ctx.db
        .query("players")
        .withIndex("by_game", (qq) => qq.eq("gameId", args.excludeGameId!))
        .collect();
      for (const p of existingPlayers) excludedUserIds.add(p.userId);
    }

    const matches = allUsers.filter((u) => {
      if (u._id === meId) return false;
      if (excludedUserIds.has(u._id)) return false;
      const dn = (u.displayName ?? "").toLowerCase();
      const em = (u.email ?? "").toLowerCase();
      return dn.includes(q) || em.includes(q);
    });

    return matches.slice(0, 20).map((u) => ({
      _id: u._id,
      displayName: u.displayName ?? u.email ?? "Unknown",
      email: u.email,
    }));
  },
});
