import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { TIMER_PRESET_MINUTES } from "../../convex/notes";
import { resolveNoteCount, useNotesCountMap } from "../hooks/useNotesCountMap";
import { RollSetDisplay, type RollSet } from "./RollSetDisplay";
import { NoteTimerCell, type NoteTimerState } from "./NoteTimerCell";

/**
 * Discriminated target for any note-bearing entity in a game.
 * Re-exported so call-sites outside the popover (e.g. the Current Call
 * section in the game detail page) can construct it.
 */
export type NoteTarget =
  | { kind: "game" }
  | { kind: "syndicate"; syndicateId: Id<"syndicates"> }
  | { kind: "minion"; minionId: Id<"minions"> }
  | { kind: "grant"; grantId: Id<"treasonGrants"> }
  | { kind: "goal"; goalId: Id<"goals"> }
  | { kind: "announcement"; announcementId: Id<"announcements"> }
  | { kind: "note"; noteId: Id<"notes"> };

/**
 * Result-shape for a single note as returned by `api.notes.listNotesForTarget`.
 * Kept narrow so consumers can pass the array directly into `<NoteList>`.
 */
export type NoteListItem = {
  _id: Id<"notes">;
  createdAt: number;
  body: string;
  visibility: "private" | "public";
  authorUserId: Id<"users">;
  authorDisplayName: string;
  isMine: boolean;
  canDelete: boolean;
  /**
   * Dice rolls v1: GM-only. Server-side `listNotesForTarget` only
   * sets this key on GM payloads, and only when the note was
   * authored while a call was at the head of the queue and that
   * call's roll set was frozen onto the note. The key is omitted
   * (rather than null) for non-GM viewers and for notes that never
   * pinned a roll set.
   */
  attachedRolls?: RollSet | null;
  /**
   * Note timers v1: GM-only. Present only when the note has a timer
   * sub-object on the server row. Key omitted entirely for non-GM
   * viewers and for notes that never had a timer attached. See
   * `plans/2026-04-28-2026-04-28-note-timers-v1.md`.
   */
  timer?: NoteTimerState;
};

type NoteIconProps = {
  gameId: Id<"games">;
  target: NoteTarget;
  count: number;
  label: string; // Accessible label describing what the icon annotates.
  /**
   * When `true`, the GM-only "Delete" button on each listed note is
   * suppressed. Mirrors the per-game "Hide management controls" toggle
   * so the GM can demo the popover without exposing destructive
   * affordances. Defaults to `false`.
   */
  hideManagementControls?: boolean;
  variant?: "default" | "reply";
};

const NotesPopoverContext = createContext<{ lineage: string[] } | null>(null);

/**
 * Small speech-bubble button that toggles a NotesPopover for a given target.
 * Designed to sit inline next to a title/row.
 */
export function NoteIcon({
  gameId,
  target,
  count,
  label,
  hideManagementControls = false,
  variant = "default",
}: NoteIconProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const parentPopover = useContext(NotesPopoverContext);

  return (
    <div
      ref={anchorRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        className={`note-icon-button${variant === "reply" ? " note-reply-button" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${variant === "reply" ? "Replies" : "Notes"}: ${label}${count > 0 ? ` (${count})` : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <NoteGlyph />
        {variant === "reply" && <span>Reply</span>}
        {count > 0 && <span className="note-icon-badge">{count}</span>}
      </button>
      {open && (
        <NotesPopover
          gameId={gameId}
          target={target}
          label={label}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
          hideManagementControls={hideManagementControls}
          ancestorPopoverIds={parentPopover?.lineage ?? []}
        />
      )}
    </div>
  );
}

function NoteGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

type PopoverProps = {
  gameId: Id<"games">;
  target: NoteTarget;
  label: string;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLDivElement | null>;
  hideManagementControls?: boolean;
  ancestorPopoverIds: string[];
};

function NotesPopover({
  gameId,
  target,
  label,
  onClose,
  anchorRef,
  hideManagementControls = false,
  ancestorPopoverIds,
}: PopoverProps) {
  const popoverId = useId();
  const popoverLineage = [...ancestorPopoverIds, popoverId];
  const queryArgs = buildListArgs(gameId, target);
  const notes = useQuery(api.notes.listNotesForTarget, queryArgs);
  const remove = useMutation(api.notes.deleteNote);
  const cycleTimer = useMutation(api.notes.cycleNoteTimer);
  // Note timers v1: subscribes for the GM-only duration buttons. The
  // server returns `{ viewerIsGm: false, timerEligible: false }` for
  // Players, so non-GM popovers carry no extra UI from this query.
  const timerCtx = useQuery(
    api.notes.getTimerCreateContext,
    target.kind === "minion"
      ? { gameId, targetKind: "minion", targetMinionId: target.minionId }
      : target.kind === "grant"
        ? { gameId, targetKind: "grant", targetGrantId: target.grantId }
        : target.kind === "goal"
          ? { gameId, targetKind: "goal", targetGoalId: target.goalId }
          : target.kind === "announcement"
            ? {
                gameId,
                targetKind: "announcement",
                targetAnnouncementId: target.announcementId,
              }
            : target.kind === "note"
              ? {
                  gameId,
                  targetKind: "note",
                  targetNoteId: target.noteId,
                }
              : { gameId, targetKind: target.kind },
  );

  const [err, setErr] = useState<string | null>(null);
  // Viewport-relative pixel coords for the portalled popover. `null`
  // pre-measure so we can render the popover off-screen on the first
  // paint without it flashing at (0, 0) inside `document.body`.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Reposition the popover so it never overflows the viewport. Flips above
  // when there isn't room below, and right-aligns to the anchor when there
  // isn't room to extend rightward. Re-measures on resize, scroll, and
  // whenever the popover's own size changes (e.g. notes loading in).
  //
  // The popover is rendered through a portal into `document.body` (see
  // the `createPortal` call in the return statement) so it escapes the
  // `overflow-y: auto` clipping of ancestor scroll containers — most
  // notably the slide-over `.drawer` (`src/index.css:952-966`) used by
  // the Game Log. Because the portalled node is no longer a descendant
  // of the anchor, we use `position: fixed` plus explicit viewport
  // coords here instead of the previous `position: absolute` +
  // `calc(100% + 6px)` parent-relative offsets.
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    if (!anchor || !popover) return;

    const GAP = 6;
    const EDGE_PAD = 8;
    function reposition() {
      if (!anchor || !popover) return;
      const a = anchor.getBoundingClientRect();
      const p = popover.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;

      const fitsRight = a.left + p.width <= vw;
      const fitsBelow = a.bottom + GAP + p.height <= vh;
      const fitsAbove = a.top - GAP - p.height >= 0;

      // Same horizontal/vertical decision as before: left-align to the
      // anchor when it fits, otherwise right-align; below the anchor
      // when it fits, otherwise above only when there's actually more
      // room there.
      const horizontal: "left" | "right" = fitsRight ? "left" : "right";
      const vertical: "below" | "above" =
        !fitsBelow && fitsAbove ? "above" : "below";

      const rawTop =
        vertical === "below" ? a.bottom + GAP : a.top - GAP - p.height;
      const rawLeft = horizontal === "left" ? a.left : a.right - p.width;

      // Clamp to the viewport so nothing extends past the edge even on
      // narrow viewports where neither alignment fits cleanly.
      const top = Math.max(
        EDGE_PAD,
        Math.min(rawTop, vh - p.height - EDGE_PAD),
      );
      const left = Math.max(
        EDGE_PAD,
        Math.min(rawLeft, vw - p.width - EDGE_PAD),
      );

      setPos((prev) =>
        prev && prev.top === top && prev.left === left ? prev : { top, left },
      );
    }

    reposition();

    const ro = new ResizeObserver(reposition);
    ro.observe(popover);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [anchorRef]);

  // Close on Escape + click-outside.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (anchorRef.current && anchorRef.current.contains(t)) return;
      if (popoverRef.current && popoverRef.current.contains(t)) return;
      const element = t instanceof Element ? t : t.parentElement;
      const clickedPopover = element?.closest<HTMLElement>(
        "[data-notes-popover-lineage]",
      );
      if (
        clickedPopover?.dataset.notesPopoverLineage
          ?.split(" ")
          .includes(popoverId)
      ) {
        return;
      }
      onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose, anchorRef, popoverId]);

  async function handleDelete(noteId: Id<"notes">) {
    if (!window.confirm("Delete this note? This cannot be undone.")) return;
    setErr(null);
    try {
      await remove({ noteId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to delete note.");
    }
  }

  async function handleCycleTimer(noteId: Id<"notes">) {
    setErr(null);
    try {
      await cycleTimer({ noteId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to cycle timer.");
    }
  }

  return createPortal(
    <NotesPopoverContext.Provider value={{ lineage: popoverLineage }}>
      <div
        ref={popoverRef}
        role="dialog"
        aria-label={`Notes for ${label}`}
        className="notes-popover"
        data-notes-popover-lineage={popoverLineage.join(" ")}
        style={{
          // Pre-measure: render off-screen so the popover can size itself
          // before we know where to put it; the `useLayoutEffect` above
          // runs synchronously before paint and replaces these with real
          // coords, so users never see the off-screen frame.
          top: pos ? pos.top : -9999,
          left: pos ? pos.left : -9999,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        <div className="notes-popover-header">
          <strong>Notes</strong>
          <span className="muted" style={{ fontSize: "0.8rem" }}>
            {label}
          </span>
          <button
            type="button"
            className="secondary"
            onClick={onClose}
            aria-label="Close notes"
            style={{ marginLeft: "auto", padding: "0.25rem 0.5rem" }}
          >
            ✕
          </button>
        </div>

        <div className="notes-popover-list">
          <NoteList
            gameId={gameId}
            notes={notes}
            onDelete={handleDelete}
            onCycleTimer={handleCycleTimer}
            hideManagementControls={hideManagementControls}
          />
        </div>

        {err && <div className="error-text">{err}</div>}

        <NoteCreateForm
          gameId={gameId}
          target={target}
          className="notes-popover-form"
          timerEligible={timerCtx?.timerEligible ?? false}
        />
      </div>
    </NotesPopoverContext.Provider>,
    document.body,
  );
}

/**
 * Layout-agnostic list of notes. Identical visual treatment as the popover
 * version, but rendered wherever the caller drops it (no positioning).
 *
 * Pass `notes={undefined}` while the underlying query is loading; the
 * component will render a "Loading…" placeholder and avoid flashing the
 * empty state. `onDelete` is called only when `note.canDelete` is true; the
 * caller is responsible for confirming + invoking the delete mutation.
 *
 * `onCycleTimer` is called when the GM clicks a note's timer cell. Pass
 * `undefined` (or omit) when the surrounding context cannot cycle
 * timers (e.g. read-only previews); the cell will still render but be
 * a no-op when clicked. Player payloads never carry `timer`, so the
 * cell never renders for them regardless of this prop.
 */
export function NoteList({
  gameId,
  notes,
  onDelete,
  onCycleTimer,
  hideManagementControls = false,
}: {
  gameId: Id<"games">;
  notes: NoteListItem[] | undefined;
  onDelete: (noteId: Id<"notes">) => void | Promise<void>;
  onCycleTimer?: (noteId: Id<"notes">) => void | Promise<void>;
  /**
   * When `true`, hides the "Delete" button on each listed note. Used by
   * the per-game "Hide management controls" toggle so GMs can show the
   * notes UI without exposing destructive affordances.
   *
   * Note: the timer cell is intentionally NOT gated by this flag — the
   * timer is gameplay state, not a destructive management affordance,
   * so it remains clickable while management controls are hidden
   * (per the v1 spec).
   */
  hideManagementControls?: boolean;
}) {
  const noteCounts = useNotesCountMap(gameId);
  if (notes === undefined) {
    return <div className="muted">Loading…</div>;
  }
  if (notes.length === 0) {
    return <div className="muted">No notes yet.</div>;
  }
  return (
    <>
      {notes.map((n) => {
        // Design 19 (terminal prefix bar): the GM-only roll + timer
        // readout renders as a full-bleed black mono strip across the
        // top of the note card (`skill 7/4 OK  chaos 5  clk 04:32`)
        // instead of a tall stacked cell row below the body. The server
        // omits `attachedRolls` / `timer` entirely for non-GMs, so the
        // bar never renders for Players.
        //
        // Edge case: a note may carry a `timer` with no `attachedRolls`
        // (in theory; gating prevents it in practice) — render the
        // terminal-variant timer on its own in the bar.
        const timerEl =
          n.timer !== undefined ? (
            <NoteTimerCell
              timer={n.timer}
              viewerIsGm={n.canDelete}
              onCycle={onCycleTimer ? () => onCycleTimer(n._id) : undefined}
              variant="terminal"
            />
          ) : null;

        const terminalBar =
          n.attachedRolls !== undefined || n.timer !== undefined ? (
            <div className="note-terminal-bar" aria-label="Dice rolls (GM)">
              {n.attachedRolls !== undefined ? (
                <RollSetDisplay
                  rolls={n.attachedRolls}
                  variant="terminal"
                  trailing={timerEl}
                />
              ) : (
                timerEl
              )}
            </div>
          ) : null;

        return (
          <div key={n._id} className="note-item">
            {terminalBar}
            <div className="note-item-meta">
              <strong>{n.authorDisplayName}</strong>
              {n.isMine && <span className="muted"> (you)</span>}
              <span
                className={`badge ${n.visibility === "public" ? "accent" : ""}`}
                style={{ marginLeft: "0.5rem" }}
              >
                {n.visibility}
              </span>
              <span
                className="muted"
                title={new Date(n.createdAt).toLocaleString()}
                style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}
              >
                {new Date(n.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className="note-item-actions">
                <NoteIcon
                  gameId={gameId}
                  target={{ kind: "note", noteId: n._id }}
                  count={resolveNoteCount(noteCounts, {
                    kind: "note",
                    noteId: n._id,
                  })}
                  label={`note by ${n.authorDisplayName}`}
                  hideManagementControls={hideManagementControls}
                  variant="reply"
                />
                {n.canDelete && !hideManagementControls && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => void onDelete(n._id)}
                    style={{
                      padding: "0.125rem 0.5rem",
                      fontSize: "0.8rem",
                    }}
                  >
                    Delete
                  </button>
                )}
              </span>
            </div>
            <div className="note-item-body">{n.body}</div>
          </div>
        );
      })}
    </>
  );
}

/**
 * Layout-agnostic create form. Self-contained: owns its body + visibility
 * state, posts to `api.notes.createNote`, and resets on success. Uses
 * `useId()` for textarea + visibility ids so multiple instances on the
 * page (popover + Current Call section) never collide.
 *
 * Defaults visibility to `private`, matching the popover's behaviour.
 */
export function NoteCreateForm({
  gameId,
  target,
  className,
  timerEligible = false,
}: {
  gameId: Id<"games">;
  target: NoteTarget;
  className?: string;
  /**
   * Note timers v1: when `true`, render a row of duration buttons
   * (2/5/10/15/30 minutes) next to the "Post" submit. Each button
   * submits the note in one shot with `timerMinutes` set, which the
   * server validates against the same eligibility rule before
   * persisting. Caller is expected to derive this flag from
   * `api.notes.getTimerCreateContext` so the gate is GM-only and
   * requires the target to be the current head minion. The server
   * re-validates so a forged client cannot bypass the gate.
   */
  timerEligible?: boolean;
}) {
  const create = useMutation(api.notes.createNote);
  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reactId = useId();
  const bodyId = `note-body-${reactId}`;
  const visibilityId = `note-visibility-${reactId}`;

  async function submit(timerMinutes?: number) {
    setErr(null);
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      setErr("Note body cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      await create({
        gameId,
        targetKind: target.kind,
        targetSyndicateId:
          target.kind === "syndicate" ? target.syndicateId : undefined,
        targetMinionId: target.kind === "minion" ? target.minionId : undefined,
        targetGrantId: target.kind === "grant" ? target.grantId : undefined,
        targetGoalId: target.kind === "goal" ? target.goalId : undefined,
        targetAnnouncementId:
          target.kind === "announcement" ? target.announcementId : undefined,
        targetNoteId: target.kind === "note" ? target.noteId : undefined,
        body: trimmed,
        visibility,
        ...(timerMinutes !== undefined ? { timerMinutes } : {}),
      });
      setBody("");
      setVisibility("private");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to post note.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className={className}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={bodyId} style={{ marginBottom: "0.25rem" }}>
        New note
      </label>
      <textarea
        id={bodyId}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={2000}
        rows={3}
        placeholder="Add a note (immutable once posted)…"
      />
      <div
        className="row"
        style={{ justifyContent: "space-between", marginTop: "0.5rem" }}
      >
        <label
          htmlFor={visibilityId}
          style={{ margin: 0, display: "flex", gap: "0.25rem" }}
        >
          <input
            id={visibilityId}
            type="checkbox"
            checked={visibility === "public"}
            onChange={(e) =>
              setVisibility(e.target.checked ? "public" : "private")
            }
          />
          <span style={{ color: "var(--fg)" }}>Public</span>
        </label>
        <div className="row" style={{ gap: "0.25rem", flexWrap: "wrap" }}>
          {/* Note timers v1: GM-only duration buttons. Each submits the
              form in one shot with `timerMinutes` set. The label is
              just the number of minutes per the spec. The "Post"
              button remains for the no-timer path. Server re-validates
              eligibility regardless of which button was used. */}
          {timerEligible &&
            TIMER_PRESET_MINUTES.map((mins) => (
              <button
                key={mins}
                type="button"
                disabled={busy || body.trim().length === 0}
                onClick={() => void submit(mins)}
                title={`Post with ${mins}-minute timer`}
                aria-label={`Post with ${mins}-minute timer`}
              >
                {mins}
              </button>
            ))}
          <button type="submit" disabled={busy || body.trim().length === 0}>
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
      {err && <div className="error-text">{err}</div>}
      <div className="muted" style={{ fontSize: "0.75rem" }}>
        Notes cannot be edited. Only the GM can delete notes.
      </div>
    </form>
  );
}

/**
 * Build the args object for `api.notes.listNotesForTarget` from a
 * `NoteTarget`. Re-exported so callers outside the popover construct
 * list-query args identically.
 */
export function buildListArgs(gameId: Id<"games">, target: NoteTarget) {
  if (target.kind === "game") {
    return { gameId, targetKind: "game" as const };
  }
  if (target.kind === "syndicate") {
    return {
      gameId,
      targetKind: "syndicate" as const,
      targetSyndicateId: target.syndicateId,
    };
  }
  if (target.kind === "minion") {
    return {
      gameId,
      targetKind: "minion" as const,
      targetMinionId: target.minionId,
    };
  }
  if (target.kind === "grant") {
    return {
      gameId,
      targetKind: "grant" as const,
      targetGrantId: target.grantId,
    };
  }
  if (target.kind === "goal") {
    return {
      gameId,
      targetKind: "goal" as const,
      targetGoalId: target.goalId,
    };
  }
  if (target.kind === "note") {
    return {
      gameId,
      targetKind: "note" as const,
      targetNoteId: target.noteId,
    };
  }
  return {
    gameId,
    targetKind: "announcement" as const,
    targetAnnouncementId: target.announcementId,
  };
}
