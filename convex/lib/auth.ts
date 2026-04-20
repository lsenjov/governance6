import { type MutationCtx, type QueryCtx } from "../_generated/server";
import { type Doc, type Id } from "../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";

/**
 * Authorisation helpers. Rule 24: server-side enforcement regardless of UI.
 *
 * All helpers throw plain Errors with descriptive messages on failure so the
 * client can surface them inline.
 */

export type Ctx = QueryCtx | MutationCtx;

export async function getCurrentUser(ctx: Ctx): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return null;
  return await ctx.db.get(userId);
}

export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const user = await getCurrentUser(ctx);
  if (!user) throw new Error("Not authenticated.");
  return user;
}

export async function requireUserId(ctx: Ctx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated.");
  return userId;
}

export async function requireGame(
  ctx: Ctx,
  gameId: Id<"games">,
): Promise<Doc<"games">> {
  const game = await ctx.db.get(gameId);
  if (!game) throw new Error("Game not found.");
  return game;
}

export async function requireGameGm(
  ctx: Ctx,
  gameId: Id<"games">,
): Promise<Doc<"games">> {
  const userId = await requireUserId(ctx);
  const game = await requireGame(ctx, gameId);
  if (game.gmId !== userId) {
    throw new Error("Only the Game Master can perform this action.");
  }
  return game;
}

export async function requireGamePlayer(
  ctx: Ctx,
  gameId: Id<"games">,
): Promise<{ game: Doc<"games">; player: Doc<"players"> }> {
  const userId = await requireUserId(ctx);
  const game = await requireGame(ctx, gameId);
  const player = await ctx.db
    .query("players")
    .withIndex("by_game_user", (q) =>
      q.eq("gameId", gameId).eq("userId", userId),
    )
    .unique();
  if (!player) {
    throw new Error("You are not a Player in this game.");
  }
  return { game, player };
}

export async function getOptionalGamePlayer(
  ctx: Ctx,
  gameId: Id<"games">,
  userId: Id<"users">,
): Promise<Doc<"players"> | null> {
  return await ctx.db
    .query("players")
    .withIndex("by_game_user", (q) =>
      q.eq("gameId", gameId).eq("userId", userId),
    )
    .unique();
}

/**
 * Participant-level access: GM OR Player in the game. Used by features (e.g.
 * notes) where both roles can create and view content, while non-participants
 * must be rejected server-side (rule 24).
 */
export async function requireGameParticipant(
  ctx: Ctx,
  gameId: Id<"games">,
): Promise<{
  game: Doc<"games">;
  userId: Id<"users">;
  role: "gm" | "player";
  player: Doc<"players"> | null;
}> {
  const userId = await requireUserId(ctx);
  const game = await requireGame(ctx, gameId);
  if (game.gmId === userId) {
    return { game, userId, role: "gm", player: null };
  }
  const player = await ctx.db
    .query("players")
    .withIndex("by_game_user", (q) =>
      q.eq("gameId", gameId).eq("userId", userId),
    )
    .unique();
  if (!player) {
    throw new Error("You are not a participant in this game.");
  }
  return { game, userId, role: "player", player };
}

export async function requireSyndicateOwner(
  ctx: Ctx,
  syndicateId: Id<"syndicates">,
): Promise<Doc<"syndicates">> {
  const userId = await requireUserId(ctx);
  const syndicate = await ctx.db.get(syndicateId);
  if (!syndicate) throw new Error("Syndicate not found.");
  if (syndicate.ownerId !== userId) {
    throw new Error("Only the owner can modify this Syndicate.");
  }
  return syndicate;
}

/**
 * Rule 5 + Rule 7: editable only while `played === false`.
 * Rule 6: `isShared` alone does NOT lock editing.
 */
export async function assertSyndicateEditable(
  ctx: Ctx,
  syndicateId: Id<"syndicates">,
): Promise<Doc<"syndicates">> {
  const syndicate = await requireSyndicateOwner(ctx, syndicateId);
  if (syndicate.played) {
    throw new Error(
      "This Syndicate has been played and is permanently frozen.",
    );
  }
  return syndicate;
}
