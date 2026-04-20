import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

export function GamesListPage() {
  const games = useQuery(api.games.listMine);
  const createGame = useMutation(api.games.create);
  const [name, setName] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);
    try {
      await createGame({ name: name.trim() || undefined });
      setName("");
      setShowForm(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Failed to create game.");
    }
  }

  return (
    <div>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: "1rem" }}
      >
        <h2>Games</h2>
        <button type="button" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "New Game"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="card stack">
          <div>
            <label htmlFor="game-name">Name (optional)</label>
            <input
              id="game-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              style={{ width: "100%" }}
            />
          </div>
          {err && <div className="error-text">{err}</div>}
          <button type="submit">Create Game</button>
        </form>
      )}

      {games === undefined && <div className="muted">Loading…</div>}
      {games?.length === 0 && (
        <div className="muted">
          No games yet. Create one as GM, or ask a GM to add you.
        </div>
      )}

      <div className="stack">
        {games?.map((g) => (
          <div
            key={g._id}
            className="card row"
            style={{ justifyContent: "space-between" }}
          >
            <div>
              <Link to={`/games/${g._id}`} style={{ fontWeight: 600 }}>
                {g.name ?? "Untitled game"}
              </Link>
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                {g.isGm ? "You are GM" : "Player"}
              </div>
            </div>
            <span
              className={`badge ${
                g.state === "playing"
                  ? "success"
                  : g.state === "archived"
                    ? "warning"
                    : ""
              }`}
            >
              {g.state}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
