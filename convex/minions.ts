import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  assertSyndicateEditableForAdminOrOwner,
  requireUserId,
} from "./lib/auth";

/**
 * Minion CRUD — Rule 4.
 *
 * Up to 8 per Syndicate. Mandatory name. Optional accent (<=40 chars).
 * Optional description. 1–5 skills (each a single non-empty string).
 *
 * Additional cap: the union of skill names across every Minion in a
 * Syndicate is limited to 13 distinct names (case-insensitive).
 */

const MAX_MINIONS = 8;
const MIN_SKILLS = 1;
const MAX_SKILLS = 5;
const NAME_MAX = 120;
const ACCENT_MAX = 40;
const DESCRIPTION_MAX = 2000;
const SKILL_MAX = 120;
const MAX_UNIQUE_SYNDICATE_SKILLS = 13;

/**
 * Count the distinct (case-insensitive) skill names used across a list of
 * minion skill arrays, preserving the first-seen original casing.
 */
function uniqueSkillSet(skillLists: string[][]): Set<string> {
  const seen = new Set<string>();
  for (const list of skillLists) {
    for (const s of list) {
      seen.add(s.trim().toLowerCase());
    }
  }
  return seen;
}

function validateSkills(skills: string[]): string[] {
  if (skills.length < MIN_SKILLS || skills.length > MAX_SKILLS) {
    throw new Error(`Minion must have ${MIN_SKILLS}–${MAX_SKILLS} skills.`);
  }
  const out: string[] = [];
  for (const s of skills) {
    const trimmed = s.trim();
    if (trimmed.length < 1)
      throw new Error("Skill must be at least 1 character.");
    if (trimmed.length > SKILL_MAX) {
      throw new Error(`Skill must be at most ${SKILL_MAX} characters.`);
    }
    out.push(trimmed);
  }
  return out;
}

function validateName(name: string): string {
  const t = name.trim();
  if (t.length < 1 || t.length > NAME_MAX) {
    throw new Error(`Minion name must be 1–${NAME_MAX} characters.`);
  }
  return t;
}

function validateAccent(accent: string | undefined): string | undefined {
  if (accent === undefined) return undefined;
  const t = accent.trim();
  if (t.length === 0) return undefined;
  if (t.length > ACCENT_MAX) {
    throw new Error(`Accent must be at most ${ACCENT_MAX} characters.`);
  }
  return t;
}

function validateDescription(
  description: string | undefined,
): string | undefined {
  if (description === undefined) return undefined;
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(
      `Description must be at most ${DESCRIPTION_MAX} characters.`,
    );
  }
  return description;
}

export const create = mutation({
  args: {
    syndicateId: v.id("syndicates"),
    name: v.string(),
    accent: v.optional(v.string()),
    description: v.optional(v.string()),
    skills: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    await assertSyndicateEditableForAdminOrOwner(ctx, args.syndicateId);
    const name = validateName(args.name);
    const accent = validateAccent(args.accent);
    const description = validateDescription(args.description);
    const skills = validateSkills(args.skills);

    const existing = await ctx.db
      .query("minions")
      .withIndex("by_syndicate", (q) => q.eq("syndicateId", args.syndicateId))
      .collect();
    if (existing.length >= MAX_MINIONS) {
      throw new Error(`A Syndicate may have at most ${MAX_MINIONS} Minions.`);
    }

    // Enforce the per-Syndicate 13-unique-skill cap across all Minions.
    const merged = uniqueSkillSet([...existing.map((m) => m.skills), skills]);
    if (merged.size > MAX_UNIQUE_SYNDICATE_SKILLS) {
      throw new Error(
        `A Syndicate may use at most ${MAX_UNIQUE_SYNDICATE_SKILLS} distinct skills across all its Minions.`,
      );
    }

    const maxOrder = existing.reduce((m, x) => Math.max(m, x.order), -1);
    return await ctx.db.insert("minions", {
      syndicateId: args.syndicateId,
      name,
      accent,
      description,
      skills,
      order: maxOrder + 1,
    });
  },
});

export const update = mutation({
  args: {
    minionId: v.id("minions"),
    name: v.optional(v.string()),
    accent: v.optional(v.string()),
    description: v.optional(v.string()),
    skills: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const minion = await ctx.db.get(args.minionId);
    if (!minion) throw new Error("Minion not found.");
    await assertSyndicateEditableForAdminOrOwner(ctx, minion.syndicateId);

    const patch: {
      name?: string;
      accent?: string | undefined;
      description?: string | undefined;
      skills?: string[];
    } = {};
    if (args.name !== undefined) patch.name = validateName(args.name);
    if (args.accent !== undefined) patch.accent = validateAccent(args.accent);
    if (args.description !== undefined)
      patch.description = validateDescription(args.description);
    if (args.skills !== undefined) {
      const skills = validateSkills(args.skills);
      // Recompute syndicate-wide unique skill count with this minion's
      // skills replaced by the new list.
      const siblings = await ctx.db
        .query("minions")
        .withIndex("by_syndicate", (q) =>
          q.eq("syndicateId", minion.syndicateId),
        )
        .collect();
      const merged = uniqueSkillSet([
        ...siblings.filter((m) => m._id !== args.minionId).map((m) => m.skills),
        skills,
      ]);
      if (merged.size > MAX_UNIQUE_SYNDICATE_SKILLS) {
        throw new Error(
          `A Syndicate may use at most ${MAX_UNIQUE_SYNDICATE_SKILLS} distinct skills across all its Minions.`,
        );
      }
      patch.skills = skills;
    }

    await ctx.db.patch(args.minionId, patch);
  },
});

export const remove = mutation({
  args: { minionId: v.id("minions") },
  handler: async (ctx, args) => {
    const minion = await ctx.db.get(args.minionId);
    if (!minion) throw new Error("Minion not found.");
    await assertSyndicateEditableForAdminOrOwner(ctx, minion.syndicateId);

    // Cascade per-game state rows referring to this minion.
    const gpms = await ctx.db
      .query("gamePlayerMinions")
      .filter((q) => q.eq(q.field("minionId"), args.minionId))
      .collect();
    for (const gpm of gpms) await ctx.db.delete(gpm._id);

    // Cascade notes targeting this minion across every game.
    const minionNotes = await ctx.db
      .query("notes")
      .withIndex("by_minion", (q) => q.eq("targetMinionId", args.minionId))
      .collect();
    for (const n of minionNotes) await ctx.db.delete(n._id);

    await ctx.db.delete(args.minionId);
  },
});

export const listForSyndicate = query({
  args: { syndicateId: v.id("syndicates") },
  handler: async (ctx, args) => {
    await requireUserId(ctx);
    const minions = await ctx.db
      .query("minions")
      .withIndex("by_syndicate", (q) => q.eq("syndicateId", args.syndicateId))
      .collect();
    minions.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    return minions;
  },
});
