import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

export function SyndicatesListPage() {
  const syndicates = useQuery(api.syndicates.listMine);
  const create = useMutation(api.syndicates.create);
  const remove = useMutation(api.syndicates.remove);

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [leader, setLeader] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await create({ name, leader, description });
      setName("");
      setLeader("");
      setDescription("");
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: string, syndicateName: string) {
    if (!window.confirm(`Delete Syndicate "${syndicateName}"?`)) return;
    try {
      await remove({ syndicateId: id as never });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete.");
    }
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "1rem" }}>
        <h2>My Syndicates</h2>
        <button type="button" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "New Syndicate"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="card stack">
          <div>
            <label htmlFor="syn-name">Name</label>
            <input
              id="syn-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <label htmlFor="syn-leader">Leader</label>
            <input
              id="syn-leader"
              value={leader}
              onChange={(e) => setLeader(e.target.value)}
              required
              maxLength={120}
              style={{ width: "100%" }}
            />
          </div>
          <div>
            <label htmlFor="syn-desc">Description</label>
            <textarea
              id="syn-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              style={{ width: "100%" }}
            />
          </div>
          {error && <div className="error-text">{error}</div>}
          <button type="submit" disabled={submitting}>
            {submitting ? "Creating…" : "Create Syndicate"}
          </button>
        </form>
      )}

      {syndicates === undefined && <div className="muted">Loading…</div>}
      {syndicates?.length === 0 && (
        <div className="muted">No Syndicates yet. Create one above.</div>
      )}

      <div className="stack">
        {syndicates?.map((s) => (
          <div key={s._id} className="card row" style={{ justifyContent: "space-between" }}>
            <div>
              <Link to={`/syndicates/${s._id}`} style={{ fontWeight: 600 }}>
                {s.name}
              </Link>
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                Leader: {s.leader}
              </div>
              <div className="row-wrap" style={{ marginTop: "0.4rem" }}>
                {s.played && <span className="badge warning">Played</span>}
                {s.isShared && <span className="badge accent">Shared</span>}
              </div>
            </div>
            <button
              type="button"
              className="danger"
              onClick={() => handleDelete(s._id, s.name)}
              disabled={s.played}
              title={s.played ? "Played Syndicates cannot be deleted." : ""}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
