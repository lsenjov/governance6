import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { assertSyndicateEditable, requireUserId } from "./lib/auth";

/**
 * Drawback CRUD — Rule 3 (0–5 per Syndicate).
 *
 * `abbreviation` and `isRolled` are admin-managed via the
 * `presetDrawbacks` catalogue. In production they are populated only by
 * the Syndicate editor's preset-prefill pipeline at row creation; the
 * editor does NOT call `update` with these fields. They are accepted by
 * the mutation API for completeness (e.g. admin DB-shell scripts), but
 * any UI-driven flow leaves them at their preset-frozen values.
 *
 * Toggling `isRolled` only affects future roll sets. `callRollSets` is
 * append-only, so a flipped boolean cannot retroactively rewrite
 * history. See dice-rolls v3 plan
 * (`plans/2026-04-28-2026-04-28-dice-rolls-v3.md` Key finding 3).
 */

const MAX_DRAWBACKS = 5;
const DRAWBACK_NAME_MAX = 120;
const DRAWBACK_DESC_MAX = 2000;
/**
 * Maximum length of a drawback abbreviation after trim. Six chars is
 * the brutalist square-cell budget — fits between Skill and Chaos at
 * the right-rail size without wrapping. The dice-roll helper's own
 * `EXTRA_NAME_MAX = 24` (`convex/lib/rolls.ts:66`) is a defensive
 * upper bound shared by all extras kinds; the drawback-specific cap
 * is intentionally stricter.
 */
const DRAWBACK_ABBREV_MAX = 6;

/**
 * Normalise an abbreviation argument to either a valid trimmed string
 * (1..DRAWBACK_ABBREV_MAX chars) or `undefined`.
 *
 * Treats `undefined` and empty-after-trim as "absent" so the boundary
 * shape stays clean for `ctx.db.patch`'s explicit-undefined idiom.
 */
function normaliseAbbreviation(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > DRAWBACK_ABBREV_MAX) {
    throw new Error(
      `Drawback abbreviation must be at most ${DRAWBACK_ABBREV_MAX} characters.`,
    );
  }
  return trimmed;
}

export const create = mutation({
  args: {
    syndicateId: v.id("syndicates"),
    name: v.string(),
    description: v.string(),
    // Optional: in production, only set by the editor's preset-prefill
    // pipeline. Free-form drawback rows pass `undefined`.
    abbreviation: v.optional(v.string()),
    isRolled: v.optional(v.boolean()),
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
    const abbreviation = normaliseAbbreviation(args.abbreviation);
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
      // Persist both fields. Schema-level optionality means
      // `undefined` is a legal stored value, but we set them
      // explicitly so the row's shape is predictable for downstream
      // readers.
      abbreviation,
      isRolled: args.isRolled === true ? true : false,
    });
  },
});

export const update = mutation({
  args: {
    drawbackId: v.id("drawbacks"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    // Optional: in production the Syndicate editor does not patch
    // these fields. They exist for admin tooling and tests.
    abbreviation: v.optional(v.string()),
    isRolled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const drawback = await ctx.db.get(args.drawbackId);
    if (!drawback) throw new Error("Drawback not found.");
    await assertSyndicateEditable(ctx, drawback.syndicateId);
    const patch: Partial<{
      name: string;
      description: string;
      abbreviation: string | undefined;
      isRolled: boolean;
    }> = {};
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
    if (args.abbreviation !== undefined) {
      // Explicit empty-string-after-trim clears the field via an
      // explicit `undefined` patch, mirroring the
      // `convex/lib/calls.ts:105,111` idiom.
      patch.abbreviation = normaliseAbbreviation(args.abbreviation);
    }
    if (args.isRolled !== undefined) {
      patch.isRolled = args.isRolled;
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
    // The new `abbreviation` and `isRolled` fields are returned
    // automatically by `.collect()`. Downstream consumers must treat
    // `isRolled === undefined` as `false` (matching the schema's
    // optional-defaults-to-false convention), which is exactly what
    // the dice-roll trigger site does in `convex/lib/rolls.ts`.
    return drawbacks;
  },
});
