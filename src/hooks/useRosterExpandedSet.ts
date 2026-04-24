import { useCallback, useEffect, useMemo, useState } from "react";
import type { Id } from "../../convex/_generated/dataModel";

type GameId = Id<"games">;
type PlayerId = Id<"players">;

/**
 * Hybrid roster-expand state for the Game Detail page.
 *
 * - The viewer's own `playerId` is ALWAYS treated as expanded, regardless
 *   of what's stored. This keeps your own minions visible by default.
 * - All other players default to collapsed. Per-game expand state for
 *   other players persists in `localStorage` under
 *   `game:{gameId}:rosterExpanded` as a JSON array of player ids.
 * - Missing / invalid JSON is tolerated (treated as "no players expanded").
 * - Stale ids (players no longer in the live roster) are filtered out on
 *   every read and written back to `localStorage`.
 */
export function useRosterExpandedSet(
  gameId: GameId | undefined,
  selfPlayerId: PlayerId | null,
  livePlayerIds: PlayerId[],
) {
  const storageKey = gameId ? `game:${gameId}:rosterExpanded` : null;

  const [storedIds, setStoredIds] = useState<ReadonlyArray<PlayerId>>(() => {
    if (!storageKey || typeof window === "undefined") return [];
    return readIds(storageKey);
  });

  // If the gameId changes (unlikely within a single page load, but
  // defensively), resync from storage.
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") {
      setStoredIds([]);
      return;
    }
    setStoredIds(readIds(storageKey));
  }, [storageKey]);

  // Filter out stale ids against the live roster on every render. If the
  // filtered list differs from what's stored, write it back.
  const liveSet = useMemo(() => new Set(livePlayerIds), [livePlayerIds]);
  const cleanedIds = useMemo(
    () => storedIds.filter((id) => liveSet.has(id)),
    [storedIds, liveSet],
  );

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    if (cleanedIds.length === storedIds.length) return;
    writeIds(storageKey, cleanedIds);
    setStoredIds(cleanedIds);
  }, [storageKey, cleanedIds, storedIds]);

  const isExpanded = useCallback(
    (pid: PlayerId) => {
      if (selfPlayerId && pid === selfPlayerId) return true;
      return cleanedIds.includes(pid);
    },
    [selfPlayerId, cleanedIds],
  );

  const toggle = useCallback(
    (pid: PlayerId) => {
      // Self can't be collapsed.
      if (selfPlayerId && pid === selfPlayerId) return;
      setStoredIds((prev) => {
        const next = prev.includes(pid)
          ? prev.filter((x) => x !== pid)
          : [...prev, pid];
        if (storageKey && typeof window !== "undefined") {
          writeIds(storageKey, next);
        }
        return next;
      });
    },
    [selfPlayerId, storageKey],
  );

  return { isExpanded, toggle };
}

function readIds(storageKey: string): ReadonlyArray<PlayerId> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is PlayerId => typeof x === "string");
  } catch {
    return [];
  }
}

function writeIds(storageKey: string, ids: ReadonlyArray<PlayerId>): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(ids));
  } catch {
    // Storage unavailable (private mode, quota, etc.) — ignore.
  }
}
