import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useEffect } from "react";

/**
 * Site-admin-only directory of every syndicate in the system.
 *
 * See `plans/2026-05-15-admin-syndicate-access-v1.md`. Authors discover
 * each syndicate from the admin's perspective with owner attribution
 * and played/shared badges; the link routes back to the standard
 * editor (`/syndicates/:syndicateId`), which the backend now widens
 * to site admins. Delete is intentionally NOT exposed inline here —
 * admins push through the editor to get the same confirm-and-cascade
 * UX that owners see in `SyndicatesListPage`.
 */
export function AdminSyndicatesListPage() {
  const me = useQuery(api.users.getMe);
  const navigate = useNavigate();
  const syndicates = useQuery(
    api.syndicates.listAll,
    me?.isSiteAdmin ? {} : "skip",
  );

  // Bounce non-admins out instead of showing a permission-denied card.
  // Avoids leaking the existence of the route. (Note: this differs
  // from `AdminPage` which renders an explicit denial card; the
  // route-leakage argument is intentional here for `/admin/syndicates`
  // since the route name itself reveals the feature.)
  useEffect(() => {
    if (me === undefined) return;
    if (me === null || !me.isSiteAdmin) {
      navigate("/games", { replace: true });
    }
  }, [me, navigate]);

  if (me === undefined) return <div className="muted">Loading…</div>;
  if (me === null) return null;
  if (!me.isSiteAdmin) return null;

  return (
    <div>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: "0.75rem" }}
      >
        <h2>All Syndicates (admin)</h2>
        <Link to="/admin" className="muted">
          ← Back to Admin
        </Link>
      </div>
      <p className="muted">
        Every syndicate in the system. Played syndicates are permanently
        read-only for everyone, including admins. Open any row in the editor
        to make changes; cascade and validation rules behave exactly as for
        the owner.
      </p>

      {syndicates === undefined && <div className="muted">Loading…</div>}
      {syndicates?.length === 0 && (
        <div className="muted">No syndicates exist yet.</div>
      )}

      <div className="stack">
        {syndicates?.map((s) => (
          <div
            key={s._id}
            className="card row"
            style={{ justifyContent: "space-between" }}
          >
            <div>
              <Link to={`/syndicates/${s._id}`} style={{ fontWeight: 600 }}>
                {s.name}
              </Link>
              <div className="muted" style={{ fontSize: "0.85rem" }}>
                Leader: {s.leader} · Owner: {s.ownerName}
                {s.ownerEmail ? ` (${s.ownerEmail})` : ""}
              </div>
              <div className="row-wrap" style={{ marginTop: "0.4rem" }}>
                {s.played && <span className="badge warning">Played</span>}
                {s.isShared && <span className="badge accent">Shared</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
