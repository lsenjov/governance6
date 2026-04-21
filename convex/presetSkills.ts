import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireSiteAdmin, requireUserId } from "./lib/auth";

/**
 * Preset skill catalogue.
 *
 * Read: any authenticated user (used by the Minion editor's autocomplete).
 * Write: site admins only. Site admin status is granted directly in the
 * database — there is no in-app UI that flips the `users.isSiteAdmin`
 * flag.
 *
 * Skill names are treated case-insensitively for uniqueness but the
 * original casing entered by the admin is preserved for display.
 */

const SKILL_NAME_MAX = 120;

function normalizeName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 1) {
    throw new Error("Skill name must be at least 1 character.");
  }
  if (trimmed.length > SKILL_NAME_MAX) {
    throw new Error(`Skill name must be at most ${SKILL_NAME_MAX} characters.`);
  }
  return trimmed;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireUserId(ctx);
    const rows = await ctx.db.query("presetSkills").collect();
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  },
});

export const add = mutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireSiteAdmin(ctx);
    const name = normalizeName(args.name);
    // Case-insensitive uniqueness.
    const existing = await ctx.db.query("presetSkills").collect();
    const lower = name.toLowerCase();
    if (existing.some((s) => s.name.toLowerCase() === lower)) {
      throw new Error("A preset skill with that name already exists.");
    }
    return await ctx.db.insert("presetSkills", {
      name,
      createdByUserId: admin._id,
      createdAt: Date.now(),
    });
  },
});

export const update = mutation({
  args: { skillId: v.id("presetSkills"), name: v.string() },
  handler: async (ctx, args) => {
    await requireSiteAdmin(ctx);
    const existing = await ctx.db.get(args.skillId);
    if (!existing) throw new Error("Preset skill not found.");
    const name = normalizeName(args.name);
    const lower = name.toLowerCase();
    const others = await ctx.db.query("presetSkills").collect();
    if (
      others.some(
        (s) => s._id !== args.skillId && s.name.toLowerCase() === lower,
      )
    ) {
      throw new Error("A preset skill with that name already exists.");
    }
    await ctx.db.patch(args.skillId, { name });
  },
});

export const remove = mutation({
  args: { skillId: v.id("presetSkills") },
  handler: async (ctx, args) => {
    await requireSiteAdmin(ctx);
    const existing = await ctx.db.get(args.skillId);
    if (!existing) return;
    await ctx.db.delete(args.skillId);
  },
});
