import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireGameGm,
  requireGamePlayer,
  requireGameParticipant,
} from "./lib/auth";

/**
 * Treason Grants — Rule 26.
 *
 * Per-game GM-authored bundles of (keyword, POWER, description, optional
 * player owner). The GM creates/edits/deletes grants and may clear an
 * existing owner; only Players (not the GM) take grants. Taking an
 * unowned grant while the game is `playing` writes a single ledger
 * entry (`source: "treason_grant"`) on the taker, +`power`, and patches
 * the materialised `players.power` cache (Rule 25) in one transaction.
 *
 * Visibility:
 *   - Every participant sees `keyword`, `power`, and the owner display
 *     name (if any).
 *   - Description is revealed to the GM (always) and to the owning
 *     Player. To everyone else it is redacted.
 *
 * Lifecycle:
 *   - GM CRUD allowed in `ready` and `playing`. Disallowed in `archived`.
 *   - Take allowed only in `playing`.
 *   - GM may edit `keyword` and `description` on a taken grant. The
 *     `power` field is FROZEN once `ownerPlayerId` is set.
 *   - Delete and Clear-owner do NOT reverse POWER previously paid out.
 *     Clearing an owner re-opens the grant; the next taker receives
 *     the full POWER again. This is intentional (Decision 9 of the plan).
 *
 * See `plans/2026-04-27-treason-grants-v1.md`.
 */

const KEYWORD_MIN = 1;
const KEYWORD_MAX = 40;
const DESCRIPTION_MAX = 2000;
const POWER_MIN = 1;
const POWER_MAX = 1000;

type ValidatedFields = {
  keyword?: string;
  keywordLower?: string;
  power?: number;
  description?: string;
};

function normaliseKeyword(raw: string): { keyword: string; lower: string } {
  const keyword = raw.trim();
  if (keyword.length < KEYWORD_MIN) {
    throw new Error("Keyword must not be empty.");
  }
  if (keyword.length > KEYWORD_MAX) {
    throw new Error(`Keyword must be at most ${KEYWORD_MAX} characters.`);
  }
  return { keyword, lower: keyword.toLowerCase() };
}

function validatePower(power: number): number {
  if (!Number.isFinite(power) || !Number.isInteger(power)) {
    throw new Error("POWER must be an integer.");
  }
  if (power < POWER_MIN) {
    throw new Error(`POWER must be at least ${POWER_MIN}.`);
  }
  if (power > POWER_MAX) {
    throw new Error(`POWER must be at most ${POWER_MAX}.`);
  }
  return power;
}

function validateDescription(description: string): string {
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(
      `Description must be at most ${DESCRIPTION_MAX} characters.`,
    );
  }
  return description;
}

/**
 * GM-only writability gate: the caller must be the GM of the game and
 * the game must not be archived. Used by every GM mutation in this file.
 */
async function assertGrantWritable(
  ctx: MutationCtx,
  gameId: Id<"games">,
): Promise<Doc<"games">> {
  const game = await requireGameGm(ctx, gameId);
  if (game.state === "archived") {
    throw new Error("Treason Grants cannot be modified in an archived game.");
  }
  return game;
}

/**
 * Throws if a different grant in the same game already uses this
 * (case-insensitive) keyword. Pass `exceptGrantId` when validating an
 * edit so the row being edited doesn't match itself.
 */
async function assertKeywordUniqueInGame(
  ctx: MutationCtx,
  gameId: Id<"games">,
  keywordLower: string,
  exceptGrantId?: Id<"treasonGrants">,
): Promise<void> {
  const collisions = await ctx.db
    .query("treasonGrants")
    .withIndex("by_game_keywordLower", (q) =>
      q.eq("gameId", gameId).eq("keywordLower", keywordLower),
    )
    .collect();
  for (const c of collisions) {
    if (c._id !== exceptGrantId) {
      throw new Error(
        "A Treason Grant with this keyword already exists in this game.",
      );
    }
  }
}

export const createGrant = mutation({
  args: {
    gameId: v.id("games"),
    keyword: v.string(),
    power: v.number(),
    description: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"treasonGrants">> => {
    const game = await assertGrantWritable(ctx, args.gameId);
    const { keyword, lower } = normaliseKeyword(args.keyword);
    const power = validatePower(args.power);
    const description = validateDescription(args.description);
    await assertKeywordUniqueInGame(ctx, args.gameId, lower);

    return await ctx.db.insert("treasonGrants", {
      gameId: game._id,
      keyword,
      keywordLower: lower,
      power,
      description,
      ownerPlayerId: undefined,
      takenAt: undefined,
      createdAt: Date.now(),
      createdByUserId: game.gmId,
    });
  },
});

export const updateGrant = mutation({
  args: {
    grantId: v.id("treasonGrants"),
    keyword: v.optional(v.string()),
    power: v.optional(v.number()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (!grant) throw new Error("Treason Grant not found.");
    await assertGrantWritable(ctx, grant.gameId);

    const patch: ValidatedFields = {};
    let changed = false;

    if (args.keyword !== undefined) {
      const { keyword, lower } = normaliseKeyword(args.keyword);
      if (lower !== grant.keywordLower) {
        await assertKeywordUniqueInGame(ctx, grant.gameId, lower, grant._id);
      }
      patch.keyword = keyword;
      patch.keywordLower = lower;
      changed = true;
    }
    if (args.power !== undefined) {
      if (grant.ownerPlayerId !== undefined) {
        throw new Error(
          "POWER cannot be changed once a Treason Grant has been taken.",
        );
      }
      patch.power = validatePower(args.power);
      changed = true;
    }
    if (args.description !== undefined) {
      patch.description = validateDescription(args.description);
      changed = true;
    }

    if (!changed) return;
    await ctx.db.patch(grant._id, patch);
  },
});

/**
 * GM-only delete. POWER previously paid out is NOT reversed.
 */
export const deleteGrant = mutation({
  args: { grantId: v.id("treasonGrants") },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (!grant) throw new Error("Treason Grant not found.");
    await assertGrantWritable(ctx, grant.gameId);
    await ctx.db.delete(grant._id);
  },
});

/**
 * GM-only: clear the current owner of a grant. The previous owner KEEPS
 * the POWER they were paid; the grant becomes takeable again, including
 * by a different player who will receive the full POWER on take.
 *
 * Idempotent: clearing an already-unowned grant is a no-op.
 */
export const clearGrantOwner = mutation({
  args: { grantId: v.id("treasonGrants") },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (!grant) throw new Error("Treason Grant not found.");
    await assertGrantWritable(ctx, grant.gameId);
    if (grant.ownerPlayerId === undefined) return;
    await ctx.db.patch(grant._id, {
      ownerPlayerId: undefined,
      takenAt: undefined,
    });
  },
});

/**
 * Player-only take. Caller must be a Player in the game (this also
 * rejects the GM by Rule 11). Game must be `playing`. Grant must be
 * unowned. Atomically: claim the grant, write a ledger entry, and
 * patch the materialised power cache.
 */
export const takeGrant = mutation({
  args: { grantId: v.id("treasonGrants") },
  handler: async (ctx, args) => {
    const grant = await ctx.db.get(args.grantId);
    if (!grant) throw new Error("Treason Grant not found.");
    const { game, player } = await requireGamePlayer(ctx, grant.gameId);
    if (game.state !== "playing") {
      throw new Error(
        "Treason Grants can only be taken while the game is playing.",
      );
    }
    if (grant.ownerPlayerId !== undefined) {
      throw new Error("That Treason Grant has already been taken.");
    }
    // Defensive: power should always be a positive integer per validation
    // on create/update; this guard catches any pre-existing data drift.
    if (
      !Number.isFinite(grant.power) ||
      !Number.isInteger(grant.power) ||
      grant.power < POWER_MIN
    ) {
      throw new Error("Treason Grant has an invalid POWER amount.");
    }

    const now = Date.now();
    await ctx.db.patch(grant._id, {
      ownerPlayerId: player._id,
      takenAt: now,
    });
    await ctx.db.insert("powerLedgerEntries", {
      gameId: grant.gameId,
      playerId: player._id,
      delta: grant.power,
      reason: `Treason grant: ${grant.keyword}`,
      source: "treason_grant",
      createdByUserId: player.userId,
      createdAt: now,
    });
    await ctx.db.patch(player._id, { power: player.power + grant.power });
  },
});

export type GrantRow = {
  _id: Id<"treasonGrants">;
  keyword: string;
  power: number;
  /**
   * Full text when the viewer is the GM or the owning Player; `null`
   * otherwise. Identical placeholder for unowned and owned-by-someone-
   * else cases so non-owners cannot infer ownership state from the
   * placeholder alone.
   */
  description: string | null;
  ownerPlayerId: Id<"players"> | null;
  ownerDisplayName: string | null;
  takenAt: number | null;
  createdAt: number;
  isMine: boolean;
  canTake: boolean;
  canEditPower: boolean;
};

/**
 * Per-game listing for any participant. Server-side enforces visibility
 * rule 26 (description redaction) and computes per-row capability
 * flags so the client can render trustingly.
 */
export const listGrantsForGame = query({
  args: { gameId: v.id("games") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    grants: GrantRow[];
    gameState: "ready" | "playing" | "archived";
  }> => {
    const { game, role, player } = await requireGameParticipant(
      ctx,
      args.gameId,
    );
    const grants = await ctx.db
      .query("treasonGrants")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .collect();

    // Newest first (matches notes ordering).
    grants.sort((a, b) => b._creationTime - a._creationTime);

    const ownerNames = await hydrateOwnerNames(ctx, grants);

    const myPlayerId = player?._id ?? null;
    const isGm = role === "gm";

    return {
      gameState: game.state,
      grants: grants.map((g) => {
        const isMine = myPlayerId !== null && g.ownerPlayerId === myPlayerId;
        const canSeeDescription = isGm || isMine;
        const canTake =
          role === "player" &&
          game.state === "playing" &&
          g.ownerPlayerId === undefined;
        const canEditPower = isGm && g.ownerPlayerId === undefined;
        return {
          _id: g._id,
          keyword: g.keyword,
          power: g.power,
          description: canSeeDescription ? g.description : null,
          ownerPlayerId: g.ownerPlayerId ?? null,
          ownerDisplayName: g.ownerPlayerId
            ? (ownerNames[g.ownerPlayerId] ?? "Unknown")
            : null,
          takenAt: g.takenAt ?? null,
          createdAt: g.createdAt,
          isMine,
          canTake,
          canEditPower,
        };
      }),
    };
  },
});

/**
 * Bulk-resolve player → user → display name for the unique set of
 * owner ids in a grant list. Mirrors the hydration pattern in
 * `convex/ledger.ts`.
 */
async function hydrateOwnerNames(
  ctx: QueryCtx,
  grants: Doc<"treasonGrants">[],
): Promise<Record<string, string>> {
  const playerIds = new Set<Id<"players">>();
  for (const g of grants) {
    if (g.ownerPlayerId) playerIds.add(g.ownerPlayerId);
  }
  const out: Record<string, string> = {};
  for (const pid of playerIds) {
    const p = await ctx.db.get(pid);
    if (!p) continue;
    const u = await ctx.db.get(p.userId);
    out[pid] = u?.displayName ?? u?.email ?? "Unknown";
  }
  return out;
}
