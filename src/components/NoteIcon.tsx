import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type NoteTarget =
  | { kind: "game" }
  | { kind: "syndicate"; syndicateId: Id<"syndicates"> }
  | { kind: "minion"; minionId: Id<"minions"> };

type NoteIconProps = {
  gameId: Id<"games">;
  target: NoteTarget;
  count: number;
  label: string; // Accessible label describing what the icon annotates.
};

/**
 * Small speech-bubble button that toggles a NotesPopover for a given target.
 * Designed to sit inline next to a title/row.
 */
export function NoteIcon({ gameId, target, count, label }: NoteIconProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={anchorRef}
      style={{ position: "relative", display: "inline-block" }}
    >
      <button
        type="button"
        className="note-icon-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Notes: ${label}${count > 0 ? ` (${count})` : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        <NoteGlyph />
        {count > 0 && <span className="note-icon-badge">{count}</span>}
      </button>
      {open && (
        <NotesPopover
          gameId={gameId}
          target={target}
          label={label}
          onClose={() => setOpen(false)}
          anchorRef={anchorRef}
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
};

function NotesPopover({
  gameId,
  target,
  label,
  onClose,
  anchorRef,
}: PopoverProps) {
  const queryArgs = buildListArgs(gameId, target);
  const notes = useQuery(api.notes.listNotesForTarget, queryArgs);
  const create = useMutation(api.notes.createNote);
  const remove = useMutation(api.notes.deleteNote);

  const [body, setBody] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Close on Escape + click-outside.
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (anchorRef.current && anchorRef.current.contains(t)) return;
      if (popoverRef.current && popoverRef.current.contains(t)) return;
      onClose();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onClose, anchorRef]);

  async function submit() {
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
        body: trimmed,
        visibility,
      });
      setBody("");
      setVisibility("private");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to post note.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(noteId: Id<"notes">) {
    if (!window.confirm("Delete this note? This cannot be undone.")) return;
    setErr(null);
    try {
      await remove({ noteId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to delete note.");
    }
  }

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={`Notes for ${label}`}
      className="notes-popover"
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
        {notes === undefined && <div className="muted">Loading…</div>}
        {notes && notes.length === 0 && (
          <div className="muted">No notes yet.</div>
        )}
        {notes?.map((n) => (
          <div key={n._id} className="note-item">
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
                style={{ marginLeft: "0.5rem", fontSize: "0.8rem" }}
              >
                {new Date(n.createdAt).toLocaleString()}
              </span>
              {n.canDelete && (
                <button
                  type="button"
                  className="danger"
                  onClick={() => void handleDelete(n._id)}
                  style={{
                    marginLeft: "auto",
                    padding: "0.125rem 0.5rem",
                    fontSize: "0.8rem",
                  }}
                >
                  Delete
                </button>
              )}
            </div>
            <div className="note-item-body">{n.body}</div>
          </div>
        ))}
      </div>

      <form
        className="notes-popover-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="note-body" style={{ marginBottom: "0.25rem" }}>
          New note
        </label>
        <textarea
          id="note-body"
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
            htmlFor="note-visibility"
            style={{ margin: 0, display: "flex", gap: "0.25rem" }}
          >
            <input
              id="note-visibility"
              type="checkbox"
              checked={visibility === "public"}
              onChange={(e) =>
                setVisibility(e.target.checked ? "public" : "private")
              }
            />
            <span style={{ color: "var(--fg)" }}>Public</span>
          </label>
          <button type="submit" disabled={busy || body.trim().length === 0}>
            {busy ? "Posting…" : "Post"}
          </button>
        </div>
        {err && <div className="error-text">{err}</div>}
        <div className="muted" style={{ fontSize: "0.75rem" }}>
          Notes cannot be edited. Only the GM can delete notes.
        </div>
      </form>
    </div>
  );
}

function buildListArgs(gameId: Id<"games">, target: NoteTarget) {
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
  return {
    gameId,
    targetKind: "minion" as const,
    targetMinionId: target.minionId,
  };
}
