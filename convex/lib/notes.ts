import type { Doc } from "../_generated/dataModel";

const REPLY_DELETE_ERROR =
  "Delete note replies first, before deleting their target.";

export function assertNoteHasNoReplies(note: Doc<"notes">): void {
  if ((note.replyCount ?? 0) > 0) {
    throw new Error(REPLY_DELETE_ERROR);
  }
}

export function assertNotesHaveNoReplies(notes: readonly Doc<"notes">[]): void {
  if (notes.some((note) => (note.replyCount ?? 0) > 0)) {
    throw new Error(REPLY_DELETE_ERROR);
  }
}
