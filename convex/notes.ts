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
import { MAX_ANNOUNCEMENT_NOTES } from "./lib/announcements";
import { assertNoteHasNoReplies } from "./lib/notes";

/**
 * Notes — per-game textual annotations on the game, a syndicate, a
 * minion, a treason grant, a goal, an announcement, or another note.
 *
 * Design (see `plans/2026-04-20-notes-feature-v3.md` and
 * `plans/2026-05-17-notes-on-grants-and-goals-v1.md`):
 *  - Notes are scoped to a single game (`gameId`) and never carry across
 *    games, even when the same syndicate/minion/grant/goal appears again.
 *  - Any participant (GM or Player) may author a note.
 *  - Visibility is `private` (author + GM only) or `public` (all
 *    participants). GM always sees every note.
 *  - Note body visibility is independent of the parent row's description
 *    redaction rules. A `public` note on a grant or goal whose
 *    description is redacted for the viewer is still fully readable —
 *    the note is the author's own annotation, not a re-publication of
 *    the entity body.
 *  - Notes are AUTHOR-IMMUTABLE once created — there is no
 *    `updateNote` mutation. Body, visibility, target, author, and
 *    attachedRollSetId are frozen for the lifetime of the row. The
 *    SOLE EXCEPTION is the optional `timer` sub-object, which the GM
 *    may cycle via `cycleNoteTimer` (see Note Timers below). No other
 *    field of an existing row is ever mutated by any code path.
 *  - Only the GM of the owning game may delete a note (moderation).
 *  - Listings are ordered newest-first (`createdAt` descending).
 *
 * Note Timers (plans/2026-04-28-2026-04-28-note-timers-v1.md, with
 * scope broadened by plans/2026-04-28-gm-todo-drawer-v1.md Task 0b):
 * the `timer` sub-object is the SOLE post-creation-mutable field. It
 * is GM-authored at create time and GM-cycled via `cycleNoteTimer`.
 * Wire format is GM-only — the field is stripped from non-GM payloads
 * next to `attachedRollSetId`. The GM may attach a timer to ANY note
 * kind they author (game / syndicate / minion target, head call or
 * not); when the note pins a live skill check the timer accompanies
 * the pinned roll set, otherwise the timer stands alone.
 *
 * Notes drawer (plans/2026-04-28-gm-todo-drawer-v1.md): the
 * `listGameTimerNotes` query is the GM-only aggregation of
 * timer-bearing notes. Like `attachedRollSetId` and `timer`,
 * the projected payload never reaches Player sessions — the handler
 * gates on `requireGameGm` before reading any rows.
 */

const BODY_MIN = 1;
const BODY_MAX = 2000;
const ANNOUNCEMENT_EXCERPT_MAX = 80;
const NOTE_EXCERPT_MAX = 80;

/**
 * Allowed durations for the GM-only note timer (in minutes). Single
 * source of truth — both the server validator (Task 3) and the client
 * button row (Task 11) read this list. Changing the array changes the
 * UI without further coordination.
 */
export const TIMER_PRESET_MINUTES = [2, 5, 10, 15, 30] as const;
export type TimerPresetMinutes = (typeof TIMER_PRESET_MINUTES)[number];

/**
 * Wire-format shape of `notes.timer`. Mirrored as a TypeScript type so
 * the client can import it from `convex/notes` instead of redefining.
 */
export type NoteTimer =
  | { kind: "ticking"; dueAt: number }
  | { kind: "done" }
  | { kind: "due_manual" };

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

export function excerptAnnouncement(body: string): string {
  if (body.length <= ANNOUNCEMENT_EXCERPT_MAX) return body;
  return `${body.slice(0, ANNOUNCEMENT_EXCERPT_MAX).trimEnd()}…`;
}

function excerptNote(body: string): string {
  if (body.length <= NOTE_EXCERPT_MAX) return body;
  return `${body.slice(0, NOTE_EXCERPT_MAX).trimEnd()}…`;
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
      v.literal("grant"),
      v.literal("goal"),
      v.literal("announcement"),
      v.literal("note"),
    ),
    targetSyndicateId: v.optional(v.id("syndicates")),
    targetMinionId: v.optional(v.id("minions")),
    targetGrantId: v.optional(v.id("treasonGrants")),
    targetGoalId: v.optional(v.id("goals")),
    targetAnnouncementId: v.optional(v.id("announcements")),
    targetNoteId: v.optional(v.id("notes")),
    body: v.string(),
    visibility: v.optional(v.union(v.literal("private"), v.literal("public"))),
    // Note Timers (broadened by GM Todo Drawer v1, Task 0b): GM-only.
    // The minute value must be one of `TIMER_PRESET_MINUTES`. The
    // resulting note's target is unconstrained — a timer may stand
    // alone on a game- or syndicate-target note as well as ride
    // alongside a pinned roll set on a minion-target head-call note.
    // Server-side enforced regardless of UI gating.
    timerMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { game, userId, role, player } = await requireGameParticipant(
      ctx,
      args.gameId,
    );
    assertNoteTargetVisibleInState(args.targetKind, game.state, role);

    // Target consistency — exactly the right id(s) must be supplied.
    if (args.targetKind === "game") {
      if (
        args.targetSyndicateId !== undefined ||
        args.targetMinionId !== undefined ||
        args.targetGrantId !== undefined ||
        args.targetGoalId !== undefined ||
        args.targetAnnouncementId !== undefined ||
        args.targetNoteId !== undefined
      ) {
        throw new Error("Game-kind notes must not include another target id.");
      }
    } else if (args.targetKind === "syndicate") {
      if (
        !args.targetSyndicateId ||
        args.targetMinionId !== undefined ||
        args.targetGrantId !== undefined ||
        args.targetGoalId !== undefined ||
        args.targetAnnouncementId !== undefined ||
        args.targetNoteId !== undefined
      ) {
        throw new Error(
          "Syndicate-kind notes require targetSyndicateId and no other target id.",
        );
      }
    } else if (args.targetKind === "minion") {
      if (
        !args.targetMinionId ||
        args.targetSyndicateId !== undefined ||
        args.targetGrantId !== undefined ||
        args.targetGoalId !== undefined ||
        args.targetAnnouncementId !== undefined ||
        args.targetNoteId !== undefined
      ) {
        throw new Error(
          "Minion-kind notes require targetMinionId and no other target id.",
        );
      }
    } else if (args.targetKind === "grant") {
      if (
        !args.targetGrantId ||
        args.targetSyndicateId !== undefined ||
        args.targetMinionId !== undefined ||
        args.targetGoalId !== undefined ||
        args.targetAnnouncementId !== undefined ||
        args.targetNoteId !== undefined
      ) {
        throw new Error(
          "Grant-kind notes require targetGrantId and no other target id.",
        );
      }
    } else if (args.targetKind === "goal") {
      if (
        !args.targetGoalId ||
        args.targetSyndicateId !== undefined ||
        args.targetMinionId !== undefined ||
        args.targetGrantId !== undefined ||
        args.targetAnnouncementId !== undefined ||
        args.targetNoteId !== undefined
      ) {
        throw new Error(
          "Goal-kind notes require targetGoalId and no other target id.",
        );
      }
    } else if (args.targetKind === "announcement") {
      if (
        !args.targetAnnouncementId ||
        args.targetSyndicateId !== undefined ||
        args.targetMinionId !== undefined ||
        args.targetGrantId !== undefined ||
        args.targetGoalId !== undefined ||
        args.targetNoteId !== undefined
      ) {
        throw new Error(
          "Announcement-kind notes require targetAnnouncementId and no other target id.",
        );
      }
    } else if (
      !args.targetNoteId ||
      args.targetSyndicateId !== undefined ||
      args.targetMinionId !== undefined ||
      args.targetGrantId !== undefined ||
      args.targetGoalId !== undefined ||
      args.targetAnnouncementId !== undefined
    ) {
      throw new Error(
        "Note-kind notes require targetNoteId and no other target id.",
      );
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
    } else if (args.targetKind === "grant") {
      const grant = await ctx.db.get(args.targetGrantId!);
      if (!grant) throw new Error("Treason Grant not found.");
      if (grant.gameId !== args.gameId) {
        throw new Error("That Grant is not in this game.");
      }
    } else if (args.targetKind === "goal") {
      const goal = await ctx.db.get(args.targetGoalId!);
      if (!goal) throw new Error("Goal not found.");
      if (goal.gameId !== args.gameId) {
        throw new Error("That Goal is not in this game.");
      }
    } else if (args.targetKind === "announcement") {
      const announcement = await ctx.db.get(args.targetAnnouncementId!);
      if (!announcement) throw new Error("Announcement not found.");
      if (announcement.gameId !== args.gameId) {
        throw new Error("That Announcement is not in this game.");
      }
      const existingNotes = await ctx.db
        .query("notes")
        .withIndex("by_game_announcement_created", (q) =>
          q
            .eq("gameId", args.gameId)
            .eq("targetAnnouncementId", announcement._id),
        )
        .take(MAX_ANNOUNCEMENT_NOTES);
      if (existingNotes.length >= MAX_ANNOUNCEMENT_NOTES) {
        throw new Error(
          `An announcement may have at most ${MAX_ANNOUNCEMENT_NOTES} notes.`,
        );
      }
    } else if (args.targetKind === "note") {
      const targetNote = await ctx.db.get(args.targetNoteId!);
      if (!targetNote || targetNote.gameId !== args.gameId) {
        throw new Error("Target note not found or is not visible.");
      }
      await assertNoteAndAncestorsVisible(ctx, targetNote, {
        userId,
        role,
        gameState: game.state,
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

    // Note timers: validate `timerMinutes` BEFORE the insert.
    // Two layered checks (Rule 24 — server-side authoritative):
    //   1. Caller is the GM of this game. Players are rejected even
    //      if they somehow forge the arg client-side.
    //   2. The minute value is in the preset list. Anything else
    //      (negative, zero, fractional, novel int) is rejected so the
    //      server can never carry an unsanctioned duration.
    //
    // The GM may attach a timer to any note they author. When the
    // note pins a live skill check (minion-target on the head call,
    // resolved above) the timer accompanies the pinned roll set; on
    // game- or syndicate-target notes (and on minion-target notes
    // whose minion was not the head call at create time) the timer
    // stands alone. The GM Todo drawer projects all such rows
    // uniformly. See `plans/2026-04-28-gm-todo-drawer-v1.md` Task 0b
    // for the rationale of relaxing the original "timer ⇒ pinned roll
    // set" invariant.
    let timer: NoteTimer | undefined;
    if (args.timerMinutes !== undefined) {
      if (role !== "gm") {
        throw new Error("Only the GM may post a note with a timer.");
      }
      if (
        !(TIMER_PRESET_MINUTES as readonly number[]).includes(args.timerMinutes)
      ) {
        throw new Error(
          `Timer duration must be one of ${TIMER_PRESET_MINUTES.join(", ")} minutes.`,
        );
      }
      timer = {
        kind: "ticking",
        dueAt: Date.now() + args.timerMinutes * 60_000,
      };
    }

    return await ctx.db.insert("notes", {
      gameId: game._id,
      targetKind: args.targetKind,
      targetSyndicateId: args.targetSyndicateId,
      targetMinionId: args.targetMinionId,
      ...(args.targetGrantId !== undefined
        ? { targetGrantId: args.targetGrantId }
        : {}),
      ...(args.targetGoalId !== undefined
        ? { targetGoalId: args.targetGoalId }
        : {}),
      ...(args.targetAnnouncementId !== undefined
        ? { targetAnnouncementId: args.targetAnnouncementId }
        : {}),
      ...(args.targetNoteId !== undefined
        ? { targetNoteId: args.targetNoteId }
        : {}),
      authorUserId: userId,
      visibility,
      body,
      createdAt: Date.now(),
      ...(attachedRollSetId !== undefined ? { attachedRollSetId } : {}),
      ...(timer !== undefined ? { timer } : {}),
    });
  },
});

/**
 * GM-only timer cycle for an existing note.
 *
 * State machine (see plan):
 *   - `ticking` → `done`
 *   - `done`     → `due_manual`
 *   - `due_manual` → `done`
 *
 * `ticking` is intentionally unreachable post-creation; once the GM
 * leaves it the original countdown is gone for good. This prevents a
 * client (buggy or hostile) from forging a forward-running timer with
 * a fabricated `dueAt`. The mutation accepts only `noteId` — the next
 * state is derived server-side from the current state.
 *
 * Throws if the note has no timer (nothing to cycle), or if the
 * caller is not the GM of the note's game.
 */
export const cycleNoteTimer = mutation({
  args: { noteId: v.id("notes") },
  handler: async (ctx, args) => {
    const note = await ctx.db.get(args.noteId);
    if (!note) throw new Error("Note not found.");
    // GM-only — Rule 24, enforced regardless of UI.
    await requireGameGm(ctx, note.gameId);
    if (!note.timer) {
      throw new Error("This note has no timer to cycle.");
    }
    let next: NoteTimer;
    switch (note.timer.kind) {
      case "ticking":
        next = { kind: "done" };
        break;
      case "done":
        next = { kind: "due_manual" };
        break;
      case "due_manual":
        next = { kind: "done" };
        break;
    }
    await ctx.db.patch(args.noteId, { timer: next });
  },
});

/**
 * GM-only context query for the note-create form. Returns the two
 * booleans the form needs to decide whether to show the timer
 * duration buttons:
 *   - `viewerIsGm`: caller is the GM of `gameId`.
 *   - `timerEligible`: a note created NOW with this target would attach
 *     a timer control (a note reply, or a minion target that is the current
 *     head and can pin a roll set).
 *
 * Returning two flags from one query keeps the form's render branches
 * stable (no race where one flag flips before the other) and avoids
 * sprinkling `requireGameParticipant` calls across the UI.
 *
 * Non-participants are rejected, matching every other note query.
 * For non-minion targets the head check is short-circuited to false.
 */
export const getTimerCreateContext = query({
  args: {
    gameId: v.id("games"),
    targetKind: v.union(
      v.literal("game"),
      v.literal("syndicate"),
      v.literal("minion"),
      v.literal("grant"),
      v.literal("goal"),
      v.literal("announcement"),
      v.literal("note"),
    ),
    targetMinionId: v.optional(v.id("minions")),
    targetGrantId: v.optional(v.id("treasonGrants")),
    targetGoalId: v.optional(v.id("goals")),
    targetAnnouncementId: v.optional(v.id("announcements")),
    targetNoteId: v.optional(v.id("notes")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ viewerIsGm: boolean; timerEligible: boolean }> => {
    const { role } = await requireGameParticipant(ctx, args.gameId);
    const viewerIsGm = role === "gm";
    if (!viewerIsGm) {
      return { viewerIsGm, timerEligible: false };
    }
    if (args.targetKind === "note") {
      return { viewerIsGm, timerEligible: true };
    }
    if (args.targetKind !== "minion" || !args.targetMinionId) {
      return { viewerIsGm, timerEligible: false };
    }
    const head = await ctx.db
      .query("calls")
      .withIndex("by_game_active_time", (q) =>
        q.eq("gameId", args.gameId).eq("isActive", true),
      )
      .order("asc")
      .take(1);
    const timerEligible =
      head.length > 0 && head[0].minionId === args.targetMinionId;
    return { viewerIsGm, timerEligible };
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
    await assertNoteHasNoReplies(ctx, note);
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
  // Note timers v1: GM-only, present only when the note has a timer.
  // Stripped from non-GM payloads next to `attachedRolls`. Players
  // never see the field at all (key absent, not `null`).
  timer?: NoteTimer;
};

/**
 * Projected row shape for `listGameTimerNotes`. One row per
 * timer-bearing note in the game, denormalised with the joined entity
 * names so the drawer can render a `Player • Syndicate • Minion`
 * context line without further client-side queries.
 *
 *  - `timer` is always present (the query post-filters
 *    `n.timer !== undefined`).
 *  - `attachedRolls` follows the same omit-when-absent rule as
 *    `NoteListItem`: the KEY IS OMITTED when the note has no
 *    `attachedRollSetId`. After Task 0b that includes every
 *    game-target and syndicate-target timer-bearing note plus
 *    minion-target rows whose minion was not the head call at create
 *    time. The `null` value is reserved for the rare case where the
 *    pinned roll set was deleted out from under the note.
 *  - `playerId` / `playerDisplayName` are present only when a Player
 *    in this game has selected the relevant syndicate. Task 0d's
 *    mutation-level invariant means production data has at most one
 *    such Player per `(gameId, syndicateId)`; for resilience against
 *    test fixtures that bypass `selectSyndicate` by direct insert,
 *    the projection picks the matching Player with the lowest
 *    `joinedAt`, ties broken by `_id` ascending.
 *  - `minionName` / `syndicateName` are denormalised at the server so
 *    the drawer renders without per-row joins.
 *
 * Naming chosen for parallelism with `NoteListItem` / `GameNoteRow`.
 */
export type TimerNoteRow = {
  _id: Id<"notes">;
  createdAt: number;
  body: string;
  visibility: "private" | "public";
  authorUserId: Id<"users">;
  authorDisplayName: string;
  timer: NoteTimer;
  attachedRolls?: RollSetView | null;
  targetKind:
    | "game"
    | "syndicate"
    | "minion"
    | "grant"
    | "goal"
    | "announcement"
    | "note";
  targetSyndicateId?: Id<"syndicates">;
  targetMinionId?: Id<"minions">;
  targetGrantId?: Id<"treasonGrants">;
  targetGoalId?: Id<"goals">;
  targetAnnouncementId?: Id<"announcements">;
  targetNoteId?: Id<"notes">;
  minionName?: string;
  syndicateName?: string;
  grantKeyword?: string;
  goalKeyword?: string;
  announcementExcerpt?: string;
  parentNoteExcerpt?: string;
  parentNoteAuthorDisplayName?: string;
  replyCount: number;
  playerId?: Id<"players">;
  playerDisplayName?: string;
};

/**
 * Notes drawer row — superset of `TimerNoteRow` with an OPTIONAL
 * `timer` (the drawer lists every visible note, not just
 * timer-bearing ones). GM-only fields (`timer`, `attachedRolls`) are
 * present only on GM payloads; Players receive the row without them.
 */
export type GameNoteRow = Omit<TimerNoteRow, "timer"> & {
  timer?: NoteTimer;
};

/**
 * Shared denormalisation for the Notes drawer + GM Todo aggregation.
 * Resolves the joined entity names (minion / syndicate / selecting
 * player / grant / goal / author) for a PRE-FILTERED list of notes and
 * projects them newest-first.
 *
 * GM-only fields (`timer`, `attachedRolls`) are included only when
 * `opts.includeGmFields` is true — callers pass the viewer's GM status
 * so non-GM payloads never leak the clock or pinned rolls.
 *
 * Sort order: `createdAt` descending (newest-first), time-INDEPENDENT —
 * `createdAt` is frozen at insert time so order is stable until a note
 * is created or deleted. Read amplification: bulk-resolved with
 * deduplicated per-id reads (Convex has no `getMany`).
 */
async function projectNoteRows(
  ctx: QueryCtx,
  notes: Doc<"notes">[],
  opts: {
    gameId: Id<"games">;
    includeGmFields: boolean;
    replyCountByNoteId: Map<string, number>;
  },
): Promise<GameNoteRow[]> {
  const timerNotes = notes;

  // ── Bulk-resolve auxiliaries with deduplicated per-id reads ───
  // Pattern: collect distinct ids, fetch once each, build a Map for
  // O(1) lookup during projection. Mirrors the existing roll-set
  // join in `listNotesForTarget`.

  // Minions (only minion-target rows reference `targetMinionId`).
  const minionIds = Array.from(
    new Set(
      timerNotes
        .map((n) => n.targetMinionId)
        .filter((id): id is Id<"minions"> => id !== undefined),
    ),
  );
  const minionById = new Map<string, Doc<"minions">>();
  for (const id of minionIds) {
    const row = await ctx.db.get(id);
    if (row) minionById.set(row._id as string, row);
  }

  // Treason grants (only grant-target rows reference `targetGrantId`).
  const grantIds = Array.from(
    new Set(
      timerNotes
        .map((n) => n.targetGrantId)
        .filter((id): id is Id<"treasonGrants"> => id !== undefined),
    ),
  );
  const grantById = new Map<string, Doc<"treasonGrants">>();
  for (const id of grantIds) {
    const row = await ctx.db.get(id);
    if (row) grantById.set(row._id as string, row);
  }

  // Goals (only goal-target rows reference `targetGoalId`).
  const goalIds = Array.from(
    new Set(
      timerNotes
        .map((n) => n.targetGoalId)
        .filter((id): id is Id<"goals"> => id !== undefined),
    ),
  );
  const goalById = new Map<string, Doc<"goals">>();
  for (const id of goalIds) {
    const row = await ctx.db.get(id);
    if (row) goalById.set(row._id as string, row);
  }

  const announcementIds = Array.from(
    new Set(
      timerNotes
        .map((n) => n.targetAnnouncementId)
        .filter((id): id is Id<"announcements"> => id !== undefined),
    ),
  );
  const announcementById = new Map<string, Doc<"announcements">>();
  for (const id of announcementIds) {
    const row = await ctx.db.get(id);
    if (row) announcementById.set(row._id as string, row);
  }

  const parentNoteIds = Array.from(
    new Set(
      timerNotes
        .map((n) => n.targetNoteId)
        .filter((id): id is Id<"notes"> => id !== undefined),
    ),
  );
  const parentNoteById = new Map<string, Doc<"notes">>();
  for (const id of parentNoteIds) {
    const row = await ctx.db.get(id);
    if (row) parentNoteById.set(row._id as string, row);
  }

  // Syndicates: union of `targetSyndicateId` (syndicate-target
  // rows) and the loaded minions' `syndicateId` (minion-target
  // rows project the parent syndicate too).
  const syndicateIdSet = new Set<string>();
  for (const n of timerNotes) {
    if (n.targetSyndicateId) syndicateIdSet.add(n.targetSyndicateId as string);
  }
  for (const m of minionById.values()) {
    syndicateIdSet.add(m.syndicateId as string);
  }
  const syndicateById = new Map<string, Doc<"syndicates">>();
  for (const idStr of syndicateIdSet) {
    const row = await ctx.db.get(idStr as Id<"syndicates">);
    if (row) syndicateById.set(idStr, row);
  }

  // Selecting players per syndicate, restricted to this game. Walk
  // the `by_selected_syndicate` index for each distinct syndicate
  // id, in-memory filter to `p.gameId === args.gameId`, then pick
  // the deterministic match (lowest `joinedAt`, ties by `_id`
  // ascending). Task 0d makes this a single hit in production data
  // created via `selectSyndicate`; the tiebreaker is for resilience
  // against test fixtures that bypass the mutation.
  const playerBySyndicateId = new Map<string, Doc<"players">>();
  for (const idStr of syndicateIdSet) {
    const candidates = await ctx.db
      .query("players")
      .withIndex("by_selected_syndicate", (q) =>
        q.eq("selectedSyndicateId", idStr as Id<"syndicates">),
      )
      .collect();
    const inGame = candidates.filter((p) => p.gameId === opts.gameId);
    if (inGame.length === 0) continue;
    inGame.sort((a, b) => {
      if (a.joinedAt !== b.joinedAt) return a.joinedAt - b.joinedAt;
      return (a._id as string).localeCompare(b._id as string);
    });
    playerBySyndicateId.set(idStr, inGame[0]);
  }

  // Players: in addition to syndicate-derived players above, grant
  // rows carry an optional `ownerPlayerId` and goal rows carry an
  // optional `fromPlayerId`. Collect those for direct lookup.
  const playerIdSet = new Set<string>();
  for (const g of grantById.values()) {
    if (g.ownerPlayerId) playerIdSet.add(g.ownerPlayerId as string);
  }
  for (const g of goalById.values()) {
    if (g.fromPlayerId) playerIdSet.add(g.fromPlayerId as string);
  }
  const playerById = new Map<string, Doc<"players">>();
  for (const idStr of playerIdSet) {
    const row = await ctx.db.get(idStr as Id<"players">);
    if (row) playerById.set(idStr, row);
  }

  // Users: union of every author user id and every selecting
  // player's user id. One bulk pass.
  const userIdSet = new Set<string>();
  for (const n of timerNotes) userIdSet.add(n.authorUserId as string);
  for (const n of parentNoteById.values()) {
    userIdSet.add(n.authorUserId as string);
  }
  for (const p of playerBySyndicateId.values()) {
    userIdSet.add(p.userId as string);
  }
  for (const p of playerById.values()) {
    userIdSet.add(p.userId as string);
  }
  const userById = new Map<string, Doc<"users">>();
  for (const idStr of userIdSet) {
    const row = await ctx.db.get(idStr as Id<"users">);
    if (row) userById.set(idStr, row);
  }

  // Roll sets: deduplicate `attachedRollSetId`s and project once.
  // Mirrors the existing GM-only decoration in `listNotesForTarget`.
  const rollSetIds = Array.from(
    new Set(
      timerNotes
        .map((n) => n.attachedRollSetId)
        .filter((id): id is Id<"callRollSets"> => id !== undefined)
        .map((id) => id as string),
    ),
  );
  const rollSetById = new Map<string, RollSetView>();
  for (const idStr of rollSetIds) {
    const row = await ctx.db.get(idStr as Id<"callRollSets">);
    if (row) rollSetById.set(idStr, projectRollSet(row));
  }

  // ── Project rows ───────────────────────────────────────────
  function userDisplay(userId: Id<"users">): string {
    const u = userById.get(userId as string);
    return u?.displayName ?? u?.email ?? "Unknown";
  }

  const projected: GameNoteRow[] = timerNotes.map((n) => {
    // Resolve the joined syndicate id for this row: direct on
    // syndicate-target, parent on minion-target, undefined on
    // game-target.
    const syndId: Id<"syndicates"> | undefined =
      n.targetKind === "syndicate"
        ? n.targetSyndicateId
        : n.targetKind === "minion" && n.targetMinionId
          ? minionById.get(n.targetMinionId as string)?.syndicateId
          : undefined;

    const row: GameNoteRow = {
      _id: n._id,
      createdAt: n.createdAt,
      body: n.body,
      visibility: n.visibility,
      authorUserId: n.authorUserId,
      authorDisplayName: userDisplay(n.authorUserId),
      targetKind: n.targetKind,
      replyCount: opts.replyCountByNoteId.get(n._id as string) ?? 0,
    };
    // GM-only: the clock never reaches non-GM viewers.
    if (opts.includeGmFields && n.timer) row.timer = n.timer;

    if (n.targetKind === "syndicate" && n.targetSyndicateId) {
      row.targetSyndicateId = n.targetSyndicateId;
    }
    if (n.targetKind === "minion" && n.targetMinionId) {
      row.targetMinionId = n.targetMinionId;
      const m = minionById.get(n.targetMinionId as string);
      if (m) row.minionName = m.name;
    }
    if (n.targetKind === "grant" && n.targetGrantId) {
      row.targetGrantId = n.targetGrantId;
      const g = grantById.get(n.targetGrantId as string);
      if (g) {
        row.grantKeyword = g.keyword;
        if (g.ownerPlayerId) {
          const p = playerById.get(g.ownerPlayerId as string);
          if (p) {
            row.playerId = p._id;
            row.playerDisplayName = userDisplay(p.userId);
          }
        }
      }
    }
    if (n.targetKind === "goal" && n.targetGoalId) {
      row.targetGoalId = n.targetGoalId;
      const g = goalById.get(n.targetGoalId as string);
      if (g) {
        row.goalKeyword = g.keyword;
        if (g.fromPlayerId) {
          const p = playerById.get(g.fromPlayerId as string);
          if (p) {
            row.playerId = p._id;
            row.playerDisplayName = userDisplay(p.userId);
          }
        }
      }
    }
    if (n.targetKind === "announcement" && n.targetAnnouncementId) {
      row.targetAnnouncementId = n.targetAnnouncementId;
      const announcement = announcementById.get(
        n.targetAnnouncementId as string,
      );
      if (announcement) {
        row.announcementExcerpt = excerptAnnouncement(announcement.body);
      }
    }
    if (n.targetKind === "note" && n.targetNoteId) {
      row.targetNoteId = n.targetNoteId;
      const parent = parentNoteById.get(n.targetNoteId as string);
      if (parent) {
        row.parentNoteExcerpt = excerptNote(parent.body);
        row.parentNoteAuthorDisplayName = userDisplay(parent.authorUserId);
      }
    }

    if (syndId) {
      const s = syndicateById.get(syndId as string);
      if (s) row.syndicateName = s.name;
      const p = playerBySyndicateId.get(syndId as string);
      if (p) {
        row.playerId = p._id;
        row.playerDisplayName = userDisplay(p.userId);
      }
    }

    // GM-only: pinned rolls never reach non-GM viewers. KEY OMITTED
    // when absent; KEY PRESENT (with `null` fallback) when the note
    // pins a roll set whose row may have been deleted.
    if (opts.includeGmFields && n.attachedRollSetId) {
      row.attachedRolls =
        rollSetById.get(n.attachedRollSetId as string) ?? null;
    }
    return row;
  });

  // ── Server-side time-INDEPENDENT sort ─────────────────────
  // Newest-first by `createdAt`. `createdAt` is frozen at insert
  // time so the order is stable until a new timer-bearing note is
  // created or an existing one is deleted — no wall-clock reads,
  // no client refinement.
  projected.sort((a, b) => b.createdAt - a.createdAt);

  return projected;
}

/**
 * GM-only aggregation: every timer-bearing note in `gameId`,
 * newest-first. Retained as a dedicated GM entry point alongside the
 * broader `listGameNotes`. GM-only — Rule 24, server-side
 * authoritative (`requireGameGm` before reads).
 */
export const listGameTimerNotes = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args): Promise<TimerNoteRow[]> => {
    const game = await requireGameGm(ctx, args.gameId);
    const allNotes = await ctx.db
      .query("notes")
      .withIndex("by_game_kind_created", (q) => q.eq("gameId", args.gameId))
      .collect();
    const noteById = indexNotesById(allNotes);
    const visible = allNotes.filter((note) =>
      canViewNoteAndAncestors(
        note,
        noteById,
        { userId: game.gmId, role: "gm" },
        game.state,
      ),
    );
    const timerNotes = visible.filter((n) => n.timer !== undefined);
    const rows = await projectNoteRows(ctx, timerNotes, {
      gameId: args.gameId,
      includeGmFields: true,
      replyCountByNoteId: buildReplyCountMap(visible),
    });
    return rows as TimerNoteRow[];
  },
});

/**
 * Notes drawer aggregation — every note in `gameId` the viewer may see
 * (`canViewNote`: own + public for Players, all for the GM), projected
 * newest-first with denormalised target context. GM-only fields
 * (`timer`, `attachedRolls`) are stripped for Players.
 *
 * `clocksOnly` (GM-only) narrows the list to timer-bearing notes; the
 * flag is ignored for Players, who never receive timers anyway.
 */
export const listGameNotes = query({
  args: { gameId: v.id("games"), clocksOnly: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<GameNoteRow[]> => {
    const { game, userId, role } = await requireGameParticipant(
      ctx,
      args.gameId,
    );
    const allNotes = await ctx.db
      .query("notes")
      .withIndex("by_game_kind_created", (q) => q.eq("gameId", args.gameId))
      .collect();
    const noteById = indexNotesById(allNotes);
    let visible = allNotes.filter((note) =>
      canViewNoteAndAncestors(note, noteById, { userId, role }, game.state),
    );
    const replyCountByNoteId = buildReplyCountMap(visible);
    if (args.clocksOnly && role === "gm") {
      visible = visible.filter((n) => n.timer !== undefined);
    }
    return await projectNoteRows(ctx, visible, {
      gameId: args.gameId,
      includeGmFields: role === "gm",
      replyCountByNoteId,
    });
  },
});

export const listNotesForTarget = query({
  args: {
    gameId: v.id("games"),
    targetKind: v.union(
      v.literal("game"),
      v.literal("syndicate"),
      v.literal("minion"),
      v.literal("grant"),
      v.literal("goal"),
      v.literal("announcement"),
      v.literal("note"),
    ),
    targetSyndicateId: v.optional(v.id("syndicates")),
    targetMinionId: v.optional(v.id("minions")),
    targetGrantId: v.optional(v.id("treasonGrants")),
    targetGoalId: v.optional(v.id("goals")),
    targetAnnouncementId: v.optional(v.id("announcements")),
    targetNoteId: v.optional(v.id("notes")),
  },
  handler: async (ctx, args): Promise<NoteListItem[]> => {
    const { game, userId, role } = await requireGameParticipant(
      ctx,
      args.gameId,
    );
    assertNoteTargetVisibleInState(args.targetKind, game.state, role);

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
    } else if (args.targetKind === "minion") {
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
    } else if (args.targetKind === "grant") {
      if (!args.targetGrantId) {
        throw new Error("targetGrantId is required for grant notes.");
      }
      rows = await ctx.db
        .query("notes")
        .withIndex("by_game_grant_created", (q) =>
          q.eq("gameId", args.gameId).eq("targetGrantId", args.targetGrantId!),
        )
        .order("desc")
        .collect();
    } else if (args.targetKind === "goal") {
      if (!args.targetGoalId) {
        throw new Error("targetGoalId is required for goal notes.");
      }
      rows = await ctx.db
        .query("notes")
        .withIndex("by_game_goal_created", (q) =>
          q.eq("gameId", args.gameId).eq("targetGoalId", args.targetGoalId!),
        )
        .order("desc")
        .collect();
    } else if (args.targetKind === "announcement") {
      if (!args.targetAnnouncementId) {
        throw new Error(
          "targetAnnouncementId is required for announcement notes.",
        );
      }
      const announcement = await ctx.db.get(args.targetAnnouncementId);
      if (!announcement) throw new Error("Announcement not found.");
      if (announcement.gameId !== args.gameId) {
        throw new Error("That Announcement is not in this game.");
      }
      rows = await ctx.db
        .query("notes")
        .withIndex("by_game_announcement_created", (q) =>
          q
            .eq("gameId", args.gameId)
            .eq("targetAnnouncementId", args.targetAnnouncementId!),
        )
        .order("desc")
        .collect();
    } else {
      if (!args.targetNoteId) {
        throw new Error("targetNoteId is required for note replies.");
      }
      const targetNote = await ctx.db.get(args.targetNoteId);
      if (!targetNote || targetNote.gameId !== args.gameId) {
        throw new Error("Target note not found or is not visible.");
      }
      await assertNoteAndAncestorsVisible(ctx, targetNote, {
        userId,
        role,
        gameState: game.state,
      });
      rows = await ctx.db
        .query("notes")
        .withIndex("by_game_note_created", (q) =>
          q.eq("gameId", args.gameId).eq("targetNoteId", args.targetNoteId!),
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
      const uniqueIds = Array.from(
        new Set(rollSetIds.map((id) => id as string)),
      );
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
      // Note timers v1: GM-only, key omitted entirely for non-GMs and
      // for notes that never had a timer attached.
      if (role === "gm" && n.timer) {
        base.timer = n.timer;
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
    byGrant: Record<string, number>;
    byGoal: Record<string, number>;
    byAnnouncement: Record<string, number>;
    byNote: Record<string, number>;
  }> => {
    // Non-participants are rejected. Result is only meaningful inside the
    // game detail page, which already requires participation.
    const { game, userId, role } = await requireGameParticipant(
      ctx,
      args.gameId,
    );

    // One bulk read: every note for this game. `notes` is per-game so the
    // working set stays small.
    const allGameNotes = await ctx.db
      .query("notes")
      .withIndex("by_game_kind_created", (q) => q.eq("gameId", args.gameId))
      .collect();

    let gameNotes = 0;
    const bySyndicate: Record<string, number> = {};
    const byMinion: Record<string, number> = {};
    const byGrant: Record<string, number> = {};
    const byGoal: Record<string, number> = {};
    const byAnnouncement: Record<string, number> = {};
    const byNote: Record<string, number> = {};
    const noteById = indexNotesById(allGameNotes);
    for (const n of allGameNotes) {
      if (!canViewNoteAndAncestors(n, noteById, { userId, role }, game.state)) {
        continue;
      }
      if (n.targetKind === "game") {
        gameNotes += 1;
      } else if (n.targetKind === "syndicate" && n.targetSyndicateId) {
        bySyndicate[n.targetSyndicateId] =
          (bySyndicate[n.targetSyndicateId] ?? 0) + 1;
      } else if (n.targetKind === "minion" && n.targetMinionId) {
        byMinion[n.targetMinionId] = (byMinion[n.targetMinionId] ?? 0) + 1;
      } else if (n.targetKind === "grant" && n.targetGrantId) {
        byGrant[n.targetGrantId] = (byGrant[n.targetGrantId] ?? 0) + 1;
      } else if (n.targetKind === "goal" && n.targetGoalId) {
        byGoal[n.targetGoalId] = (byGoal[n.targetGoalId] ?? 0) + 1;
      } else if (n.targetKind === "announcement" && n.targetAnnouncementId) {
        byAnnouncement[n.targetAnnouncementId] =
          (byAnnouncement[n.targetAnnouncementId] ?? 0) + 1;
      } else if (n.targetKind === "note" && n.targetNoteId) {
        byNote[n.targetNoteId] = (byNote[n.targetNoteId] ?? 0) + 1;
      }
    }
    return {
      gameNotes,
      bySyndicate,
      byMinion,
      byGrant,
      byGoal,
      byAnnouncement,
      byNote,
    };
  },
});

type NoteViewer = {
  userId: Id<"users">;
  role: "gm" | "player";
};

function indexNotesById(notes: Doc<"notes">[]): Map<string, Doc<"notes">> {
  return new Map(notes.map((note) => [note._id as string, note]));
}

function canViewNoteAndAncestors(
  note: Doc<"notes">,
  noteById: Map<string, Doc<"notes">>,
  viewer: NoteViewer,
  gameState: Doc<"games">["state"],
): boolean {
  const seen = new Set<string>();
  let current: Doc<"notes"> | undefined = note;

  while (current) {
    const currentId = current._id as string;
    if (seen.has(currentId)) return false;
    seen.add(currentId);

    if (!canViewNote(current, viewer)) return false;
    if (!canViewNoteTarget(current, gameState, viewer.role)) return false;
    if (current.targetKind !== "note") return true;
    if (!current.targetNoteId) return false;

    const parent = noteById.get(current.targetNoteId as string);
    if (!parent || parent.gameId !== note.gameId) return false;
    current = parent;
  }

  return false;
}

async function assertNoteAndAncestorsVisible(
  ctx: QueryCtx | MutationCtx,
  note: Doc<"notes">,
  params: NoteViewer & { gameState: Doc<"games">["state"] },
): Promise<void> {
  const seen = new Set<string>();
  let current: Doc<"notes"> | null = note;

  while (current) {
    const currentId = current._id as string;
    if (seen.has(currentId)) {
      throw new Error("Target note thread is invalid.");
    }
    seen.add(currentId);

    if (
      !canViewNote(current, params) ||
      !canViewNoteTarget(current, params.gameState, params.role)
    ) {
      throw new Error("Target note not found or is not visible.");
    }
    if (current.targetKind !== "note") return;
    if (!current.targetNoteId) {
      throw new Error("Target note thread is invalid.");
    }

    const parent: Doc<"notes"> | null = await ctx.db.get(current.targetNoteId);
    if (!parent || parent.gameId !== note.gameId) {
      throw new Error("Target note thread is invalid.");
    }
    current = parent;
  }
}

function buildReplyCountMap(visibleNotes: Doc<"notes">[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of visibleNotes) {
    if (note.targetKind !== "note" || !note.targetNoteId) continue;
    const targetId = note.targetNoteId as string;
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
  }
  return counts;
}

function canViewNoteTarget(
  note: Doc<"notes">,
  gameState: Doc<"games">["state"],
  role: "gm" | "player",
): boolean {
  return (
    note.targetKind !== "announcement" || role === "gm" || gameState !== "ready"
  );
}

function assertNoteTargetVisibleInState(
  targetKind: Doc<"notes">["targetKind"],
  gameState: Doc<"games">["state"],
  role: "gm" | "player",
): void {
  if (
    targetKind === "announcement" &&
    gameState === "ready" &&
    role === "player"
  ) {
    throw new Error(
      "Announcements are only visible to the Game Master before play begins.",
    );
  }
}

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
