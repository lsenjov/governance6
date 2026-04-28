import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireGameGm, requireGameParticipant } from "./lib/auth";
import {
  getLatestRollSetForCall,
  projectRollSet,
  type RollSetView,
} from "./lib/rolls";

/**
 * Notes — per-game textual annotations on the game, a syndicate, or a minion.
 *
 * Design (see `plans/2026-04-20-notes-feature-v3.md`):
 *  - Notes are scoped to a single game (`gameId`) and never carry across
 *    games, even when the same syndicate/minion appears again.
 *  - Any participant (GM or Player) may author a note.
 *  - Visibility is `private` (author + GM only) or `public` (all
 *    participants). GM always sees every note.
 *  - Notes are IMMUTABLE once created — there is no `updateNote` mutation.
 *  - Only the GM of the owning game may delete a note (moderation).
 *  - Listings are ordered newest-first (`createdAt` descending).
 */

const BODY_MIN = 1;
const BODY_MAX = 2000;

function validateBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length < BODY_MIN) {
    throw new Error("Note body must not be empty.");
  }
  if (trimmed.length > BODY_MAX) {
    throw new Error(`Note body must be at most ${BODY_MAX} characters.`);
  }
  return trimmed;
}

/**
 * Visibility helper. Single source of truth for "can `viewer` see `note`?":
 *  - author always sees their own note,
 *  - GM (of the note's game) sees every note,
 *  - otherwise only `public` notes are visible.
 */
export function canViewNote(
  note: Doc<"notes">,
  viewer: { userId: Id<"users">; role: "gm" | "player" },
): boolean {
  if (viewer.role === "gm") return true;
  if (note.authorUserId === viewer.userId) return true;
  return note.visibility === "public";
}

export const createNote = mutation({
  args: {
    gameId: v.id("games"),
    targetKind: v.union(
      v.literal("game"),
      v.literal("syndicate"),
      v.literal("minion"),
    ),
    targetSyndicateId: v.optional(v.id("syndicates")),
    targetMinionId: v.optional(v.id("minions")),
    body: v.string(),
    visibility: v.optional(v.union(v.literal("private"), v.literal("public"))),
  },
  handler: async (ctx, args) => {
    const { game, userId, role, player } = await requireGameParticipant(
      ctx,
      args.gameId,
    );

    // Target consistency — exactly the right id(s) must be supplied.
    if (args.targetKind === "game") {
      if (
        args.targetSyndicateId !== undefined ||
        args.targetMinionId !== undefined
      ) {
        throw new Error(
          "Game-kind notes must not include a syndicate or minion id.",
        );
      }
    } else if (args.targetKind === "syndicate") {
      if (!args.targetSyndicateId || args.targetMinionId !== undefined) {
        throw new Error(
          "Syndicate-kind notes require targetSyndicateId and no targetMinionId.",
        );
      }
    } else {
      if (!args.targetMinionId || args.targetSyndicateId !== undefined) {
        throw new Error(
          "Minion-kind notes require targetMinionId and no targetSyndicateId.",
        );
      }
    }

    // Target existence + in-game relevance.
    if (args.targetKind === "syndicate") {
      const syndicate = await ctx.db.get(args.targetSyndicateId!);
      if (!syndicate) throw new Error("Syndicate not found.");
      await assertSyndicateVisibleInGame(ctx, {
        gameId: args.gameId,
        syndicateId: syndicate._id,
        viewerUserId: userId,
        viewerRole: role,
        viewerPlayer: player,
      });
    } else if (args.targetKind === "minion") {
      const minion = await ctx.db.get(args.targetMinionId!);
      if (!minion) throw new Error("Minion not found.");
      await assertSyndicateVisibleInGame(ctx, {
        gameId: args.gameId,
        syndicateId: minion.syndicateId,
        viewerUserId: userId,
        viewerRole: role,
        viewerPlayer: player,
      });
    }
    // `game`-kind: `game` has already been validated by requireGameParticipant.

    const body = validateBody(args.body);
    const visibility = args.visibility ?? "private";

    // Dice rolls (plans/2026-04-28-dice-rolls-v3.md): if this note
    // targets a Minion that is currently the head of the call queue,
    // freeze the live roll set onto the note. The roll-set id is
    // persisted regardless of author role; the GM-only filter in
    // `listNotesForTarget` keeps it out of Player payloads.
    let attachedRollSetId: Id<"callRollSets"> | undefined;
    if (args.targetKind === "minion" && args.targetMinionId) {
      const head = await ctx.db
        .query("calls")
        .withIndex("by_game_active_time", (q) =>
          q.eq("gameId", args.gameId).eq("isActive", true),
        )
        .order("asc")
        .take(1);
      if (head.length > 0 && head[0].minionId === args.targetMinionId) {
        const rollRow = await getLatestRollSetForCall(ctx, head[0]._id);
        if (rollRow) {
          attachedRollSetId = rollRow._id;
        }
      }
    }

    return await ctx.db.insert("notes", {
      gameId: game._id,
      targetKind: args.targetKind,
      targetSyndicateId: args.targetSyndicateId,
      targetMinionId: args.targetMinionId,
      authorUserId: userId,
      visibility,
      body,
      createdAt: Date.now(),
      ...(attachedRollSetId !== undefined ? { attachedRollSetId } : {}),
    });
  },
});

/**
 * GM-only deletion. Authors CANNOT delete their own notes.
 */
export const deleteNote = mutation({
  args: { noteId: v.id("notes") },
  handler: async (ctx, args) => {
    const note = await ctx.db.get(args.noteId);
    if (!note) throw new Error("Note not found.");
    // Throws unless the caller is the GM of the note's game.
    await requireGameGm(ctx, note.gameId);
    await ctx.db.delete(args.noteId);
  },
});

type NoteListItem = {
  _id: Id<"notes">;
  createdAt: number;
  body: string;
  visibility: "private" | "public";
  authorUserId: Id<"users">;
  authorDisplayName: string;
  isMine: boolean;
  canDelete: boolean;
  // Dice rolls v1: present (and possibly null) only on GM payloads.
  // For non-GM viewers the key is omitted entirely so the wire format
  // never leaks the existence of attached rolls.
  attachedRolls?: RollSetView | null;
};

export const listNotesForTarget = query({
  args: {
    gameId: v.id("games"),
    targetKind: v.union(
      v.literal("game"),
      v.literal("syndicate"),
      v.literal("minion"),
    ),
    targetSyndicateId: v.optional(v.id("syndicates")),
    targetMinionId: v.optional(v.id("minions")),
  },
  handler: async (ctx, args): Promise<NoteListItem[]> => {
    const { userId, role } = await requireGameParticipant(ctx, args.gameId);

    let rows: Doc<"notes">[];
    if (args.targetKind === "game") {
      rows = await ctx.db
        .query("notes")
        .withIndex("by_game_kind_created", (q) =>
          q.eq("gameId", args.gameId).eq("targetKind", "game"),
        )
        .order("desc")
        .collect();
    } else if (args.targetKind === "syndicate") {
      if (!args.targetSyndicateId) {
        throw new Error("targetSyndicateId is required for syndicate notes.");
      }
      rows = await ctx.db
        .query("notes")
        .withIndex("by_game_syndicate_created", (q) =>
          q
            .eq("gameId", args.gameId)
            .eq("targetSyndicateId", args.targetSyndicateId!),
        )
        .order("desc")
        .collect();
    } else {
      if (!args.targetMinionId) {
        throw new Error("targetMinionId is required for minion notes.");
      }
      rows = await ctx.db
        .query("notes")
        .withIndex("by_game_minion_created", (q) =>
          q
            .eq("gameId", args.gameId)
            .eq("targetMinionId", args.targetMinionId!),
        )
        .order("desc")
        .collect();
    }

    const visible = rows.filter((n) => canViewNote(n, { userId, role }));

    // Decorate with author display name.
    const authorIds = Array.from(new Set(visible.map((n) => n.authorUserId)));
    const authorNames: Record<string, string> = {};
    for (const aid of authorIds) {
      const u = await ctx.db.get(aid);
      authorNames[aid] = u?.displayName ?? u?.email ?? "Unknown";
    }

    const canDelete = role === "gm";

    // Dice rolls v1: GM viewers get `attachedRolls` joined from each
    // note's `attachedRollSetId`. Non-GMs never see the key (and the
    // raw `attachedRollSetId` is also stripped). Bulk-load roll-set
    // rows in one query to keep reads bounded.
    let rollsByNoteId: Map<string, RollSetView | null> | null = null;
    if (role === "gm") {
      rollsByNoteId = new Map();
      const rollSetIds = visible
        .map((n) => n.attachedRollSetId)
        .filter((id): id is Id<"callRollSets"> => id !== undefined);
      // De-dupe (multiple notes may pin the same roll set).
      const uniqueIds = Array.from(new Set(rollSetIds.map((id) => id as string)));
      const idToRow = new Map<string, RollSetView>();
      for (const idStr of uniqueIds) {
        const row = await ctx.db.get(idStr as Id<"callRollSets">);
        if (row) {
          idToRow.set(idStr, projectRollSet(row));
        }
      }
      for (const n of visible) {
        if (n.attachedRollSetId) {
          rollsByNoteId.set(
            n._id as string,
            idToRow.get(n.attachedRollSetId as string) ?? null,
          );
        }
      }
    }

    return visible.map((n) => {
      const base: NoteListItem = {
        _id: n._id,
        createdAt: n.createdAt,
        body: n.body,
        visibility: n.visibility,
        authorUserId: n.authorUserId,
        authorDisplayName: authorNames[n.authorUserId] ?? "Unknown",
        isMine: n.authorUserId === userId,
        canDelete,
      };
      if (role === "gm" && rollsByNoteId) {
        // Only attach the key when this note has an `attachedRollSetId`
        // — keeps the GM payload tight and avoids an explicit `null`
        // for every game/syndicate-target note that never had rolls.
        if (n.attachedRollSetId) {
          base.attachedRolls = rollsByNoteId.get(n._id as string) ?? null;
        }
      }
      return base;
    });
  },
});

/**
 * Counts summary for badges on the game detail page. Returns the total
 * visible-note count per target the viewer can currently see, grouped by
 * target kind. A single subscription replaces one per-icon subscription.
 */
export const getNoteCountsForGameView = query({
  args: { gameId: v.id("games") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    gameNotes: number;
    bySyndicate: Record<string, number>;
    byMinion: Record<string, number>;
  }> => {
    // Non-participants are rejected. Result is only meaningful inside the
    // game detail page, which already requires participation.
    const { userId, role } = await requireGameParticipant(ctx, args.gameId);

    // One bulk read: every note for this game. `notes` is per-game so the
    // working set stays small.
    const allGameNotes = await ctx.db
      .query("notes")
      .withIndex("by_game_kind_created", (q) => q.eq("gameId", args.gameId))
      .collect();

    let gameNotes = 0;
    const bySyndicate: Record<string, number> = {};
    const byMinion: Record<string, number> = {};
    for (const n of allGameNotes) {
      if (!canViewNote(n, { userId, role })) continue;
      if (n.targetKind === "game") {
        gameNotes += 1;
      } else if (n.targetKind === "syndicate" && n.targetSyndicateId) {
        bySyndicate[n.targetSyndicateId] =
          (bySyndicate[n.targetSyndicateId] ?? 0) + 1;
      } else if (n.targetKind === "minion" && n.targetMinionId) {
        byMinion[n.targetMinionId] = (byMinion[n.targetMinionId] ?? 0) + 1;
      }
    }
    return { gameNotes, bySyndicate, byMinion };
  },
});

/**
 * Shared helper: a syndicate is a legal note target in this game iff it
 *   (a) is currently selected by any Player in this game, OR
 *   (b) is owned by the viewer OR has `isShared=true` (so the viewer can
 *       see it in the rest of the app anyway).
 * Rule 24: enforced server-side regardless of UI state.
 */
async function assertSyndicateVisibleInGame(
  ctx: QueryCtx | MutationCtx,
  params: {
    gameId: Id<"games">;
    syndicateId: Id<"syndicates">;
    viewerUserId: Id<"users">;
    viewerRole: "gm" | "player";
    viewerPlayer: Doc<"players"> | null;
  },
): Promise<void> {
  const syndicate = await ctx.db.get(params.syndicateId);
  if (!syndicate) throw new Error("Syndicate not found.");

  // GM of this game has unrestricted access within their own game.
  if (params.viewerRole === "gm") return;

  // (b) direct accessibility (owned or shared).
  if (syndicate.ownerId === params.viewerUserId || syndicate.isShared) {
    return;
  }

  // (a) selected by any Player in this game.
  const selectors = await ctx.db
    .query("players")
    .withIndex("by_selected_syndicate", (q) =>
      q.eq("selectedSyndicateId", params.syndicateId),
    )
    .collect();
  if (selectors.some((p) => p.gameId === params.gameId)) {
    return;
  }

  throw new Error("That target is not accessible in this game.");
}
