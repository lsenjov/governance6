import { useState } from "react";
import type { FormEvent } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";

type Flow = "signIn" | "signUp" | "reset";

export function SignInPage() {
  const { signIn } = useAuthActions();
  const resetFlaggedPassword = useAction(api.auth.resetFlaggedPassword);
  const [flow, setFlow] = useState<Flow>("signIn");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function switchFlow(next: Flow) {
    setFlow(next);
    setError(null);
    setSuccess(null);
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    // Clear both banners at submit-start so we never render success + error
    // simultaneously (e.g. "Password reset." success lingering through a
    // failed sign-in attempt on the very next form submission).
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    const formData = new FormData(form);
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    try {
      if (flow === "reset") {
        await resetFlaggedPassword({ email, newPassword: password });
        // Wipe the new password out of the DOM before the flow transition
        // so it does not sit in the input across screens. Keep the email
        // field populated so the user can immediately sign in without
        // retyping it.
        const passwordInput = form.elements.namedItem(
          "password",
        ) as HTMLInputElement | null;
        if (passwordInput) passwordInput.value = "";
        setSuccess("Password reset. Please sign in with the new password.");
        setFlow("signIn");
      } else {
        formData.set("flow", flow);
        await signIn("password", formData);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : flow === "signIn"
            ? "Sign-in failed."
            : flow === "signUp"
              ? "Sign-up failed."
              : "Password reset failed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const heading =
    flow === "signIn"
      ? "Sign in to continue."
      : flow === "signUp"
        ? "Create an account."
        : "Choose a new password. An admin must have authorised this reset.";

  const submitLabel = submitting
    ? "..."
    : flow === "signIn"
      ? "Sign in"
      : flow === "signUp"
        ? "Create account"
        : "Set new password";

  // sign-in expects the current password; sign-up and reset both want a
  // fresh one so the browser doesn't autofill with the existing entry.
  const passwordAutoComplete =
    flow === "signIn" ? "current-password" : "new-password";

  return (
    <div className="sign-in-wrapper card">
      <h1>Governance</h1>
      <p className="muted" style={{ textAlign: "center" }}>
        {heading}
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
          <label htmlFor="password">
            {flow === "reset" ? "New password" : "Password"}
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            autoComplete={passwordAutoComplete}
            style={{ width: "100%" }}
          />
        </div>
        {error && <div className="error-text">{error}</div>}
        {success && <div className="success-text">{success}</div>}
        <button type="submit" disabled={submitting}>
          {submitLabel}
        </button>
        {flow === "signIn" && (
          <>
            <button
              type="button"
              className="secondary"
              onClick={() => switchFlow("signUp")}
            >
              Need an account? Sign up
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => switchFlow("reset")}
            >
              Forgot password?
            </button>
          </>
        )}
        {flow === "signUp" && (
          <button
            type="button"
            className="secondary"
            onClick={() => switchFlow("signIn")}
          >
            Already have an account? Sign in
          </button>
        )}
        {flow === "reset" && (
          <button
            type="button"
            className="secondary"
            onClick={() => switchFlow("signIn")}
          >
            Back to sign in
          </button>
        )}
      </form>
    </div>
  );
}
