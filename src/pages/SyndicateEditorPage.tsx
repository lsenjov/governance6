import { useState } from "react";
import type { FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";

export function SyndicateEditorPage() {
  const { syndicateId } = useParams<{ syndicateId: string }>();
  const sid = syndicateId as Id<"syndicates"> | undefined;
  const data = useQuery(
    api.syndicates.getWithChildren,
    sid ? { syndicateId: sid } : "skip",
  );

  if (!sid) return <div>Missing syndicate id.</div>;
  if (data === undefined) return <div className="muted">Loading…</div>;
  if (data === null) return <div>Syndicate not found or not accessible.</div>;

  return (
    <div>
      <Link to="/syndicates" className="muted">
        ← Back to My Syndicates
      </Link>
      <div className="row-wrap" style={{ marginTop: "0.5rem" }}>
        <h2 style={{ marginRight: "auto" }}>{data.name}</h2>
        {data.played && <span className="badge warning">Played (frozen)</span>}
        {data.isShared && <span className="badge accent">Shared</span>}
      </div>

      {!data.canEdit && (
        <div className="read-only-banner">
          {data.played
            ? "This Syndicate has been played and is permanently read-only."
            : "Read-only view (you are not the owner)."}
        </div>
      )}

      <SyndicateCore syndicate={data} canEdit={data.canEdit} isOwner={data.isOwner} />

      <section style={{ marginTop: "1.5rem" }}>
        <h3>Drawbacks ({data.drawbacks.length}/5)</h3>
        <DrawbacksEditor
          syndicateId={sid}
          drawbacks={data.drawbacks}
          canEdit={data.canEdit}
        />
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h3>Minions ({data.minions.length}/8)</h3>
        <MinionsEditor
          syndicateId={sid}
          minions={data.minions}
          canEdit={data.canEdit}
        />
      </section>
    </div>
  );
}

function SyndicateCore({
  syndicate,
  canEdit,
  isOwner,
}: {
  syndicate: Doc<"syndicates">;
  canEdit: boolean;
  isOwner: boolean;
}) {
  const update = useMutation(api.syndicates.update);
  const setIsShared = useMutation(api.syndicates.setIsShared);
  const [name, setName] = useState(syndicate.name);
  const [leader, setLeader] = useState(syndicate.leader);
  const [description, setDescription] = useState(syndicate.description);
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "ok" } | { kind: "err"; message: string }
  >({ kind: "idle" });

  async function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus({ kind: "idle" });
    try {
      await update({
        syndicateId: syndicate._id,
        name,
        leader,
        description,
      });
      setStatus({ kind: "ok" });
    } catch (err) {
      setStatus({
        kind: "err",
        message: err instanceof Error ? err.message : "Failed to save.",
      });
    }
  }

  async function handleShareToggle() {
    try {
      await setIsShared({
        syndicateId: syndicate._id,
        value: !syndicate.isShared,
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to toggle sharing.");
    }
  }

  return (
    <form onSubmit={handleSave} className="card stack">
      <div>
        <label htmlFor="edit-name">Name</label>
        <input
          id="edit-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          disabled={!canEdit}
          maxLength={120}
          style={{ width: "100%" }}
        />
      </div>
      <div>
        <label htmlFor="edit-leader">Leader</label>
        <input
          id="edit-leader"
          value={leader}
          onChange={(e) => setLeader(e.target.value)}
          required
          disabled={!canEdit}
          maxLength={120}
          style={{ width: "100%" }}
        />
      </div>
      <div>
        <label htmlFor="edit-desc">Description</label>
        <textarea
          id="edit-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          disabled={!canEdit}
          style={{ width: "100%" }}
        />
      </div>
      {status.kind === "err" && (
        <div className="error-text">{status.message}</div>
      )}
      {status.kind === "ok" && <div className="success-text">Saved.</div>}
      <div className="row-wrap">
        <button type="submit" disabled={!canEdit}>
          Save
        </button>
        {isOwner && canEdit && (
          <button
            type="button"
            className="secondary"
            onClick={() => void handleShareToggle()}
          >
            {syndicate.isShared ? "Make Private" : "Make Shared"}
          </button>
        )}
      </div>
    </form>
  );
}

type DrawbackDoc = Doc<"drawbacks">;

function DrawbacksEditor({
  syndicateId,
  drawbacks,
  canEdit,
}: {
  syndicateId: Id<"syndicates">;
  drawbacks: DrawbackDoc[];
  canEdit: boolean;
}) {
  const create = useMutation(api.drawbacks.create);
  const update = useMutation(api.drawbacks.update);
  const remove = useMutation(api.drawbacks.remove);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    try {
      await create({ syndicateId, name: newName, description: newDesc });
      setNewName("");
      setNewDesc("");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed to add.");
    }
  }

  return (
    <div className="stack">
      {drawbacks.length === 0 && (
        <div className="muted">No drawbacks yet.</div>
      )}
      {drawbacks.map((d) => (
        <DrawbackRow
          key={d._id}
          drawback={d}
          canEdit={canEdit}
          onSave={(name, description) =>
            update({ drawbackId: d._id, name, description })
          }
          onDelete={() => remove({ drawbackId: d._id })}
        />
      ))}
      {canEdit && drawbacks.length < 5 && (
        <form onSubmit={handleCreate} className="card stack">
          <div className="row-wrap">
            <div style={{ flex: 1 }}>
              <label>Drawback name</label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
                maxLength={120}
                style={{ width: "100%" }}
              />
            </div>
          </div>
          <div>
            <label>Description</label>
            <textarea
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              rows={2}
              style={{ width: "100%" }}
            />
          </div>
          {err && <div className="error-text">{err}</div>}
          <button type="submit">Add Drawback</button>
        </form>
      )}
    </div>
  );
}

function DrawbackRow({
  drawback,
  canEdit,
  onSave,
  onDelete,
}: {
  drawback: DrawbackDoc;
  canEdit: boolean;
  onSave: (name: string, description: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [name, setName] = useState(drawback.name);
  const [description, setDescription] = useState(drawback.description);
  const [err, setErr] = useState<string | null>(null);

  async function handleSave() {
    setErr(null);
    try {
      await onSave(name, description);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    }
  }

  return (
    <div className="card stack">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        disabled={!canEdit}
        maxLength={120}
        style={{ width: "100%", fontWeight: 600 }}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        disabled={!canEdit}
        style={{ width: "100%" }}
      />
      {err && <div className="error-text">{err}</div>}
      {canEdit && (
        <div className="row-wrap">
          <button type="button" onClick={() => void handleSave()}>
            Save
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void onDelete()}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

type MinionDoc = Doc<"minions">;

function MinionsEditor({
  syndicateId,
  minions,
  canEdit,
}: {
  syndicateId: Id<"syndicates">;
  minions: MinionDoc[];
  canEdit: boolean;
}) {
  const create = useMutation(api.minions.create);
  const update = useMutation(api.minions.update);
  const remove = useMutation(api.minions.remove);
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="stack">
      {minions.length === 0 && (
        <div className="muted">No Minions yet.</div>
      )}
      {minions.map((m) => (
        <MinionRow
          key={m._id}
          minion={m}
          canEdit={canEdit}
          onSave={(patch) => update({ minionId: m._id, ...patch })}
          onDelete={() => remove({ minionId: m._id })}
        />
      ))}
      {canEdit && minions.length < 8 && (
        <>
          {!showForm ? (
            <button type="button" onClick={() => setShowForm(true)}>
              Add Minion
            </button>
          ) : (
            <NewMinionForm
              onCancel={() => setShowForm(false)}
              onSubmit={async (data) => {
                await create({ syndicateId, ...data });
                setShowForm(false);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}

function NewMinionForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (data: {
    name: string;
    accent?: string;
    description?: string;
    skills: string[];
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [accent, setAccent] = useState("");
  const [description, setDescription] = useState("");
  const [skills, setSkills] = useState<string[]>([""]);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    try {
      await onSubmit({
        name,
        accent: accent.trim() || undefined,
        description: description || undefined,
        skills: skills.map((s) => s.trim()).filter((s) => s.length > 0),
      });
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed to create.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card stack">
      <h4 style={{ margin: 0 }}>New Minion</h4>
      <div>
        <label>Name *</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          style={{ width: "100%" }}
        />
      </div>
      <div>
        <label>Accent (optional, ≤40 chars)</label>
        <input
          value={accent}
          onChange={(e) => setAccent(e.target.value)}
          maxLength={40}
          style={{ width: "100%" }}
        />
      </div>
      <div>
        <label>Description (optional)</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          style={{ width: "100%" }}
        />
      </div>
      <SkillsField skills={skills} onChange={setSkills} />
      {err && <div className="error-text">{err}</div>}
      <div className="row-wrap">
        <button type="submit">Create Minion</button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function MinionRow({
  minion,
  canEdit,
  onSave,
  onDelete,
}: {
  minion: MinionDoc;
  canEdit: boolean;
  onSave: (patch: {
    name: string;
    accent?: string;
    description?: string;
    skills: string[];
  }) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [name, setName] = useState(minion.name);
  const [accent, setAccent] = useState(minion.accent ?? "");
  const [description, setDescription] = useState(minion.description ?? "");
  const [skills, setSkills] = useState<string[]>(minion.skills);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setErr(null);
    setSaved(false);
    try {
      await onSave({
        name,
        accent: accent.trim() || undefined,
        description: description || undefined,
        skills: skills.map((s) => s.trim()).filter((s) => s.length > 0),
      });
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    }
  }

  return (
    <div className="card stack">
      <div>
        <label>Name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canEdit}
          maxLength={120}
          style={{ width: "100%", fontWeight: 600 }}
        />
      </div>
      <div>
        <label>Accent</label>
        <input
          value={accent}
          onChange={(e) => setAccent(e.target.value)}
          disabled={!canEdit}
          maxLength={40}
          style={{ width: "100%" }}
        />
      </div>
      <div>
        <label>Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!canEdit}
          rows={2}
          style={{ width: "100%" }}
        />
      </div>
      <SkillsField
        skills={skills}
        onChange={setSkills}
        disabled={!canEdit}
      />
      {err && <div className="error-text">{err}</div>}
      {saved && <div className="success-text">Saved.</div>}
      {canEdit && (
        <div className="row-wrap">
          <button type="button" onClick={() => void handleSave()}>
            Save
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => void onDelete()}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function SkillsField({
  skills,
  onChange,
  disabled,
}: {
  skills: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <label>Skills (1–5)</label>
      <div className="stack">
        {skills.map((s, i) => (
          <div key={i} className="row" style={{ gap: "0.5rem" }}>
            <input
              value={s}
              onChange={(e) => {
                const next = [...skills];
                next[i] = e.target.value;
                onChange(next);
              }}
              disabled={disabled}
              maxLength={120}
              style={{ flex: 1 }}
            />
            {!disabled && skills.length > 1 && (
              <button
                type="button"
                className="secondary"
                onClick={() => onChange(skills.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {!disabled && skills.length < 5 && (
          <button
            type="button"
            className="secondary"
            onClick={() => onChange([...skills, ""])}
          >
            Add Skill
          </button>
        )}
      </div>
    </div>
  );
}
