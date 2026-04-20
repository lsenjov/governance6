import { useState } from "react";
import type { FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";

export function SignInPage() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const formData = new FormData(e.currentTarget);
    formData.set("flow", flow);
    try {
      await signIn("password", formData);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : flow === "signIn"
            ? "Sign-in failed."
            : "Sign-up failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sign-in-wrapper card">
      <h1>Governance</h1>
      <p className="muted" style={{ textAlign: "center" }}>
        {flow === "signIn" ? "Sign in to continue." : "Create an account."}
      </p>
      <form className="stack" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            style={{ width: "100%" }}
          />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete={
              flow === "signIn" ? "current-password" : "new-password"
            }
            style={{ width: "100%" }}
          />
        </div>
        {error && <div className="error-text">{error}</div>}
        <button type="submit" disabled={submitting}>
          {submitting
            ? "..."
            : flow === "signIn"
              ? "Sign in"
              : "Create account"}
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => setFlow((f) => (f === "signIn" ? "signUp" : "signIn"))}
        >
          {flow === "signIn"
            ? "Need an account? Sign up"
            : "Already have an account? Sign in"}
        </button>
      </form>
    </div>
  );
}
