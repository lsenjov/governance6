import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export async function assertNotesHaveNoReplies(
  ctx: MutationCtx,
  notes: readonly Doc<"notes">[],
): Promise<void> {
  for (const note of notes) {
    const replies = await ctx.db
      .query("notes")
      .withIndex("by_note", (q) => q.eq("targetNoteId", note._id))
      .take(1);
    if (replies.length > 0) {
      throw new Error("Delete note replies first, before deleting their target.");
    }
  }
}
