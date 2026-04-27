import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  requireGame,
  requireGameGm,
  requireGameParticipant,
} from "./lib/auth";

/**
 * Goals — Rule 28.
 *
 * Per-game GM-authored bundles of
 * `(keyword, description, type, fromPlayerId?, toPlayerId?, carrot?, stick?)`.
 * The GM creates / edits / deletes goals at will (in `ready` and
 * `playing`; `archived` is read-only).
 *
 * Workflow:
 *   1. The GM creates Goals; typically both player refs start unset.
 *   2. The GM gives a Goal to a Player by assigning that Player as
 *      `fromPlayerId` via `assignFromPlayer` (UI: “Assign from…”).
 *      Once set, the from-player can only be changed via `updateGoal`.
 *   3. The from-player then picks a `toPlayerId` via `assignToPlayer`
 *      (UI: “Assign to…”). Once set, the to-player can only be
 *      changed via the GM’s `updateGoal`.
 *
 * The GM never uses `assignToPlayer` — any to-player change after
 * the from-player’s pick is performed via `updateGoal` (Edit).
 *
 * Visibility:
 *   - GM sees every field on every goal in any game state.
 *   - Players see `keyword`, `type`, `from`/`to` display names, `carrot`,
 *     and `stick`.
 *   - `description` is revealed to the GM (always) and to the current
 *     `from_player` / `to_player`. To everyone else it is `null`. When
 *     both refs are unset, only the GM sees the description.
 *
 * Carrot / Stick are descriptive labels in v1; goals write NO ledger
 * entries. The GM applies any POWER consequence using the standard
 * rule-20 edit flow.
 *
 * See `plans/2026-04-27-2026-04-27-goals-v2.md`.
 */

// ─────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────

const KEYWORD_MIN = 1;
const KEYWORD_MAX = 40;
const DESCRIPTION_MAX = 2000;
const CARROT_MIN = 0;
const CARROT_MAX = 1000;
const STICK_MIN = -1000;
const STICK_MAX = 0;

export type GoalType = "regular" | "shared" | "competitive";

const goalTypeValidator = v.union(
  v.literal("regular"),
  v.literal("shared"),
  v.literal("competitive"),
);

// ─────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────

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

function validateDescription(description: string): string {
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(
      `Description must be at most ${DESCRIPTION_MAX} characters.`,
    );
  }
  return description;
}

function validateCarrot(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("Carrot must be an integer.");
  }
  if (value < CARROT_MIN) {
    throw new Error(`Carrot must be at least ${CARROT_MIN} (non-negative).`);
  }
  if (value > CARROT_MAX) {
    throw new Error(`Carrot must be at most ${CARROT_MAX}.`);
  }
  return value;
}

function validateStick(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error("Stick must be an integer.");
  }
  if (value > STICK_MAX) {
    throw new Error(`Stick must be at most ${STICK_MAX} (non-positive).`);
  }
  if (value < STICK_MIN) {
    throw new Error(`Stick must be at least ${STICK_MIN}.`);
  }
  return value;
}

/**
 * Throws if `playerId` does not reference a Player belonging to `gameId`.
 * Used on every mutation that accepts a `from`/`to` ref so a forged
 * cross-game id is rejected server-side (rule 24).
 */
async function assertPlayerInGame(
  ctx: QueryCtx | MutationCtx,
  gameId: Id<"games">,
  playerId: Id<"players">,
): Promise<Doc<"players">> {
  const player = await ctx.db.get(playerId);
  if (!player) throw new Error("Referenced Player not found.");
  if (player.gameId !== gameId) {
    throw new Error("Referenced Player does not belong to this game.");
  }
  return player;
}

/**
 * GM-only writability gate: the caller must be the GM of the game and
 * the game must not be archived. Used by every GM mutation.
 */
async function assertGoalWritableByGm(
  ctx: MutationCtx,
  gameId: Id<"games">,
): Promise<Doc<"games">> {
  const game = await requireGameGm(ctx, gameId);
  if (game.state === "archived") {
    throw new Error("Goals cannot be modified in an archived game.");
  }
  return game;
}

/**
 * Throws if a different goal in the same game already uses this
 * (case-insensitive) keyword. Pass `exceptGoalId` when validating an
 * edit so the row being edited doesn't match itself.
 */
async function assertKeywordUniqueInGame(
  ctx: MutationCtx,
  gameId: Id<"games">,
  keywordLower: string,
  exceptGoalId?: Id<"goals">,
): Promise<void> {
  const collisions = await ctx.db
    .query("goals")
    .withIndex("by_game_keywordLower", (q) =>
      q.eq("gameId", gameId).eq("keywordLower", keywordLower),
    )
    .collect();
  for (const c of collisions) {
    if (c._id !== exceptGoalId) {
      throw new Error(
        "A Goal with this keyword already exists in this game.",
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────

export const createGoal = mutation({
  args: {
    gameId: v.id("games"),
    keyword: v.string(),
    description: v.string(),
    type: goalTypeValidator,
    fromPlayerId: v.optional(v.id("players")),
    toPlayerId: v.optional(v.id("players")),
    carrot: v.optional(v.number()),
    stick: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"goals">> => {
    const game = await assertGoalWritableByGm(ctx, args.gameId);
    const { keyword, lower } = normaliseKeyword(args.keyword);
    const description = validateDescription(args.description);
    const carrot =
      args.carrot === undefined ? undefined : validateCarrot(args.carrot);
    const stick =
      args.stick === undefined ? undefined : validateStick(args.stick);

    if (args.fromPlayerId !== undefined) {
      await assertPlayerInGame(ctx, args.gameId, args.fromPlayerId);
    }
    if (args.toPlayerId !== undefined) {
      await assertPlayerInGame(ctx, args.gameId, args.toPlayerId);
      if (
        args.fromPlayerId !== undefined &&
        args.toPlayerId === args.fromPlayerId
      ) {
        throw new Error(
          "from-player and to-player must be different Players.",
        );
      }
    }

    await assertKeywordUniqueInGame(ctx, args.gameId, lower);

    return await ctx.db.insert("goals", {
      gameId: game._id,
      keyword,
      keywordLower: lower,
      description,
      type: args.type,
      fromPlayerId: args.fromPlayerId,
      toPlayerId: args.toPlayerId,
      carrot,
      stick,
      createdAt: Date.now(),
      createdByUserId: game.gmId,
    });
  },
});

/**
 * GM-only update.
 *
 * Args use the explicit-`null` convention to distinguish "leave the
 * field alone" (omit / `undefined`) from "clear this field"
 * (`null`). The handler translates `null` to a patch that sets the
 * field to `undefined` (Convex `patch` semantics).
 *
 *   - `fromPlayerId: undefined` → unchanged
 *   - `fromPlayerId: null`      → cleared
 *   - `fromPlayerId: <id>`      → set
 *
 * The same applies to `toPlayerId`, `carrot`, and `stick`.
 */
export const updateGoal = mutation({
  args: {
    goalId: v.id("goals"),
    keyword: v.optional(v.string()),
    description: v.optional(v.string()),
    type: v.optional(goalTypeValidator),
    fromPlayerId: v.optional(v.union(v.null(), v.id("players"))),
    toPlayerId: v.optional(v.union(v.null(), v.id("players"))),
    carrot: v.optional(v.union(v.null(), v.number())),
    stick: v.optional(v.union(v.null(), v.number())),
  },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goalId);
    if (!goal) throw new Error("Goal not found.");
    await assertGoalWritableByGm(ctx, goal.gameId);

    type GoalPatch = {
      keyword?: string;
      keywordLower?: string;
      description?: string;
      type?: GoalType;
      fromPlayerId?: Id<"players"> | undefined;
      toPlayerId?: Id<"players"> | undefined;
      carrot?: number | undefined;
      stick?: number | undefined;
    };
    const patch: GoalPatch = {};
    let changed = false;

    if (args.keyword !== undefined) {
      const { keyword, lower } = normaliseKeyword(args.keyword);
      if (lower !== goal.keywordLower) {
        await assertKeywordUniqueInGame(ctx, goal.gameId, lower, goal._id);
      }
      patch.keyword = keyword;
      patch.keywordLower = lower;
      changed = true;
    }
    if (args.description !== undefined) {
      patch.description = validateDescription(args.description);
      changed = true;
    }
    if (args.type !== undefined) {
      patch.type = args.type;
      changed = true;
    }
    if (args.carrot !== undefined) {
      patch.carrot =
        args.carrot === null ? undefined : validateCarrot(args.carrot);
      changed = true;
    }
    if (args.stick !== undefined) {
      patch.stick =
        args.stick === null ? undefined : validateStick(args.stick);
      changed = true;
    }

    // Resolve the post-patch player refs so we can validate them
    // together (they constrain each other: from !== to).
    let nextFrom: Id<"players"> | undefined = goal.fromPlayerId;
    let nextTo: Id<"players"> | undefined = goal.toPlayerId;
    let fromTouched = false;
    let toTouched = false;
    if (args.fromPlayerId !== undefined) {
      nextFrom = args.fromPlayerId === null ? undefined : args.fromPlayerId;
      fromTouched = true;
      changed = true;
    }
    if (args.toPlayerId !== undefined) {
      nextTo = args.toPlayerId === null ? undefined : args.toPlayerId;
      toTouched = true;
      changed = true;
    }

    if (fromTouched && nextFrom !== undefined) {
      await assertPlayerInGame(ctx, goal.gameId, nextFrom);
    }
    if (toTouched && nextTo !== undefined) {
      await assertPlayerInGame(ctx, goal.gameId, nextTo);
    }

    // Auto-clear-on-collision: the GM moved `from` onto the existing
    // `to` (and didn't simultaneously change `to`). Silently clear
    // `to` rather than reject — almost always the GM intended to
    // re-author the goal as "from this Player, no target yet".
    if (
      fromTouched &&
      !toTouched &&
      nextFrom !== undefined &&
      nextTo !== undefined &&
      nextFrom === nextTo
    ) {
      nextTo = undefined;
      toTouched = true;
    }

    // The reverse case (GM moving `to` onto the existing `from` without
    // also touching `from`) is a hard error — almost certainly the GM
    // meant to swap the two and forgot to clear `from`. Failing loudly
    // is safer than guessing.
    if (
      toTouched &&
      !fromTouched &&
      nextFrom !== undefined &&
      nextTo !== undefined &&
      nextFrom === nextTo
    ) {
      throw new Error(
        "to-player cannot equal the existing from-player. Clear or change from-player first.",
      );
    }

    // Final invariant after both have been resolved.
    if (
      nextFrom !== undefined &&
      nextTo !== undefined &&
      nextFrom === nextTo
    ) {
      throw new Error(
        "from-player and to-player must be different Players.",
      );
    }

    if (fromTouched) patch.fromPlayerId = nextFrom;
    if (toTouched) patch.toPlayerId = nextTo;

    if (!changed) return;
    await ctx.db.patch(goal._id, patch);
  },
});

/**
 * GM-driven: gives a Goal a from-player when none is set. Rejected if
 * the Goal already has a from-player (the GM must use `updateGoal`
 * instead). Rejected if the new from-player equals the existing
 * to-player.
 */
export const assignFromPlayer = mutation({
  args: {
    goalId: v.id("goals"),
    fromPlayerId: v.id("players"),
  },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goalId);
    if (!goal) throw new Error("Goal not found.");
    await assertGoalWritableByGm(ctx, goal.gameId);
    if (goal.fromPlayerId !== undefined) {
      throw new Error(
        "This Goal already has a from-player; use Edit to change it.",
      );
    }
    await assertPlayerInGame(ctx, goal.gameId, args.fromPlayerId);
    if (
      goal.toPlayerId !== undefined &&
      args.fromPlayerId === goal.toPlayerId
    ) {
      throw new Error(
        "from-player and to-player must be different Players.",
      );
    }
    await ctx.db.patch(goal._id, { fromPlayerId: args.fromPlayerId });
  },
});

/**
 * Player-driven: the current `fromPlayerId` sets `toPlayerId` exactly
 * once, while `toPlayerId === undefined` and the game is not
 * `archived`. The GM is rejected here — GM-side to-player edits go
 * through `updateGoal` (Rule 28 workflow).
 */
export const assignToPlayer = mutation({
  args: {
    goalId: v.id("goals"),
    toPlayerId: v.id("players"),
  },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goalId);
    if (!goal) throw new Error("Goal not found.");
    const game = await requireGame(ctx, goal.gameId);
    if (game.state === "archived") {
      throw new Error("Goals cannot be modified in an archived game.");
    }

    const { role, player } = await requireGameParticipant(ctx, goal.gameId);
    if (role === "gm") {
      throw new Error(
        "The GM does not assign to-player here; use Edit instead.",
      );
    }
    if (goal.fromPlayerId === undefined) {
      throw new Error(
        "This Goal has no from-player; the GM must assign one first.",
      );
    }
    if (player === null || player._id !== goal.fromPlayerId) {
      throw new Error(
        "Only the from-player can assign a to-player.",
      );
    }
    if (goal.toPlayerId !== undefined) {
      throw new Error(
        "This Goal already has a to-player; only the GM can change it.",
      );
    }

    await assertPlayerInGame(ctx, goal.gameId, args.toPlayerId);
    if (args.toPlayerId === goal.fromPlayerId) {
      throw new Error("to-player cannot be the same as from-player.");
    }

    await ctx.db.patch(goal._id, { toPlayerId: args.toPlayerId });
  },
});

/**
 * GM-only inverse to `assignToPlayer`. Idempotent if already cleared.
 */
export const clearToPlayer = mutation({
  args: { goalId: v.id("goals") },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goalId);
    if (!goal) throw new Error("Goal not found.");
    await assertGoalWritableByGm(ctx, goal.gameId);
    if (goal.toPlayerId === undefined) return;
    await ctx.db.patch(goal._id, { toPlayerId: undefined });
  },
});

/**
 * GM-only delete. No ledger work (Decision 7).
 */
export const deleteGoal = mutation({
  args: { goalId: v.id("goals") },
  handler: async (ctx, args) => {
    const goal = await ctx.db.get(args.goalId);
    if (!goal) throw new Error("Goal not found.");
    await assertGoalWritableByGm(ctx, goal.gameId);
    await ctx.db.delete(goal._id);
  },
});

// ─────────────────────────────────────────────────────────────────────────
// Query
// ─────────────────────────────────────────────────────────────────────────

export type GoalRow = {
  _id: Id<"goals">;
  keyword: string;
  type: GoalType;
  /**
   * Full text when the viewer is the GM, the current from-player, or
   * the current to-player; `null` otherwise. Identical placeholder
   * value across all redaction reasons so non-authorised viewers
   * cannot infer assignment state from the placeholder alone.
   */
  description: string | null;
  fromPlayerId: Id<"players"> | null;
  fromDisplayName: string | null;
  toPlayerId: Id<"players"> | null;
  toDisplayName: string | null;
  carrot: number | null;
  stick: number | null;
  createdAt: number;
  isFromMe: boolean;
  isToMe: boolean;
  /** GM-only: true when no `fromPlayerId` is set. */
  canAssignFromPlayer: boolean;
  /** From-player only: true when from is set and to is not. */
  canAssignToPlayer: boolean;
  canEdit: boolean;
  canDelete: boolean;
};

export type EligiblePlayer = {
  _id: Id<"players">;
  displayName: string;
};

export const listGoalsForGame = query({
  args: { gameId: v.id("games") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    goals: GoalRow[];
    gameState: "ready" | "playing" | "archived";
    eligiblePlayers: EligiblePlayer[];
  }> => {
    const { game, role, player } = await requireGameParticipant(
      ctx,
      args.gameId,
    );

    const goals = await ctx.db
      .query("goals")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .collect();
    goals.sort((a, b) => b._creationTime - a._creationTime);

    const players = await ctx.db
      .query("players")
      .withIndex("by_game", (q) => q.eq("gameId", args.gameId))
      .collect();

    const displayNameByPlayerId: Record<string, string> = {};
    for (const p of players) {
      const u = await ctx.db.get(p.userId);
      displayNameByPlayerId[p._id] =
        u?.displayName ?? u?.email ?? "Unknown";
    }

    const eligiblePlayers: EligiblePlayer[] = players
      .map((p) => ({
        _id: p._id,
        displayName: displayNameByPlayerId[p._id] ?? "Unknown",
      }))
      // Stable ordering by display name for predictable picker UX.
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const myPlayerId = player?._id ?? null;
    const isGm = role === "gm";

    return {
      gameState: game.state,
      eligiblePlayers,
      goals: goals.map((g) => {
        const isFromMe =
          myPlayerId !== null &&
          g.fromPlayerId !== undefined &&
          g.fromPlayerId === myPlayerId;
        const isToMe =
          myPlayerId !== null &&
          g.toPlayerId !== undefined &&
          g.toPlayerId === myPlayerId;
        const canSeeDescription = isGm || isFromMe || isToMe;
        const notArchived = game.state !== "archived";
        const canAssignFromPlayer =
          isGm && g.fromPlayerId === undefined && notArchived;
        const canAssignToPlayer =
          isFromMe && g.toPlayerId === undefined && notArchived;
        const canEdit = isGm && notArchived;
        const canDelete = isGm && notArchived;
        return {
          _id: g._id,
          keyword: g.keyword,
          type: g.type,
          description: canSeeDescription ? g.description : null,
          fromPlayerId: g.fromPlayerId ?? null,
          fromDisplayName:
            g.fromPlayerId !== undefined
              ? (displayNameByPlayerId[g.fromPlayerId] ?? "Unknown")
              : null,
          toPlayerId: g.toPlayerId ?? null,
          toDisplayName:
            g.toPlayerId !== undefined
              ? (displayNameByPlayerId[g.toPlayerId] ?? "Unknown")
              : null,
          carrot: g.carrot ?? null,
          stick: g.stick ?? null,
          createdAt: g.createdAt,
          isFromMe,
          isToMe,
          canAssignFromPlayer,
          canAssignToPlayer,
          canEdit,
          canDelete,
        };
      }),
    };
  },
});
