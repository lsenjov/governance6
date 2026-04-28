import { useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";

/**
 * Site admin console.
 *
 * Gated on `users.isSiteAdmin`, which is only set directly in the Convex
 * database (no in-app UI grants it). Site admins manage the preset
 * skill list and the preset drawback catalogue. Users may still enter
 * skills and drawbacks that are not in either list.
 */
export function AdminPage() {
  const me = useQuery(api.users.getMe);
  const skills = useQuery(api.presetSkills.list);
  const drawbacks = useQuery(api.presetDrawbacks.list);

  if (me === undefined) return <div className="muted">Loading…</div>;
  if (me === null) return <div>Not signed in.</div>;
  if (!me.isSiteAdmin) {
    return (
      <div className="card">
        <h2>Admin</h2>
        <p className="muted">
          You do not have site admin privileges. Site admin access can only
          be granted directly from the database.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2>Site Admin</h2>
      <p className="muted">
        Manage the preset skill and drawback lists used by the editors'
        autocomplete. Users may still type values that are not in these lists.
      </p>

      <section>
        <h3>Preset skills ({skills?.length ?? 0})</h3>
        <AddPresetSkillForm />
        {skills === undefined ? (
          <div className="muted">Loading…</div>
        ) : skills.length === 0 ? (
          <div className="muted">No preset skills yet.</div>
        ) : (
          <div className="stack">
            {skills.map((s) => (
              <PresetSkillRow key={s._id} skill={s} />
            ))}
          </div>
        )}
      </section>

      <section style={{ marginTop: "1.5rem" }}>
        <h3>Preset drawbacks ({drawbacks?.length ?? 0})</h3>
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          The Syndicate editor uses these as autocomplete templates. Picking a
          preset prefills the drawback's description and silently carries the
          abbreviation and "rolled" flag onto the per-Syndicate row.
        </p>
        <AddPresetDrawbackForm />
        {drawbacks === undefined ? (
          <div className="muted">Loading…</div>
        ) : drawbacks.length === 0 ? (
          <div className="muted">No preset drawbacks yet.</div>
        ) : (
          <div className="stack">
            {drawbacks.map((d) => (
              <PresetDrawbackRow key={d._id} drawback={d} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function AddPresetSkillForm() {
  const addSkill = useMutation(api.presetSkills.add);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    try {
      await addSkill({ name });
      setName("");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed to add.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card stack">
      <div>
        <label htmlFor="new-preset-skill">New preset skill</label>
        <input
          id="new-preset-skill"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          style={{ width: "100%" }}
        />
      </div>
      {err && <div className="error-text">{err}</div>}
      <div>
        <button type="submit">Add skill</button>
      </div>
    </form>
  );
}

function PresetSkillRow({ skill }: { skill: Doc<"presetSkills"> }) {
  const updateSkill = useMutation(api.presetSkills.update);
  const removeSkill = useMutation(api.presetSkills.remove);
  const [name, setName] = useState(skill.name);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    setErr(null);
    setSaved(false);
    try {
      await updateSkill({ skillId: skill._id as Id<"presetSkills">, name });
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete preset skill "${skill.name}"?`)) return;
    setErr(null);
    try {
      await removeSkill({ skillId: skill._id as Id<"presetSkills"> });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed.");
    }
  }

  return (
    <div className="card stack">
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setSaved(false);
        }}
        maxLength={120}
        style={{ width: "100%", fontWeight: 600 }}
      />
      {err && <div className="error-text">{err}</div>}
      {saved && <div className="success-text">Saved.</div>}
      <div className="row-wrap">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={name.trim() === skill.name}
        >
          Save
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void handleDelete()}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function AddPresetDrawbackForm() {
  const addDrawback = useMutation(api.presetDrawbacks.add);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [abbreviation, setAbbreviation] = useState("");
  const [isRolled, setIsRolled] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    try {
      await addDrawback({
        name,
        description,
        // Empty-after-trim → undefined at the boundary. The mutation
        // applies the same normalisation server-side.
        abbreviation:
          abbreviation.trim().length > 0 ? abbreviation : undefined,
        isRolled,
      });
      setName("");
      setDescription("");
      setAbbreviation("");
      setIsRolled(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed to add.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card stack">
      <div>
        <label htmlFor="new-preset-drawback-name">New preset drawback</label>
        <input
          id="new-preset-drawback-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={120}
          placeholder="Name"
          style={{ width: "100%" }}
        />
      </div>
      <div>
        <label htmlFor="new-preset-drawback-desc">Description</label>
        <textarea
          id="new-preset-drawback-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          placeholder="Description"
          style={{ width: "100%" }}
        />
      </div>
      <div>
        <label htmlFor="new-preset-drawback-abbrev">
          Abbreviation (≤6 chars, optional)
        </label>
        <input
          id="new-preset-drawback-abbrev"
          value={abbreviation}
          onChange={(e) => setAbbreviation(e.target.value)}
          maxLength={6}
          placeholder="Short label"
          style={{ width: "100%" }}
        />
      </div>
      <label className="row" style={{ alignItems: "center", gap: "0.5rem" }}>
        <input
          type="checkbox"
          checked={isRolled}
          onChange={(e) => setIsRolled(e.target.checked)}
        />
        Rolled when called
      </label>
      {err && <div className="error-text">{err}</div>}
      <div>
        <button type="submit">Add drawback</button>
      </div>
    </form>
  );
}

function PresetDrawbackRow({
  drawback,
}: {
  drawback: Doc<"presetDrawbacks">;
}) {
  const updateDrawback = useMutation(api.presetDrawbacks.update);
  const removeDrawback = useMutation(api.presetDrawbacks.remove);
  const [name, setName] = useState(drawback.name);
  const [description, setDescription] = useState(drawback.description);
  const [abbreviation, setAbbreviation] = useState(
    drawback.abbreviation ?? "",
  );
  const [isRolled, setIsRolled] = useState(drawback.isRolled === true);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    name.trim() !== drawback.name ||
    description !== drawback.description ||
    abbreviation.trim() !== (drawback.abbreviation ?? "") ||
    isRolled !== (drawback.isRolled === true);

  async function handleSave() {
    setErr(null);
    setSaved(false);
    try {
      await updateDrawback({
        drawbackId: drawback._id as Id<"presetDrawbacks">,
        name,
        description,
        // Pass empty string explicitly so the server clears the
        // abbreviation when the admin blanks the input.
        abbreviation,
        isRolled,
      });
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete preset drawback "${drawback.name}"?`)) return;
    setErr(null);
    try {
      await removeDrawback({
        drawbackId: drawback._id as Id<"presetDrawbacks">,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed.");
    }
  }

  return (
    <div className="card stack">
      <input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setSaved(false);
        }}
        maxLength={120}
        style={{ width: "100%", fontWeight: 600 }}
      />
      <textarea
        value={description}
        onChange={(e) => {
          setDescription(e.target.value);
          setSaved(false);
        }}
        rows={2}
        placeholder="Description"
        style={{ width: "100%" }}
      />
      <input
        value={abbreviation}
        onChange={(e) => {
          setAbbreviation(e.target.value);
          setSaved(false);
        }}
        maxLength={6}
        placeholder="Abbreviation (≤6 chars)"
        style={{ width: "100%" }}
      />
      <label className="row" style={{ alignItems: "center", gap: "0.5rem" }}>
        <input
          type="checkbox"
          checked={isRolled}
          onChange={(e) => {
            setIsRolled(e.target.checked);
            setSaved(false);
          }}
        />
        Rolled when called
      </label>
      {err && <div className="error-text">{err}</div>}
      {saved && <div className="success-text">Saved.</div>}
      <div className="row-wrap">
        <button type="button" onClick={() => void handleSave()} disabled={!dirty}>
          Save
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void handleDelete()}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
