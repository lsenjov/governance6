import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * Single reactive subscription feeding badge counts for every NoteIcon on the
 * game detail page. Returns `undefined` while loading and never throws — any
 * errors surface as zero counts so icons don't flash badges incorrectly.
 */
export function useNotesCountMap(gameId: Id<"games"> | undefined) {
  const counts = useQuery(
    api.notes.getNoteCountsForGameView,
    gameId ? { gameId } : "skip",
  );
  return counts;
}

/**
 * Resolve the badge count for a specific note target from the map returned by
 * `useNotesCountMap`. Returns 0 when the map is still loading.
 */
export function resolveNoteCount(
  counts:
    | {
        gameNotes: number;
        bySyndicate: Record<string, number>;
        byMinion: Record<string, number>;
      }
    | undefined,
  target:
    | { kind: "game" }
    | { kind: "syndicate"; syndicateId: Id<"syndicates"> }
    | { kind: "minion"; minionId: Id<"minions"> },
): number {
  if (!counts) return 0;
  if (target.kind === "game") return counts.gameNotes;
  if (target.kind === "syndicate") {
    return counts.bySyndicate[target.syndicateId] ?? 0;
  }
  return counts.byMinion[target.minionId] ?? 0;
}
