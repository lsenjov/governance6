import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertSyndicateEditable, requireUserId } from "./lib/auth";

/**
 * Drawback CRUD — Rule 3 (0–5 per Syndicate).
 */

const MAX_DRAWBACKS = 5;
const DRAWBACK_NAME_MAX = 120;
const DRAWBACK_DESC_MAX = 2000;

export const create = mutation({
  args: {
    syndicateId: v.id("syndicates"),
    name: v.string(),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    await assertSyndicateEditable(ctx, args.syndicateId);
    const name = args.name.trim();
    if (name.length < 1 || name.length > DRAWBACK_NAME_MAX) {
      throw new Error(`Drawback name must be 1–${DRAWBACK_NAME_MAX} characters.`);
    }
    if (args.description.length > DRAWBACK_DESC_MAX) {
      throw new Error(`Drawback description must be at most ${DRAWBACK_DESC_MAX} characters.`);
    }
    const existing = await ctx.db
      .query("drawbacks")
      .withIndex("by_syndicate", (q) => q.eq("syndicateId", args.syndicateId))
      .collect();
    if (existing.length >= MAX_DRAWBACKS) {
      throw new Error(`A Syndicate may have at most ${MAX_DRAWBACKS} drawbacks.`);
    }
    const maxOrder = existing.reduce((m, d) => Math.max(m, d.order), -1);
    return await ctx.db.insert("drawbacks", {
      syndicateId: args.syndicateId,
      name,
      description: args.description,
      order: maxOrder + 1,
    });
  },
});

export const update = mutation({
  args: {
    drawbackId: v.id("drawbacks"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const drawback = await ctx.db.get(args.drawbackId);
    if (!drawback) throw new Error("Drawback not found.");
    await assertSyndicateEditable(ctx, drawback.syndicateId);
    const patch: Partial<{ name: string; description: string }> = {};
    if (args.name !== undefined) {
      const n = args.name.trim();
      if (n.length < 1 || n.length > DRAWBACK_NAME_MAX) {
        throw new Error(`Drawback name must be 1–${DRAWBACK_NAME_MAX} characters.`);
      }
      patch.name = n;
    }
    if (args.description !== undefined) {
      if (args.description.length > DRAWBACK_DESC_MAX) {
        throw new Error(`Drawback description must be at most ${DRAWBACK_DESC_MAX} characters.`);
      }
      patch.description = args.description;
    }
    await ctx.db.patch(args.drawbackId, patch);
  },
});

export const remove = mutation({
  args: { drawbackId: v.id("drawbacks") },
  handler: async (ctx, args) => {
    const drawback = await ctx.db.get(args.drawbackId);
    if (!drawback) throw new Error("Drawback not found.");
    await assertSyndicateEditable(ctx, drawback.syndicateId);
    await ctx.db.delete(args.drawbackId);
  },
});

export const listForSyndicate = query({
  args: { syndicateId: v.id("syndicates") },
  handler: async (ctx, args) => {
    await requireUserId(ctx);
    const drawbacks = await ctx.db
      .query("drawbacks")
      .withIndex("by_syndicate", (q) => q.eq("syndicateId", args.syndicateId))
      .collect();
    drawbacks.sort((a, b) => a.order - b.order);
    return drawbacks;
  },
});
