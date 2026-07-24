import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const REPLY_DELETE_ERROR =
  "Delete note replies first, before deleting their target.";

export async function assertNoteHasNoReplies(
  ctx: MutationCtx,
  note: Doc<"notes">,
): Promise<void> {
  const replies = await ctx.db
    .query("notes")
    .withIndex("by_note", (q) => q.eq("targetNoteId", note._id))
    .take(1);
  if (replies.length > 0) {
    throw new Error(REPLY_DELETE_ERROR);
  }
}

export async function assertNotesHaveNoReplies(
  ctx: MutationCtx,
  notes: readonly Doc<"notes">[],
): Promise<void> {
  const noteIds = new Set(notes.map((note) => note._id as string));
  const gameIds = new Set(notes.map((note) => note.gameId));
  for (const gameId of gameIds) {
    const replies = ctx.db
      .query("notes")
      .withIndex("by_game_kind_created", (q) =>
        q.eq("gameId", gameId).eq("targetKind", "note"),
      );
    for await (const reply of replies) {
      if (
        reply.targetNoteId !== undefined &&
        noteIds.has(reply.targetNoteId as string)
      ) {
        throw new Error(REPLY_DELETE_ERROR);
      }
    }
  }
}
