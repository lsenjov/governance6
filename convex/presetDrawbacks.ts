import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSiteAdmin, requireUserId } from "./lib/auth";

/**
 * Preset drawback catalogue.
 *
 * Read: any authenticated user (used by the Syndicate editor's
 * drawback-name autocomplete). Write: site admins only. Site admin
 * status is granted directly in the database — there is no in-app UI
 * that flips the `users.isSiteAdmin` flag.
 *
 * Drawback names are treated case-insensitively for uniqueness but the
 * original casing entered by the admin is preserved for display.
 *
 * Picking a preset in the Syndicate editor copies all four fields onto
 * the per-Syndicate `drawbacks` row at insert time. There is NO
 * foreign key from `drawbacks` to `presetDrawbacks`. Editing a preset
 * row after a syndicate has copied it leaves the syndicate's row
 * stale by design — Played syndicates are frozen by Rule 7 and the
 * preset catalogue is a convenience layer, not a constraint.
 */

const NAME_MAX = 120;
const DESCRIPTION_MAX = 2000;
const ABBREV_MAX = 6;

function normaliseName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 1) {
    throw new Error("Preset drawback name must be at least 1 character.");
  }
  if (trimmed.length > NAME_MAX) {
    throw new Error(
      `Preset drawback name must be at most ${NAME_MAX} characters.`,
    );
  }
  return trimmed;
}

function validateDescription(raw: string): void {
  if (raw.length > DESCRIPTION_MAX) {
    throw new Error(
      `Preset drawback description must be at most ${DESCRIPTION_MAX} characters.`,
    );
  }
}

function normaliseAbbreviation(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > ABBREV_MAX) {
    throw new Error(
      `Preset drawback abbreviation must be at most ${ABBREV_MAX} characters.`,
    );
  }
  return trimmed;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireUserId(ctx);
    const rows = await ctx.db.query("presetDrawbacks").collect();
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  },
});

export const add = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    abbreviation: v.optional(v.string()),
    isRolled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const admin = await requireSiteAdmin(ctx);
    const name = normaliseName(args.name);
    validateDescription(args.description);
    const abbreviation = normaliseAbbreviation(args.abbreviation);
    // Case-insensitive uniqueness — same idiom as
    // `convex/presetSkills.ts:46-50`.
    const existing = await ctx.db.query("presetDrawbacks").collect();
    const lower = name.toLowerCase();
    if (existing.some((s) => s.name.toLowerCase() === lower)) {
      throw new Error("A preset drawback with that name already exists.");
    }
    return await ctx.db.insert("presetDrawbacks", {
      name,
      description: args.description,
      abbreviation,
      isRolled: args.isRolled === true ? true : false,
      createdByUserId: admin._id,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: {
    drawbackId: v.id("presetDrawbacks"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    abbreviation: v.optional(v.string()),
    isRolled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireSiteAdmin(ctx);
    const existing = await ctx.db.get(args.drawbackId);
    if (!existing) throw new Error("Preset drawback not found.");
    const patch: Partial<{
      name: string;
      description: string;
      abbreviation: string | undefined;
      isRolled: boolean;
    }> = {};
    if (args.name !== undefined) {
      const name = normaliseName(args.name);
      const lower = name.toLowerCase();
      const others = await ctx.db.query("presetDrawbacks").collect();
      if (
        others.some(
          (s) => s._id !== args.drawbackId && s.name.toLowerCase() === lower,
        )
      ) {
        throw new Error("A preset drawback with that name already exists.");
      }
      patch.name = name;
    }
    if (args.description !== undefined) {
      validateDescription(args.description);
      patch.description = args.description;
    }
    if (args.abbreviation !== undefined) {
      // Explicit empty-string-after-trim clears the field via an
      // explicit `undefined` patch.
      patch.abbreviation = normaliseAbbreviation(args.abbreviation);
    }
    if (args.isRolled !== undefined) {
      patch.isRolled = args.isRolled;
    }
    await ctx.db.patch(args.drawbackId, patch);
  },
});

export const remove = mutation({
  args: { drawbackId: v.id("presetDrawbacks") },
  handler: async (ctx, args) => {
    await requireSiteAdmin(ctx);
    const existing = await ctx.db.get(args.drawbackId);
    if (!existing) return;
    // No FK fan-out is needed — per-Syndicate `drawbacks` rows do not
    // reference preset rows; values are copied at pick time.
    await ctx.db.delete(args.drawbackId);
  },
});
