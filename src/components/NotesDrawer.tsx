import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { GameNoteRow } from "../../convex/notes";
import { Drawer } from "./Drawer";
import { NoteTimerCell } from "./NoteTimerCell";
import { RollSetDisplay } from "./RollSetDisplay";
import { NoteIcon } from "./NoteIcon";

/**
 * Notes drawer — at-a-glance list of every note in the current game
 * the viewer may see (own + public for Players, all for the GM),
 * newest-first. Open to all participants
 * (`plans/2026-04-28-gm-todo-drawer-v1.md` for the GM-only origin).
 *
 * Subscribes to `listGameNotes`. Each row carries its own
 * `<NoteTimerCell>` (shared `useNow()` heartbeat, GM-only) and pinned
 * roll set when present. Cycling a clock reuses `cycleNoteTimer`
 * verbatim — there is no parallel write path.
 *
 * Sort order: server returns rows newest-first by `createdAt`, fully
 * time-INDEPENDENT — `createdAt` is frozen at insert time, so order
 * only changes when a note is added or removed.
 *
 * GM-only `clocksOnly` toggle narrows the list to timer-bearing notes;
 * the toggle is hidden for Players (who never receive timers), and the
 * server ignores the flag for non-GM callers.
 */
export function NotesDrawer({
  gameId,
  viewerIsGm,
  hideManagementControls,
  onClose,
}: {
  gameId: Id<"games">;
  viewerIsGm: boolean;
  hideManagementControls: boolean;
  onClose: () => void;
}) {
  const [clocksOnly, setClocksOnly] = useState(false);
  const rows = useQuery(api.notes.listGameNotes, {
    gameId,
    ...(viewerIsGm && clocksOnly ? { clocksOnly: true } : {}),
  });
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
    <Drawer onClose={onClose} title="Notes">
      {err && (
        <div className="error" role="alert" style={{ margin: "0 1rem" }}>
          {err}
        </div>
      )}
      {viewerIsGm && (
        <label className="notes-drawer-filter">
          <input
            type="checkbox"
            checked={clocksOnly}
            onChange={(e) => setClocksOnly(e.target.checked)}
          />
          Clocks only
        </label>
      )}
      <NotesDrawerBody
        gameId={gameId}
        rows={rows}
        viewerIsGm={viewerIsGm}
        hideManagementControls={hideManagementControls}
        onCycle={handleCycle}
      />
    </Drawer>
  );
}

function NotesDrawerBody({
  gameId,
  rows,
  viewerIsGm,
  hideManagementControls,
  onCycle,
}: {
  gameId: Id<"games">;
  rows: GameNoteRow[] | undefined;
  viewerIsGm: boolean;
  hideManagementControls: boolean;
  onCycle: (noteId: Id<"notes">) => void | Promise<void>;
}) {
  if (rows === undefined) {
    return <div className="muted">Loading…</div>;
  }
  if (rows.length === 0) {
    return <div className="muted">No notes yet.</div>;
  }
  return (
    <>
      {rows.map((r) => (
        <NotesDrawerRow
          key={r._id}
          gameId={gameId}
          row={r}
          viewerIsGm={viewerIsGm}
          hideManagementControls={hideManagementControls}
          onCycle={onCycle}
        />
      ))}
    </>
  );
}

function NotesDrawerRow({
  gameId,
  row,
  viewerIsGm,
  hideManagementControls,
  onCycle,
}: {
  gameId: Id<"games">;
  row: GameNoteRow;
  viewerIsGm: boolean;
  hideManagementControls: boolean;
  onCycle: (noteId: Id<"notes">) => void | Promise<void>;
}) {
  // Layout mirrors `<NoteList>`'s `.note-item` block so spacing,
  // borders, and metadata typography stay consistent with the popover.
  // Design 19: the clock + dice render as a terminal prefix bar across
  // the top of the card (`variant="terminal"`). GM-only fields (timer /
  // rolls) are absent on Player payloads, so the bar is suppressed for
  // them entirely.
  const hasRolls =
    row.attachedRolls !== undefined && row.attachedRolls !== null;
  const timerEl = row.timer ? (
    <NoteTimerCell
      timer={row.timer}
      viewerIsGm={viewerIsGm}
      onCycle={() => onCycle(row._id)}
      variant="terminal"
    />
  ) : null;
  return (
    <div className="note-item">
      {(hasRolls || timerEl) && (
        <div className="note-terminal-bar" aria-label="Dice rolls (GM)">
          {hasRolls ? (
            <RollSetDisplay
              rolls={row.attachedRolls!}
              variant="terminal"
              trailing={timerEl ?? undefined}
            />
          ) : (
            timerEl
          )}
        </div>
      )}
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
          title={new Date(row.createdAt).toLocaleString()}
          style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}
        >
          {new Date(row.createdAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        <span className="notes-drawer-target">{formatNoteTarget(row)}</span>
        <NoteIcon
          gameId={gameId}
          target={{ kind: "note", noteId: row._id }}
          count={row.replyCount}
          label={`note by ${row.authorDisplayName}`}
          hideManagementControls={hideManagementControls}
          variant="reply"
        />
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
 * Render the target context line for a note row. JSX so individual
 * segments can carry the existing `.muted` separator class.
 *
 *   - minion-target: `Minion • Syndicate • Player`
 *   - syndicate-target: `Syndicate • Player`
 *   - grant-target: `Grant keyword • Owner player`
 *   - goal-target: `Goal keyword • From player`
 *   - note-target: `Note: excerpt • Author`
 *   - game-target: `Game-wide`
 *
 * Missing player slot renders `(unassigned)` (muted) so the column
 * count stays visually stable even when nobody has selected the
 * syndicate yet (or, for grant/goal targets, when the row has no
 * owner / from-player).
 *
 * Exported for unit tests.
 */
export function formatNoteTarget(
  row: Pick<
    GameNoteRow,
    | "targetKind"
    | "minionName"
    | "syndicateName"
    | "grantKeyword"
    | "goalKeyword"
    | "announcementExcerpt"
    | "parentNoteExcerpt"
    | "parentNoteAuthorDisplayName"
    | "playerDisplayName"
  >,
): React.ReactNode {
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

  if (row.targetKind === "grant") {
    return (
      <>
        <span>{row.grantKeyword ?? "(unknown grant)"}</span>
        {sep}
        {playerSegment}
      </>
    );
  }

  if (row.targetKind === "goal") {
    return (
      <>
        <span>{row.goalKeyword ?? "(unknown goal)"}</span>
        {sep}
        {playerSegment}
      </>
    );
  }

  if (row.targetKind === "announcement") {
    return (
      <>
        <span>Announcement:</span>{" "}
        <span>{row.announcementExcerpt ?? "(deleted announcement)"}</span>
      </>
    );
  }

  if (row.targetKind === "note") {
    return (
      <>
        <span>Note:</span>{" "}
        <span>{row.parentNoteExcerpt ?? "(deleted note)"}</span>
        {sep}
        <span>{row.parentNoteAuthorDisplayName ?? "Unknown"}</span>
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
