import { useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";

/**
 * Site admin console.
 *
 * Gated on `users.isSiteAdmin`, which is only set directly in the Convex
 * database (no in-app UI grants it). Site admins manage the preset skill
 * list shown as autocomplete suggestions in the Minion editor. Users may
 * still enter skills that are not in this list.
 */
export function AdminPage() {
  const me = useQuery(api.users.getMe);
  const skills = useQuery(api.presetSkills.list);

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
        Manage the preset skill list used by the Minion editor's autocomplete.
        Users may still type skills that are not in this list.
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
