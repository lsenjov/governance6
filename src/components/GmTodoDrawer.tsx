import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { GmTodoNoteRow } from "../../convex/notes";
import { Drawer } from "./Drawer";
import { NoteTimerCell } from "./NoteTimerCell";
import { RollSetDisplay } from "./RollSetDisplay";

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
 * Sort order: server returns rows newest-first by `createdAt`. The
 * order is fully time-INDEPENDENT — `createdAt` is frozen at insert
 * time, so the drawer order only changes when a timer-bearing note
 * is added or removed. No client-side refinement is needed.
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
      <GmTodoBody rows={rows} onCycle={handleCycle} />
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
  // popover. The body excerpt sits above the clock + dice line.
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
    </div>
  );
}

/**
 * Render the target context line for a GM Todo row. JSX so individual
 * segments can carry the existing `.muted` separator class.
 *
 *   - minion-target: `Minion • Syndicate • Player`
 *   - syndicate-target: `Syndicate • Player`
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
        <span>{row.syndicateName ?? "(unknown syndicate)"}</span>
        {sep}
        {playerSegment}
      </>
    );
  }

  // minion-target
  return (
    <>
      <span>{row.minionName ?? "(unknown minion)"}</span>
      {sep}
      <span>{row.syndicateName ?? "(unknown syndicate)"}</span>
      {sep}
      {playerSegment}
    </>
  );
}
