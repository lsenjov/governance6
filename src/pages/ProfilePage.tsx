import { useState, useEffect } from "react";
import type { FormEvent } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

export function ProfilePage() {
  const me = useQuery(api.users.getMe);
  const updateDisplayName = useMutation(api.users.updateDisplayName);
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<
    { kind: "idle" } | { kind: "ok" } | { kind: "err"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    if (me?.displayName !== undefined) {
      setValue(me.displayName ?? "");
    }
  }, [me?.displayName]);

  if (me === undefined) return <div>Loading…</div>;
  if (me === null) return <div>Not signed in.</div>;

  async function handleSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus({ kind: "idle" });
    try {
      await updateDisplayName({ displayName: value });
      setStatus({ kind: "ok" });
    } catch (err) {
      setStatus({
        kind: "err",
        message: err instanceof Error ? err.message : "Failed to save.",
      });
    }
  }

  return (
    <div className="card" style={{ maxWidth: 480 }}>
      <h2>Profile</h2>
      <p className="muted">Signed in as {me.email}</p>
      <form className="stack" onSubmit={handleSave}>
        <div>
          <label htmlFor="displayName">Display name</label>
          <input
            id="displayName"
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={40}
            required
            style={{ width: "100%" }}
          />
          <div className="muted" style={{ fontSize: "0.85rem" }}>
            1–40 characters. Does not need to be unique.
          </div>
        </div>
        {status.kind === "err" && (
          <div className="error-text">{status.message}</div>
        )}
        {status.kind === "ok" && (
          <div className="success-text">Saved.</div>
        )}
        <button type="submit">Save</button>
      </form>
    </div>
  );
}
