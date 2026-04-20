import { Link } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

export function SharedSyndicatesPage() {
  const shared = useQuery(api.syndicates.listShared);

  return (
    <div>
      <h2>Shared Syndicates</h2>
      <p className="muted">
        Syndicates other users have made shareable. You may select any of these
        when joining a game.
      </p>

      {shared === undefined && <div className="muted">Loading…</div>}
      {shared?.length === 0 && (
        <div className="muted">No shared Syndicates yet.</div>
      )}

      <div className="stack">
        {shared?.map((s) => (
          <div key={s._id} className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <Link to={`/syndicates/${s._id}`} style={{ fontWeight: 600 }}>
                  {s.name}
                </Link>
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  Leader: {s.leader} · by {s.ownerName}
                </div>
              </div>
              {s.played && <span className="badge warning">Played</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
