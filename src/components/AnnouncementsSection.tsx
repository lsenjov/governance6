import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { resolveNoteCount, useNotesCountMap } from "../hooks/useNotesCountMap";
import {
  announcementNoteLabel,
  formatAnnouncementOrdinal,
} from "../lib/announcementPresentation";
import { NoteIcon } from "./NoteIcon";

type GameState = "ready" | "playing" | "archived";

export function AnnouncementsSection({
  gameId,
  gameState,
  viewerIsGm,
  hideManagementControls,
  noteCounts,
}: {
  gameId: Id<"games">;
  gameState: GameState;
  viewerIsGm: boolean;
  hideManagementControls: boolean;
  noteCounts: ReturnType<typeof useNotesCountMap>;
}) {
  const hiddenBeforePlay = !viewerIsGm && gameState === "ready";
  const data = useQuery(
    api.announcements.listAnnouncementsForGame,
    hiddenBeforePlay ? "skip" : { gameId },
  );

  if (hiddenBeforePlay) return null;
  if (!viewerIsGm && data !== undefined && data.announcements.length === 0) {
    return null;
  }

  const showManagement = data?.canManage === true && !hideManagementControls;

  return (
    <section className="announcements-section" aria-labelledby="announcements">
      <div className="announcements-heading">
        <div>
          <div className="section-label">Official record</div>
          <h3 id="announcements">Announcements</h3>
        </div>
        <span className="muted announcement-total">
          {data ? `${data.announcements.length} total` : ""}
        </span>
      </div>

      {showManagement && <NewAnnouncementForm gameId={gameId} />}

      {data === undefined ? (
        <div className="muted">Loading…</div>
      ) : data.announcements.length === 0 ? (
        <div className="announcements-empty">
          {showManagement
            ? "No announcements yet. Issue one when the table needs a shared directive."
            : "No announcements yet."}
        </div>
      ) : (
        <div className="announcement-list">
          {data.announcements.map((announcement, index) => (
            <AnnouncementRow
              key={announcement._id}
              announcement={announcement}
              index={index}
              gameId={gameId}
              showManagement={showManagement}
              hideManagementControls={hideManagementControls}
              noteCount={resolveNoteCount(noteCounts, {
                kind: "announcement",
                announcementId: announcement._id,
              })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function NewAnnouncementForm({ gameId }: { gameId: Id<"games"> }) {
  const create = useMutation(api.announcements.createAnnouncement);
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    if (body.trim().length === 0) {
      setErr("Announcement body cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      await create({ gameId, body });
      setBody("");
      setOpen(false);
    } catch (error) {
      setErr(
        error instanceof Error
          ? error.message
          : "Failed to create announcement.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="announcement-new-button"
        onClick={() => setOpen(true)}
      >
        + New Announcement
      </button>
    );
  }

  return (
    <form className="announcement-form" onSubmit={(e) => void submit(e)}>
      <label htmlFor="new-announcement-body">Announcement body</label>
      <textarea
        id="new-announcement-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        maxLength={2000}
        autoFocus
        placeholder="Issue a directive to everyone in the game…"
      />
      <div className="announcement-form-footer">
        <span className="muted tabular">{body.length}/2000</span>
        <button type="submit" disabled={busy || body.trim().length === 0}>
          {busy ? "Issuing…" : "Issue"}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={() => {
            setBody("");
            setErr(null);
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
      {err && <div className="error-text">{err}</div>}
    </form>
  );
}

function AnnouncementRow({
  announcement,
  index,
  gameId,
  showManagement,
  hideManagementControls,
  noteCount,
}: {
  announcement: {
    _id: Id<"announcements">;
    body: string;
    createdAt: number;
  };
  index: number;
  gameId: Id<"games">;
  showManagement: boolean;
  hideManagementControls: boolean;
  noteCount: number;
}) {
  const update = useMutation(api.announcements.updateAnnouncement);
  const remove = useMutation(api.announcements.deleteAnnouncement);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(announcement.body);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    if (body.trim().length === 0) {
      setErr("Announcement body cannot be empty.");
      return;
    }
    setBusy(true);
    try {
      await update({ announcementId: announcement._id, body });
      setEditing(false);
    } catch (error) {
      setErr(
        error instanceof Error
          ? error.message
          : "Failed to update announcement.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (
      !window.confirm(
        "Delete this announcement and all notes attached to it? This cannot be undone.",
      )
    ) {
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await remove({ announcementId: announcement._id });
    } catch (error) {
      setErr(
        error instanceof Error
          ? error.message
          : "Failed to delete announcement.",
      );
      setBusy(false);
    }
  }

  const ordinal = formatAnnouncementOrdinal(index);

  return (
    <article className="announcement-row">
      <div className="announcement-ordinal" aria-hidden="true">
        {ordinal}
      </div>
      <div className="announcement-content">
        <div className="announcement-row-header">
          <span className="section-label">General circulation</span>
          <NoteIcon
            gameId={gameId}
            target={{
              kind: "announcement",
              announcementId: announcement._id,
            }}
            count={noteCount}
            label={announcementNoteLabel(index, announcement.body)}
            hideManagementControls={hideManagementControls}
          />
          {showManagement && (
            <span className="announcement-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setBody(announcement.body);
                  setErr(null);
                  setEditing((value) => !value);
                }}
              >
                {editing ? "Cancel" : "Edit"}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => void handleDelete()}
              >
                Delete
              </button>
            </span>
          )}
        </div>

        {editing && showManagement ? (
          <form
            className="announcement-edit-form"
            onSubmit={(e) => void save(e)}
          >
            <label htmlFor={`announcement-${announcement._id}`}>
              Revise announcement
            </label>
            <textarea
              id={`announcement-${announcement._id}`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              maxLength={2000}
              autoFocus
            />
            <div className="announcement-form-footer">
              <span className="muted tabular">{body.length}/2000</span>
              <button type="submit" disabled={busy || body.trim().length === 0}>
                {busy ? "Saving…" : "Save revision"}
              </button>
            </div>
          </form>
        ) : (
          <p className="announcement-body">{announcement.body}</p>
        )}

        {err && <div className="error-text">{err}</div>}
      </div>
    </article>
  );
}
