import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  assertSyndicateEditable,
  requireSyndicateOwner,
  requireUser,
  requireUserId,
} from "./lib/auth";

/**
 * Syndicate CRUD — Rule 2 / Rule 5 / Rule 6 / Rule 9.
 */

const SYNDICATE_NAME_MAX = 120;
const SYNDICATE_LEADER_MAX = 120;
const SYNDICATE_DESC_MAX = 4000;

function assertStringLen(
  field: string,
  value: string,
  min: number,
  max: number,
) {
  const trimmed = value.trim();
  if (trimmed.length < min)
    throw new Error(`${field} must be at least ${min} characters.`);
  if (trimmed.length > max)
    throw new Error(`${field} must be at most ${max} characters.`);
}

export const create = mutation({
  args: {
    name: v.string(),
    leader: v.string(),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    assertStringLen("Name", args.name, 1, SYNDICATE_NAME_MAX);
    assertStringLen("Leader", args.leader, 1, SYNDICATE_LEADER_MAX);
    if (args.description.length > SYNDICATE_DESC_MAX) {
      throw new Error(
        `Description must be at most ${SYNDICATE_DESC_MAX} characters.`,
      );
    }
    return await ctx.db.insert("syndicates", {
      name: args.name.trim(),
      leader: args.leader.trim(),
      description: args.description,
      played: false,
      isShared: false,
      ownerId: user._id,
    });
  },
});

export const update = mutation({
  args: {
    syndicateId: v.id("syndicates"),
    name: v.optional(v.string()),
    leader: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertSyndicateEditable(ctx, args.syndicateId);
    const patch: Partial<{
      name: string;
      leader: string;
      description: string;
    }> = {};
    if (args.name !== undefined) {
      assertStringLen("Name", args.name, 1, SYNDICATE_NAME_MAX);
      patch.name = args.name.trim();
    }
    if (args.leader !== undefined) {
      assertStringLen("Leader", args.leader, 1, SYNDICATE_LEADER_MAX);
      patch.leader = args.leader.trim();
    }
    if (args.description !== undefined) {
      if (args.description.length > SYNDICATE_DESC_MAX) {
        throw new Error(
          `Description must be at most ${SYNDICATE_DESC_MAX} characters.`,
        );
      }
      patch.description = args.description;
    }
    await ctx.db.patch(args.syndicateId, patch);
  },
});

export const setIsShared = mutation({
  args: {
    syndicateId: v.id("syndicates"),
    value: v.boolean(),
  },
  handler: async (ctx, args) => {
    // Rule 6: `isShared` toggleable in either direction while played=false.
    await assertSyndicateEditable(ctx, args.syndicateId);
    await ctx.db.patch(args.syndicateId, { isShared: args.value });
  },
});

/**
 * Rule 9: delete allowed only while played=false. Cascades Drawbacks,
 * Minions, and gamePlayerMinions. Clears `selectedSyndicateId` from every
 * `ready`-game Player that had this Syndicate selected.
 */
export const remove = mutation({
  args: { syndicateId: v.id("syndicates") },
  handler: async (ctx, args) => {
    const syndicate = await requireSyndicateOwner(ctx, args.syndicateId);
    if (syndicate.played) {
      throw new Error(
        "Cannot delete a Syndicate that has been played. Games reference its content.",
      );
    }

    // Delete all drawbacks.
    const drawbacks = await ctx.db
      .query("drawbacks")
      .withIndex("by_syndicate", (q) => q.eq("syndicateId", args.syndicateId))
      .collect();
    for (const d of drawbacks) await ctx.db.delete(d._id);

    // Delete all minions (also cascade gamePlayerMinions and minion-target notes).
    const minions = await ctx.db
      .query("minions")
      .withIndex("by_syndicate", (q) => q.eq("syndicateId", args.syndicateId))
      .collect();
    for (const m of minions) {
      const gpms = await ctx.db
        .query("gamePlayerMinions")
        .filter((q) => q.eq(q.field("minionId"), m._id))
        .collect();
      for (const gpm of gpms) await ctx.db.delete(gpm._id);
      const minionNotes = await ctx.db
        .query("notes")
        .withIndex("by_minion", (q) => q.eq("targetMinionId", m._id))
        .collect();
      for (const n of minionNotes) await ctx.db.delete(n._id);
      await ctx.db.delete(m._id);
    }

    // Cascade notes targeting this syndicate across every game.
    const syndicateNotes = await ctx.db
      .query("notes")
      .withIndex("by_syndicate", (q) =>
        q.eq("targetSyndicateId", args.syndicateId),
      )
      .collect();
    for (const n of syndicateNotes) await ctx.db.delete(n._id);

    // Unselect from every `ready`-game Player that had this Syndicate.
    const referringPlayers = await ctx.db
      .query("players")
      .withIndex("by_selected_syndicate", (q) =>
        q.eq("selectedSyndicateId", args.syndicateId),
      )
      .collect();
    for (const p of referringPlayers) {
      const game = await ctx.db.get(p.gameId);
      if (game && game.state === "ready") {
        await ctx.db.patch(p._id, { selectedSyndicateId: undefined });
      }
    }

    await ctx.db.delete(args.syndicateId);
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    return await ctx.db
      .query("syndicates")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .order("desc")
      .collect();
  },
});

export const listShared = query({
  args: {},
  handler: async (ctx) => {
    await requireUserId(ctx);
    const shared = await ctx.db
      .query("syndicates")
      .withIndex("by_shared", (q) => q.eq("isShared", true))
      .order("desc")
      .collect();
    // Decorate with owner display name for the shared directory view.
    const ownerIds = Array.from(new Set(shared.map((s) => s.ownerId)));
    const owners: Record<string, string> = {};
    for (const oid of ownerIds) {
      const owner = await ctx.db.get(oid);
      owners[oid] = owner?.displayName ?? owner?.email ?? "Unknown";
    }
    return shared.map((s) => ({ ...s, ownerName: owners[s.ownerId] }));
  },
});

export const getWithChildren = query({
  args: { syndicateId: v.id("syndicates") },
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const syndicate = await ctx.db.get(args.syndicateId);
    if (!syndicate) return null;
    // Visibility: owner OR isShared.
    if (syndicate.ownerId !== userId && !syndicate.isShared) {
      return null;
    }
    const [drawbacks, minions] = await Promise.all([
      ctx.db
        .query("drawbacks")
        .withIndex("by_syndicate", (q) => q.eq("syndicateId", args.syndicateId))
        .collect(),
      ctx.db
        .query("minions")
        .withIndex("by_syndicate", (q) => q.eq("syndicateId", args.syndicateId))
        .collect(),
    ]);
    drawbacks.sort((a, b) => a.order - b.order);
    minions.sort((a, b) => a.order - b.order);
    const isOwner = syndicate.ownerId === userId;
    return {
      ...syndicate,
      drawbacks,
      minions,
      isOwner,
      canEdit: isOwner && !syndicate.played,
    };
  },
});

/**
 * Rule 13: Syndicates selectable for a Player — own or isShared.
 */
export const listSelectable = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUserId(ctx);
    const [owned, shared] = await Promise.all([
      ctx.db
        .query("syndicates")
        .withIndex("by_owner", (q) => q.eq("ownerId", userId))
        .collect(),
      ctx.db
        .query("syndicates")
        .withIndex("by_shared", (q) => q.eq("isShared", true))
        .collect(),
    ]);
    const seen = new Set<Id<"syndicates">>();
    const merged: (typeof owned)[number][] = [];
    for (const s of [...owned, ...shared]) {
      if (!seen.has(s._id)) {
        seen.add(s._id);
        merged.push(s);
      }
    }
    merged.sort((a, b) => a.name.localeCompare(b.name));
    return merged;
  },
});
