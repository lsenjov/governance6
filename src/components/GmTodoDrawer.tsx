import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { GmTodoNoteRow } from "../../convex/notes";
import { Drawer } from "./Drawer";
import { NoteTimerCell } from "./NoteTimerCell";
import { RollSetDisplay } from "./RollSetDisplay";
import { useNow } from "../lib/useNow";

/**
 * GM Todo drawer — at-a-glance "todo list" of every note in the
 * current game that has a clock attached. See
 * `plans/2026-04-28-gm-todo-drawer-v1.md`.
 *
 * Subscribes to the GM-only `listGameNotesWithTimers` query. Each row
 * carries its own `<NoteTimerCell>` (shared `useNow()` heartbeat) and
 * its own pinned roll set when present. Cycling a clock reuses
 * `cycleNoteTimer` verbatim — there is no parallel write path.
 *
 * Sort split-of-responsibility (Task 1 + Task 8):
 *   - Server returns rows in time-INDEPENDENT order (ticking by
 *     `dueAt` asc, then `due_manual` newest first, then `done`
 *     newest first). Convex queries do not react to wall-clock
 *     time, so the overdue/future split inside the `ticking` band
 *     CANNOT live on the server — calling `Date.now()` inside a
 *     query handler captures one snapshot at execution time.
 *   - Client refines the ticking band on each 1Hz heartbeat: rows
 *     past `dueAt` (overdue, most-overdue first) precede rows with
 *     `dueAt` in the future (soonest first). Both halves keep the
 *     server's `dueAt`-ascending order, so the partition is a
 *     single split at the first index where `dueAt > now`.
 *
 * Future contributors: do NOT move the overdue/future split to the
 * server. Doing so freezes the boundary until an unrelated mutation
 * lands, which defeats the drawer's purpose.
 *
 * Visibility — GM only. The button gate, the conditional mount in
 * `GameDetailPage`, and the server-side `requireGameGm` form three
 * layers of defence. Player sessions never reach this component.
 *
 * Scope: v1 deliberately exposes ONLY the cycle-on-click action.
 * Other note operations (delete, change visibility — neither exists
 * today: notes are author-immutable post-creation) stay in the
 * popover so the drawer doesn't drift into a second source of truth.
 */
export function GmTodoDrawer({
  gameId,
  onClose,
}: {
  gameId: Id<"games">;
  onClose: () => void;
}) {
  const rows = useQuery(api.notes.listGameNotesWithTimers, { gameId });
  const cycleTimer = useMutation(api.notes.cycleNoteTimer);
  const [err, setErr] = useState<string | null>(null);

  // Subscribe to the shared 1Hz heartbeat for the client-side sort
  // refinement. The same hook drives every visible `<NoteTimerCell>`
  // so the drawer's ordering and each cell's countdown stay in
  // lockstep without a drawer-local interval.
  const now = useNow();

  const ordered = useMemo(
    () => (rows === undefined ? undefined : refineOrder(rows, now)),
    [rows, now],
  );

  async function handleCycle(noteId: Id<"notes">): Promise<void> {
    setErr(null);
    try {
      await cycleTimer({ noteId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to cycle timer.");
    }
  }

  return (
    <Drawer onClose={onClose} title="GM Todo">
      {err && (
        <div className="error" role="alert" style={{ margin: "0 1rem" }}>
          {err}
        </div>
      )}
      <GmTodoBody rows={ordered} onCycle={handleCycle} />
    </Drawer>
  );
}

function GmTodoBody({
  rows,
  onCycle,
}: {
  rows: GmTodoNoteRow[] | undefined;
  onCycle: (noteId: Id<"notes">) => void | Promise<void>;
}) {
  if (rows === undefined) {
    return <div className="muted">Loading…</div>;
  }
  if (rows.length === 0) {
    return <div className="muted">No clocks running.</div>;
  }
  return (
    <>
      {rows.map((r) => (
        <GmTodoRow key={r._id} row={r} onCycle={onCycle} />
      ))}
    </>
  );
}

function GmTodoRow({
  row,
  onCycle,
}: {
  row: GmTodoNoteRow;
  onCycle: (noteId: Id<"notes">) => void | Promise<void>;
}) {
  // Layout mirrors `<NoteList>`'s `.note-item` block so spacing,
  // borders, and metadata typography stay consistent with the
  // popover. The clock + dice line sits above the body excerpt.
  return (
    <div className="note-item">
      <div className="note-item-meta">
        <strong>{row.authorDisplayName}</strong>
        <span
          className={`badge ${row.visibility === "public" ? "accent" : ""}`}
          style={{ marginLeft: "0.5rem" }}
        >
          {row.visibility}
        </span>
        <span
          className="muted"
          style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}
        >
          {new Date(row.createdAt).toLocaleString()}
        </span>
        <span style={{ marginLeft: "auto" }}>{formatGmTodoTarget(row)}</span>
      </div>
      <div style={{ marginTop: "0.4rem" }}>
        {row.attachedRolls !== undefined && row.attachedRolls !== null ? (
          <RollSetDisplay
            rolls={row.attachedRolls}
            size="sm"
            trailing={
              <NoteTimerCell
                timer={row.timer}
                viewerIsGm={true}
                onCycle={() => onCycle(row._id)}
                size="sm"
              />
            }
          />
        ) : (
          <div className="roll-set" aria-label="Note timer (GM)">
            <NoteTimerCell
              timer={row.timer}
              viewerIsGm={true}
              onCycle={() => onCycle(row._id)}
              size="sm"
            />
          </div>
        )}
      </div>
      <div
        className="note-item-body"
        title={row.body}
        style={{
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {row.body}
      </div>
    </div>
  );
}

/**
 * Render the target context line for a GM Todo row. JSX so individual
 * segments can carry the existing `.muted` separator class.
 *
 *   - minion-target: `Player • Syndicate • Minion`
 *   - syndicate-target: `Player • Syndicate`
 *   - game-target: `Game-wide`
 *
 * Missing player slot renders `(unassigned)` (muted) so the column
 * count stays visually stable even when nobody has selected the
 * syndicate yet.
 *
 * Exported for unit tests (Task 13).
 */
export function formatGmTodoTarget(row: GmTodoNoteRow): React.ReactNode {
  if (row.targetKind === "game") {
    return <span className="muted">Game-wide</span>;
  }

  const playerSegment = row.playerDisplayName ? (
    <span>{row.playerDisplayName}</span>
  ) : (
    <span className="muted">(unassigned)</span>
  );

  const sep = <span className="muted"> • </span>;

  if (row.targetKind === "syndicate") {
    return (
      <>
        {playerSegment}
        {sep}
        <span>{row.syndicateName ?? "(unknown syndicate)"}</span>
      </>
    );
  }

  // minion-target
  return (
    <>
      {playerSegment}
      {sep}
      <span>{row.syndicateName ?? "(unknown syndicate)"}</span>
      {sep}
      <span>{row.minionName ?? "(unknown minion)"}</span>
    </>
  );
}

/**
 * Client-side sort refinement (Task 8). Splits the server's
 * `dueAt`-ascending `ticking` band against `now`: rows past `dueAt`
 * (overdue) precede rows with `dueAt` in the future (running). Both
 * halves stay in the server's order. Tiers 2 (`due_manual`) and 3
 * (`done`) are passed through as-is.
 *
 * The split is a single linear scan because the server already sorted
 * `ticking` rows by `dueAt`. We pull tiers 2/3 out of the array
 * unchanged.
 *
 * Exported for unit tests (Task 13).
 */
export function refineOrder(
  rows: readonly GmTodoNoteRow[],
  now: number,
): GmTodoNoteRow[] {
  const ticking: GmTodoNoteRow[] = [];
  const rest: GmTodoNoteRow[] = [];
  for (const r of rows) {
    if (r.timer.kind === "ticking") ticking.push(r);
    else rest.push(r);
  }
  // Server sorted `ticking` by `dueAt` asc. The first index where
  // `dueAt > now` is the boundary; everything before is overdue,
  // everything from there is future. Both halves stay in their
  // existing ascending order, which is exactly what we want:
  //
  //   - Overdue half: `dueAt` asc = furthest-past first =
  //     most-overdue first.
  //   - Future half:  `dueAt` asc = soonest first.
  //
  // No reversal — see `plans/2026-04-28-gm-todo-drawer-v1.md`
  // "Sort order" rationale (Task 8).
  let firstFuture = ticking.length;
  for (let i = 0; i < ticking.length; i++) {
    const t = ticking[i].timer;
    if (t.kind === "ticking" && t.dueAt > now) {
      firstFuture = i;
      break;
    }
  }
  const overdue = ticking.slice(0, firstFuture);
  const future = ticking.slice(firstFuture);
  return [...overdue, ...future, ...rest];
}
