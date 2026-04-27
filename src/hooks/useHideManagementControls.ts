import { useCallback, useEffect, useState } from "react";
import type { Id } from "../../convex/_generated/dataModel";

type GameId = Id<"games">;

/**
 * Per-game GM display preference: when `true`, the Treason Grants and
 * Goals sections hide their authoring entry points (`+ New Grant`,
 * `+ New Goal`) and per-row management buttons (Edit / Clear owner /
 * Delete on grants, Edit / Delete on goals).
 *
 * - Persisted in `localStorage` under `game:{gameId}:hideManagementControls`
 *   so the choice survives reload but does not leak across games.
 * - Default is `false` (controls visible).
 * - Storage failures (private mode, quota, missing `window`) silently
 *   degrade to `false` for that session.
 * - Writes only happen inside the setter (event-driven) to avoid
 *   spurious writes on Convex re-renders.
 *
 * Mirrors the storage convention used by `useRosterExpandedSet`
 * (`src/hooks/useRosterExpandedSet.ts`).
 */
export function useHideManagementControls(
  gameId: GameId | undefined,
): readonly [boolean, (next: boolean) => void] {
  const storageKey = gameId ? `game:${gameId}:hideManagementControls` : null;

  const [value, setValueState] = useState<boolean>(() => {
    if (!storageKey || typeof window === "undefined") return false;
    return readBool(storageKey);
  });

  // Resync if the gameId changes (defensive — typically a single value
  // per page load, but keeps behaviour aligned with `useRosterExpandedSet`).
  useEffect(() => {
    if (!storageKey || typeof window === "undefined") {
      setValueState(false);
      return;
    }
    setValueState(readBool(storageKey));
  }, [storageKey]);

  const setValue = useCallback(
    (next: boolean) => {
      setValueState(next);
      if (storageKey && typeof window !== "undefined") {
        writeBool(storageKey, next);
      }
    },
    [storageKey],
  );

  return [value, setValue] as const;
}

function readBool(storageKey: string): boolean {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as unknown;
    return parsed === true;
  } catch {
    return false;
  }
}

function writeBool(storageKey: string, value: boolean): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode, quota, etc.) — ignore.
  }
}
