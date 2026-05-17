import { useState, useId } from "react";
import type { FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";

/**
 * Per-Syndicate cap on the union of skill names across every Minion.
 * Must match `MAX_UNIQUE_SYNDICATE_SKILLS` in `convex/minions.ts`.
 */
const MAX_UNIQUE_SYNDICATE_SKILLS = 13;

/**
 * Above this length, a drawback/minion description is rendered as a
 * separate `colspan` row beneath the row's compact summary so the
 * prose has full table width to breathe. See plan Task 7.
 */
const LONG_DESCRIPTION_THRESHOLD = 80;

function uniqueSkillCount(skillLists: string[][]): number {
  const seen = new Set<string>();
  for (const list of skillLists) {
    for (const s of list) {
      const t = s.trim().toLowerCase();
      if (t.length > 0) seen.add(t);
    }
  }
  return seen.size;
}

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
      <Link
        to={data.isAdminView ? "/admin/syndicates" : "/syndicates"}
        className="muted"
      >
        {data.isAdminView
          ? "← Back to All Syndicates"
          : "← Back to My Syndicates"}
      </Link>
      <div className="row-wrap" style={{ marginTop: "0.5rem" }}>
        <h2 style={{ marginRight: "auto" }}>{data.name}</h2>
        {data.played && <span className="badge warning">Played (frozen)</span>}
        {data.isShared && <span className="badge accent">Shared</span>}
      </div>
      {data.isAdminView && (
        <div className="muted" style={{ fontSize: "0.9rem" }}>
          Owner: {data.ownerName ?? "Unknown"}
        </div>
      )}

      {data.isAdminView && data.canEdit && (
        <div
          className="read-only-banner"
          style={{ borderLeftColor: "var(--accent, currentColor)" }}
        >
          Editing as site admin — owned by {data.ownerName ?? "Unknown"}.
          Changes apply to that user's syndicate.
        </div>
      )}

      {!data.canEdit && (
        <div className="read-only-banner">
          {data.played
            ? "This Syndicate has been played and is permanently read-only."
            : "Read-only view (you are not the owner)."}
        </div>
      )}

      <SyndicateCore syndicate={data} canEdit={data.canEdit} />

      <div className="stack" style={{ marginTop: "1.5rem" }}>
        <section>
          <h3>Drawbacks ({data.drawbacks.length}/5)</h3>
          <DrawbacksEditor
            syndicateId={sid}
            drawbacks={data.drawbacks}
            canEdit={data.canEdit}
          />
        </section>

        <section>
          <h3>Minions ({data.minions.length}/8)</h3>
          <MinionsEditor
            syndicateId={sid}
            minions={data.minions}
            canEdit={data.canEdit}
          />
        </section>
      </div>
    </div>
  );
}

function SyndicateCore({
  syndicate,
  canEdit,
}: {
  syndicate: Doc<"syndicates">;
  canEdit: boolean;
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
        {canEdit && (
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

/**
 * Drawback editor.
 *
 * The user-visible surface stays exactly `(name, description)` for both
 * creation and existing-row editing — no abbreviation input, no
 * "Rolled when called" checkbox is rendered. The schema-level
 * `abbreviation` and `isRolled` fields are populated invisibly when
 * (and only when) the user picks a name that exactly matches a preset
 * drawback (case-insensitive). On submit, the editor passes all four
 * fields to `api.drawbacks.create`; existing-row edits send only
 * `(name, description)` so the persisted abbreviation/isRolled
 * remain at their preset-frozen creation values.
 *
 * To grant a free-form drawback rolling behaviour, an admin must add it
 * to the preset catalogue (Admin page) and the owner must delete and
 * re-create the row.
 */
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
  // Subscribe to the preset-drawback catalogue. Every authenticated
  // user can read it (admin-only writes are gated server-side).
  const presetDrawbacks = useQuery(api.presetDrawbacks.list);
  const presetListId = useId();
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<Id<"drawbacks"> | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Find the preset row whose name matches the typed name
  // (case-insensitive). Used to silently carry abbreviation+isRolled
  // through to the create mutation without surfacing them in the UI.
  const matchedPreset = (() => {
    if (!presetDrawbacks) return null;
    const lower = newName.trim().toLowerCase();
    if (lower.length === 0) return null;
    return presetDrawbacks.find((p) => p.name.toLowerCase() === lower) ?? null;
  })();

  // When the typed name matches a preset and the description is empty
  // or whitespace-only, prefill the description from the preset.
  // Guarded against clobbering user-entered prose: once the user
  // types into description, subsequent matches do NOT overwrite it.
  function handleNameChange(value: string) {
    setNewName(value);
    if (!presetDrawbacks) return;
    const lower = value.trim().toLowerCase();
    if (lower.length === 0) return;
    const preset = presetDrawbacks.find((p) => p.name.toLowerCase() === lower);
    if (preset && newDesc.trim().length === 0) {
      setNewDesc(preset.description);
    }
  }

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    try {
      // Pipe abbreviation+isRolled through ONLY when the typed name
      // exactly matches a preset. Free-form rows pass `undefined`,
      // letting the schema's optionals default to absent / `false`.
      if (matchedPreset) {
        await create({
          syndicateId,
          name: newName,
          description: newDesc,
          abbreviation: matchedPreset.abbreviation ?? undefined,
          isRolled: matchedPreset.isRolled ?? false,
        });
      } else {
        await create({ syndicateId, name: newName, description: newDesc });
      }
      setNewName("");
      setNewDesc("");
      setShowForm(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed to add.");
    }
  }

  const colCount = canEdit ? 3 : 2;
  const showFooter = canEdit && drawbacks.length < 5;

  return (
    <div className="table-scroll">
      <table className="drawback-table">
        <caption>
          <strong>{drawbacks.length}</strong>/5 drawbacks
        </caption>
        <thead>
          <tr>
            <th>Name</th>
            <th>Description</th>
            {canEdit && <th aria-label="Actions"></th>}
          </tr>
        </thead>
        {drawbacks.length === 0 ? (
          <tbody>
            <tr>
              <td colSpan={colCount} className="muted">
                No drawbacks yet.
              </td>
            </tr>
          </tbody>
        ) : (
          drawbacks.map((d) => {
            const isEditing = editingId === d._id;
            const longDesc =
              d.description.trim().length > LONG_DESCRIPTION_THRESHOLD;
            return (
              <tbody key={d._id} className={isEditing ? "editing" : undefined}>
                {isEditing ? (
                  <tr aria-label={`Edit drawback: ${d.name}`}>
                    <td className="editor-cell" colSpan={colCount}>
                      <DrawbackEditForm
                        key={d._id}
                        drawback={d}
                        onCancel={() => setEditingId(null)}
                        onSave={async (patch) => {
                          await update({ drawbackId: d._id, ...patch });
                          setEditingId(null);
                        }}
                        onDelete={async () => {
                          await remove({ drawbackId: d._id });
                          setEditingId(null);
                        }}
                      />
                    </td>
                  </tr>
                ) : longDesc ? (
                  <>
                    <tr>
                      <td style={{ fontWeight: 600 }}>{d.name}</td>
                      <td></td>
                      {canEdit && (
                        <td className="actions">
                          <div className="row-wrap" style={{ gap: "0.5rem" }}>
                            <button
                              type="button"
                              onClick={() => setEditingId(d._id)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() => void remove({ drawbackId: d._id })}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                    <tr className="description-row">
                      <td colSpan={colCount}>{d.description}</td>
                    </tr>
                  </>
                ) : (
                  <tr>
                    <td style={{ fontWeight: 600 }}>{d.name}</td>
                    <td style={{ whiteSpace: "pre-wrap" }}>
                      {d.description.trim().length > 0 ? (
                        d.description
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    {canEdit && (
                      <td className="actions">
                        <div className="row-wrap" style={{ gap: "0.5rem" }}>
                          <button
                            type="button"
                            onClick={() => setEditingId(d._id)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => void remove({ drawbackId: d._id })}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                )}
              </tbody>
            );
          })
        )}
        {showFooter && (
          <tfoot>
            <tr>
              <td className="editor-cell" colSpan={colCount}>
                {!showForm ? (
                  <div className="add-row-bar">
                    <button type="button" onClick={() => setShowForm(true)}>
                      Add Drawback
                    </button>
                  </div>
                ) : (
                  <form
                    onSubmit={handleCreate}
                    className="card tight stack"
                    style={{ margin: 0 }}
                  >
                    {presetDrawbacks && presetDrawbacks.length > 0 && (
                      <datalist id={presetListId}>
                        {presetDrawbacks.map((p) => (
                          <option key={p._id} value={p.name} />
                        ))}
                      </datalist>
                    )}
                    <input
                      value={newName}
                      onChange={(e) => handleNameChange(e.target.value)}
                      required
                      maxLength={120}
                      list={
                        presetDrawbacks && presetDrawbacks.length > 0
                          ? presetListId
                          : undefined
                      }
                      aria-label="New drawback name"
                      placeholder="Drawback name"
                      autoFocus
                      style={{ width: "100%" }}
                    />
                    <textarea
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      rows={2}
                      aria-label="New drawback description"
                      placeholder="Description"
                      style={{ width: "100%" }}
                    />
                    {err && <div className="error-text">{err}</div>}
                    <div className="row-wrap">
                      <button type="submit">Add Drawback</button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setShowForm(false);
                          setErr(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                )}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function DrawbackEditForm({
  drawback,
  onCancel,
  onSave,
  onDelete,
}: {
  drawback: DrawbackDoc;
  onCancel: () => void;
  onSave: (patch: { name: string; description: string }) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
}) {
  const [name, setName] = useState(drawback.name);
  const [description, setDescription] = useState(drawback.description);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setErr(null);
    setSaved(false);
    try {
      await onSave({ name, description });
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    }
  }

  return (
    <div className="card tight stack" style={{ margin: 0 }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
        aria-label="Drawback name"
        placeholder="Drawback name"
        autoFocus
        style={{ width: "100%", fontWeight: 600 }}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        aria-label="Drawback description"
        placeholder="Description"
        style={{ width: "100%" }}
      />
      {err && <div className="error-text">{err}</div>}
      {saved && <div className="success-text">Saved.</div>}
      <div className="row-wrap">
        <button type="button" onClick={() => void handleSave()}>
          Save
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void onDelete()}
        >
          Delete
        </button>
      </div>
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
  const presetSkills = useQuery(api.presetSkills.list);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<Id<"minions"> | null>(null);

  const presetNames = presetSkills?.map((s) => s.name) ?? [];
  const uniqueUsed = uniqueSkillCount(minions.map((m) => m.skills));
  const overCap = uniqueUsed > MAX_UNIQUE_SYNDICATE_SKILLS;

  const colCount = canEdit ? 5 : 4;
  const showFooter = canEdit && minions.length < 8;

  return (
    <div className="table-scroll">
      <table className="minion-table">
        <caption>
          Unique skills used across all Minions:{" "}
          <strong className={overCap ? "over-cap" : undefined}>
            {uniqueUsed}
          </strong>
          /{MAX_UNIQUE_SYNDICATE_SKILLS}
        </caption>
        <thead>
          <tr>
            <th>Name</th>
            <th>Accent</th>
            <th>Description</th>
            <th>Skills</th>
            {canEdit && <th aria-label="Actions"></th>}
          </tr>
        </thead>
        {minions.length === 0 ? (
          <tbody>
            <tr>
              <td colSpan={colCount} className="muted">
                No Minions yet.
              </td>
            </tr>
          </tbody>
        ) : (
          minions.map((m) => {
            const isEditing = editingId === m._id;
            const desc = (m.description ?? "").trim();
            const longDesc = desc.length > LONG_DESCRIPTION_THRESHOLD;
            const hasDesc = desc.length > 0;
            const skillsTrimmed = m.skills
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            return (
              <tbody key={m._id} className={isEditing ? "editing" : undefined}>
                {isEditing ? (
                  <tr aria-label={`Edit minion: ${m.name}`}>
                    <td className="editor-cell" colSpan={colCount}>
                      <MinionEditForm
                        key={m._id}
                        minion={m}
                        presetSkillNames={presetNames}
                        onCancel={() => setEditingId(null)}
                        onSave={async (patch) => {
                          await update({ minionId: m._id, ...patch });
                          setEditingId(null);
                        }}
                        onDelete={async () => {
                          await remove({ minionId: m._id });
                          setEditingId(null);
                        }}
                      />
                    </td>
                  </tr>
                ) : longDesc ? (
                  <>
                    <tr>
                      <td style={{ fontWeight: 600 }}>{m.name}</td>
                      <td>
                        {m.accent ? m.accent : <span className="muted">—</span>}
                      </td>
                      <td></td>
                      <td>
                        <SkillChipList skills={skillsTrimmed} />
                      </td>
                      {canEdit && (
                        <td className="actions">
                          <div className="row-wrap" style={{ gap: "0.5rem" }}>
                            <button
                              type="button"
                              onClick={() => setEditingId(m._id)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="danger"
                              onClick={() => void remove({ minionId: m._id })}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                    <tr className="description-row">
                      <td colSpan={colCount}>{m.description}</td>
                    </tr>
                  </>
                ) : (
                  <tr>
                    <td style={{ fontWeight: 600 }}>{m.name}</td>
                    <td>
                      {m.accent ? m.accent : <span className="muted">—</span>}
                    </td>
                    <td style={{ whiteSpace: "pre-wrap" }}>
                      {hasDesc ? (
                        m.description
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <SkillChipList skills={skillsTrimmed} />
                    </td>
                    {canEdit && (
                      <td className="actions">
                        <div className="row-wrap" style={{ gap: "0.5rem" }}>
                          <button
                            type="button"
                            onClick={() => setEditingId(m._id)}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={() => void remove({ minionId: m._id })}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                )}
              </tbody>
            );
          })
        )}
        {showFooter && (
          <tfoot>
            <tr>
              <td className="editor-cell" colSpan={colCount}>
                {!showForm ? (
                  <div className="add-row-bar">
                    <button type="button" onClick={() => setShowForm(true)}>
                      Add Minion
                    </button>
                  </div>
                ) : (
                  <NewMinionForm
                    presetSkillNames={presetNames}
                    onCancel={() => setShowForm(false)}
                    onSubmit={async (formData) => {
                      await create({ syndicateId, ...formData });
                      setShowForm(false);
                    }}
                  />
                )}
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function SkillChipList({ skills }: { skills: string[] }) {
  if (skills.length === 0) {
    return <span className="muted">no skills</span>;
  }
  return (
    <div className="skill-chip-list">
      {skills.map((s, i) => (
        <span className="skill-chip" key={i}>
          {s}
        </span>
      ))}
    </div>
  );
}

function NewMinionForm({
  onSubmit,
  onCancel,
  presetSkillNames,
}: {
  onSubmit: (data: {
    name: string;
    accent?: string;
    description?: string;
    skills: string[];
  }) => Promise<void>;
  onCancel: () => void;
  presetSkillNames: string[];
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
    <form
      onSubmit={handleSubmit}
      className="card tight stack"
      style={{ margin: 0 }}
    >
      <h4 style={{ margin: 0 }}>New Minion</h4>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={120}
        aria-label="Minion name"
        placeholder="Name *"
        autoFocus
        style={{ width: "100%" }}
      />
      <input
        value={accent}
        onChange={(e) => setAccent(e.target.value)}
        maxLength={40}
        aria-label="Minion accent"
        placeholder="Accent (optional, ≤40 chars)"
        style={{ width: "100%" }}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        aria-label="Minion description"
        placeholder="Description (optional)"
        style={{ width: "100%" }}
      />
      <SkillsField
        skills={skills}
        onChange={setSkills}
        presetSkillNames={presetSkillNames}
      />
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

function MinionEditForm({
  minion,
  onCancel,
  onSave,
  onDelete,
  presetSkillNames,
}: {
  minion: MinionDoc;
  onCancel: () => void;
  onSave: (patch: {
    name: string;
    accent?: string;
    description?: string;
    skills: string[];
  }) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  presetSkillNames: string[];
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
    <div className="card tight stack" style={{ margin: 0 }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
        aria-label="Minion name"
        placeholder="Name"
        autoFocus
        style={{ width: "100%", fontWeight: 600 }}
      />
      <input
        value={accent}
        onChange={(e) => setAccent(e.target.value)}
        maxLength={40}
        aria-label="Minion accent"
        placeholder="Accent"
        style={{ width: "100%" }}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        aria-label="Minion description"
        placeholder="Description"
        style={{ width: "100%" }}
      />
      <SkillsField
        skills={skills}
        onChange={setSkills}
        presetSkillNames={presetSkillNames}
      />
      {err && <div className="error-text">{err}</div>}
      {saved && <div className="success-text">Saved.</div>}
      <div className="row-wrap">
        <button type="button" onClick={() => void handleSave()}>
          Save
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void onDelete()}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function SkillsField({
  skills,
  onChange,
  disabled,
  presetSkillNames,
}: {
  skills: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  presetSkillNames: string[];
}) {
  // Stable id shared by all skill inputs in this instance so the datalist
  // autocomplete is scoped to this form.
  const listId = useId();
  return (
    <div>
      <label>Skills (1–5)</label>
      {presetSkillNames.length > 0 && (
        <datalist id={listId}>
          {presetSkillNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      )}
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
              list={presetSkillNames.length > 0 ? listId : undefined}
              placeholder="Skill name"
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
