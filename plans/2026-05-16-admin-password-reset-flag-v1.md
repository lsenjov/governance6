# Admin-Triggered Password Reset via `passwordResetPending` Flag

## Objective

Enable a site admin (or anyone with direct Convex dashboard access) to
authorise a password reset for an existing user without ever seeing or
choosing that user's new password. The mechanism is a single optional
boolean on the user row:

- Admin flips `users.passwordResetPending` to `true` via the Convex
  dashboard.
- User goes to the sign-in page, clicks "Forgot password?", enters their
  email and a new password.
- Server checks the flag, atomically clears it, replaces the password
  hash on the user's existing `authAccounts` row, and invalidates any
  lingering sessions.
- User signs in normally with the new password.

The admin never sees the password. The user's `users._id` is preserved
end-to-end, so all foreign-key references (syndicates, players, notes,
ledger entries, etc.) remain valid.

Trust model: this is a closed app for a small, trusted user base; reset
requests are made out of band (in person / private chat). The flag's
truthiness is a credential, but the operational window between admin
flip and user consumption is short and the email address is the only
public selector. No OTP/email infrastructure is wired up; admin-as-OOB-
channel is acceptable for this scale.

## Initial Assessment

### Project Structure Summary

- Convex backend in `convex/` with auth helpers centralised in
  `convex/lib/auth.ts`. Auth wiring lives in `convex/auth.ts` (Password
  provider only; no `reset` or `verify` configured).
- React frontend in `src/`. The sign-in surface is the single file
  `src/pages/SignInPage.tsx`; everything post-auth is gated by the
  `Authenticated` boundary in `src/App.tsx:43-70`.
- Tests use `convex-test` + `vitest` with `environment: "edge-runtime"`
  (`vitest.config.ts:1-9`). Tests fabricate identities via
  `{ subject: '${userId}|test-session', issuer: 'test' }` (see
  `convex/notes.test.ts:12-17`).
- No actions or internal mutations currently exist in the codebase
  (verified via search across `convex/`). This change introduces the
  first of each.

### Relevant Files Examination

- `convex/schema.ts:15-30` — `users` table augments `authTables.users`
  with `displayName` and `isSiteAdmin`. The comment at lines 26-29
  already documents that admin-style flags are "Manageable only directly
  via the Convex database (no in-app UI grants this)." `passwordResetPending`
  fits the same pattern.
- `convex/schema.ts:30` — `users` has an `email` index used by
  `consumePasswordResetFlag` to look the user up.
- `convex/auth.ts:1-6` — declares the Convex Auth wiring. The
  `Password` provider has no `reset` configured, so the library's
  built-in reset flow is intentionally disabled.
- `node_modules/@convex-dev/auth/dist/server/index.d.ts:12` — exports
  `modifyAccountCredentials` and `invalidateSessions`. Both have
  signatures `(ctx: GenericActionCtx<...>, args) => Promise<void>`, so
  they must be called from an action.
- `node_modules/@convex-dev/auth/dist/providers/Password.js:153-159` —
  the Password provider hashes secrets via Lucia's Scrypt. Reusing
  `modifyAccountCredentials` re-uses the same hashing path, so the new
  password is indistinguishable on disk from one set during sign-up.
- `node_modules/@convex-dev/auth/dist/server/implementation/users.js:26,30-54,74`
  — confirms that simply deleting an `authAccounts` row and re-signing
  up does NOT relink to the existing `users` row for the Password
  provider (creates a duplicate `users`). This is why we must overwrite
  `secret` rather than delete+resignup.
- `convex/lib/auth.ts:14-30` — `getCurrentUser` / `requireUser` /
  `requireUserId` helpers. The new flow does NOT call them: the reset
  endpoint is unauthenticated (the user has forgotten their password).
- `src/pages/SignInPage.tsx:1-83` — single-component sign-in surface
  with `flow` state machine (`"signIn" | "signUp"`). The natural
  extension point is to add a `"reset"` flow value.
- `src/App.tsx:43-70` — `Authenticated` / `Unauthenticated` boundary;
  the reset form must live inside `Unauthenticated` because by
  definition the user has no valid session.
- `convex/_generated/api.d.ts:1-85` — auto-regenerates on schema /
  function changes; no manual edits required.

### Prioritised Challenges and Risks

1. **Highest priority — action-only library calls.**
   `modifyAccountCredentials` and `invalidateSessions` are typed as
   action-only and internally call `ctx.runMutation("auth:store", ...)`.
   The flag check must therefore live in an `internalMutation` invoked
   via `ctx.runMutation` from the action; we cannot do the entire flow
   in a single mutation transaction. This introduces a tiny race
   window between flag consumption and password write, which is
   acceptable for this trust model.

2. **High — atomic flag consumption.** The flag must be cleared
   _before_ the password is set (and before any UI signal of success
   reaches the user), so that a second attempt can't reuse the flag.
   If `modifyAccountCredentials` then fails, the admin re-flips the
   flag; nothing leaks because nothing was authenticated.

3. **Medium — `modifyAccountCredentials` requires an existing
   `authAccounts` row.** It does NOT create one. If an admin sets the
   flag on a user with no Password credential (e.g. a user who signed
   up via a different provider in some future world), the action will
   throw. For v1 the only provider is Password, so every real user has
   such a row. The action surfaces the underlying library error
   message as-is.

4. **Medium — unauthenticated public endpoint.** The reset action is
   reachable without a session. Mitigations:
   - It only succeeds when `passwordResetPending === true` on the
     matched user; otherwise throws `"No reset pending."` with a
     generic message that doesn't differentiate "no such user" from
     "flag not set" (avoids account enumeration).
   - Password length validation matches the Password provider's
     default (`>= 8`, see
     `node_modules/@convex-dev/auth/dist/providers/Password.js:165`).
   - We do NOT log the password or echo it.

5. **Medium — invalidate other sessions.** If the user has an active
   session on another device (the flag is typically used because they
   forgot the password, but they may still be signed in elsewhere), we
   must invalidate it post-reset. `invalidateSessions` from the auth
   library does exactly this and is what the built-in reset flow uses
   (see `Password.js:118`).

6. **Lower — test coverage for action paths.** `convex-test` supports
   actions, but `modifyAccountCredentials` requires a valid Password
   `authAccounts` row keyed by `providerAccountId === email`. Tests
   that exercise the full action must seed that row. The flag-only
   internal mutation can be tested in isolation as well.

7. **Lower — UI clarity.** The sign-in page must distinguish three
   flows now (`signIn`, `signUp`, `reset`). The reset form needs
   email + new password (no current password field). Error copy
   must be clear (`"No reset pending. Ask an admin to authorise one."`).

## Assumptions

- **Closed-app trust model.** A small known user list; reset requests
  arrive OOB; the flag is consumed within minutes. No race-window
  hardening (tokens, expiry) is required in v1.
- **Schema shape is `v.optional(v.literal(true))`, not
  `v.optional(v.boolean())`.** This forbids the value `false` from ever
  being persisted, so the only valid states are `true` (reset pending)
  or absent (cleared / never set). This removes any future migration
  burden when replacing the field with a token object: there is no
  `false` value to clean up, and the field is cleared via
  `patch(..., { passwordResetPending: undefined })` rather than
  `patch(..., { passwordResetPending: false })`.
- **Password provider is the only credential provider.** Every existing
  user has exactly one `authAccounts` row with `provider === "password"`
  and `providerAccountId === email`. The action assumes this; future
  multi-provider work is out of scope.
- **Users with `email === undefined` cannot self-reset.** The schema
  marks `users.email` optional (`convex/schema.ts:17`). Such users
  will surface as `"No reset pending."` if an admin flips the flag on
  them — there is no way to look them up by email in this flow. This
  is an acceptable limitation: any user who has signed up via the
  Password provider necessarily has an email set
  (`Password.js:56-67`).
- **Email matching is case-sensitive.** Neither `users.email` nor
  `authAccounts.providerAccountId` is normalised by the library
  (verified at `Password.js:56-67`). A user who signed up as
  `Foo@Bar.com` and types `foo@bar.com` on the reset form will see
  `"No reset pending."`. The form does not normalise either, to stay
  consistent with the sign-in path. Documented as a known footgun.
- **An authenticated browser session cannot reach the reset form.**
  The sign-in page lives inside `<Unauthenticated>` (`src/App.tsx:40-42`).
  A user signed in on the same browser must sign out before resetting.
  This is the natural consequence of the routing boundary and is not
  treated as a defect.
- **Email may appear on multiple `users` rows.** Convex has no
  schema-level uniqueness; the `email` index on `users`
  (`convex/schema.ts:30`) is not a unique index. The library's user-
  linking logic only deduplicates on **verified** email
  (`users.js:30,90-97`), which this project never sets (no `verify`
  provider). The lookup must tolerate the multi-row case without
  throwing the wrong error — see Task 2.
- **Admin sets the flag via the Convex dashboard.** No in-app admin UI
  is needed in v1. The schema-level comment is sufficient documentation
  for admin users.
- **Email is the user-facing identifier on the reset form.** Matches
  the existing `signIn` / `signUp` forms.
- **No password complexity rules beyond min-length 8.** Matches the
  Password provider's default (`Password.js:165`). If complexity rules
  are added later they should live in the Password provider config so
  they apply uniformly to sign-up and reset.
- **`modifyAccountCredentials` errors are not faithfully passed to the
  client.** The library throws messages like
  `"Cannot modify account with ID ${id} because it does not exist"`
  (`modifyAccount.js:22`), which leaks the email back to an
  unauthenticated caller. The action catches that error specifically
  and re-throws as `"No reset pending."` so the unauthenticated
  endpoint emits exactly one message regardless of state. See Task 3.
- **Min-length validation lives in the action, not the internal
  mutation.** The mutation only knows about the flag; the action owns
  the password contract. If `modifyAccountCredentials` itself rejects
  the password (it goes through the Password provider's `crypto.hashSecret`
  which does not validate length), that's a defence-in-depth bonus, not
  the primary check.
- **No new test file naming convention.** New tests live in
  `convex/auth.test.ts`, matching the per-module pattern used elsewhere
  (`convex/notes.test.ts`, `convex/drawbacks.test.ts`, etc.).

## Implementation Plan

### Backend — schema

- [x] Task 1. Add `passwordResetPending: v.optional(v.literal(true))`
      to the `users` table at `convex/schema.ts:15-30`. Place it next to
      `isSiteAdmin` so the "manage via dashboard only" comment naturally
      covers it. **Extend the existing comment block at
      `convex/schema.ts:26-29`** so it documents both `isSiteAdmin` and
      `passwordResetPending`:

  ```
  // Both 'isSiteAdmin' and 'passwordResetPending' are manageable only
  // directly via the Convex database (no in-app UI grants them). A site
  // admin can manage the preset skill list used when authoring Minions.
  // Setting 'passwordResetPending' to 'true' authorises one self-serve
  // password reset via 'auth.resetFlaggedPassword'; the field is then
  // cleared atomically on consumption. See plans/2026-05-16-admin-
  // password-reset-flag-v1.md.
  ```

  Rationale: minimal, additive, optional (so existing rows are valid
  without backfill). The `v.literal(true)` shape forbids `false` on
  disk, removing any migration burden if v2 replaces the field with a
  token object.

### Backend — internal mutation

- [x] Task 2. Add `consumePasswordResetFlag` as an `internalMutation`
      in `convex/auth.ts`. Args: `{ email: v.string() }`. Behaviour:
  - Look up users by email via
    `withIndex("email", (q) => q.eq("email", email)).take(2)`.
  - If the result is empty, throw `new Error("No reset pending.")`
    (intentionally identical message to the flag-not-set case to avoid
    account enumeration).
  - If the result has length ≥ 2, throw the same generic error.
    (Silently picking row #0 would be wrong; the admin must clean up
    the duplicate via the dashboard before retrying.)
  - If the single user's `passwordResetPending !== true`, throw the
    same generic error.
  - `await ctx.db.patch(user._id, { passwordResetPending: undefined })`
    to clear the flag.
  - Return `user._id`.

  Rationale: `.take(2)` instead of `.unique()` because the `email`
  index is non-unique (Convex has no schema-level uniqueness; verified
  duplicates are possible because the project does not run email
  verification). Mutations are transactional, so the flag check +
  clear is atomic. Returning the userId lets the calling action
  invalidate sessions without a second lookup. Internal (not public)
  because no client should call it directly; the action wraps it.

### Backend — public action

- [x] Task 3. Add `resetFlaggedPassword` as a public `action` in
      `convex/auth.ts`. Args: `{ email: v.string(), newPassword: v.string() }`.
      Returns `null`. Behaviour:
  1. Validate `newPassword.length >= 8`; throw `"Password must be at
least 8 characters."` otherwise. (Match `Password.js:165`.)
     Note: the flag is NOT consumed in this branch.
  2. `const userId: Id<"users"> = await ctx.runMutation(internal.auth.consumePasswordResetFlag, { email })`.
     The TypeScript circularity annotation is required because the
     mutation lives in the same file (per
     `convex/_generated/ai/guidelines.md:94-110`).
  3. Wrap step 4 in `try { ... } catch (e) { throw new Error("No
reset pending."); }` so the library's error message
     (`"Cannot modify account with ID ${email} because it does not
exist"` — `modifyAccount.js:22`) does not leak the email back to
     an unauthenticated caller. After the rethrow, log the original
     error server-side via `console.error` for ops visibility.
  4. `await modifyAccountCredentials(ctx, { provider: "password",
account: { id: email, secret: newPassword } })`.
  5. `await invalidateSessions(ctx, { userId })` (outside the try/catch
     in step 3; failure here is a server bug, not a per-request
     error to mask).
  6. Add a file-level JSDoc on `convex/auth.ts` (the file has none
     currently) documenting that the module owns both the Convex Auth
     wiring AND the admin-triggered password reset flow, with a pointer
     to this plan file.
  7. `return null`.

  Rationale: public surface for the React client. Action (not
  mutation) because the auth library helpers are action-typed. Order
  matters: flag consumed first → password set → sessions killed. If
  step 4 throws after step 2 cleared the flag, the admin must re-flip
  the flag; this is acceptable for the trust model and was a primary
  design consideration.

### Backend — tests

- [x] Task 4. Create `convex/auth.test.ts` covering the internal flag-
      consumption path:
  - "consumePasswordResetFlag throws when no user matches email"
  - "consumePasswordResetFlag throws when flag is unset"
  - "consumePasswordResetFlag throws when two users share the email
    (negative test for the duplicate case)"
  - "consumePasswordResetFlag clears the flag and returns the userId
    when flag is `true`"
  - "consumePasswordResetFlag preserves other fields on the user row
    (displayName, isSiteAdmin) after clearing the flag"
  - "consumePasswordResetFlag throws if called twice (flag is
    single-use)"

  Use `t.run(async (ctx) => ctx.db.insert("users", { email, ...,
passwordResetPending: true }))` to seed, and call
  `t.mutation(internal.auth.consumePasswordResetFlag, { email })`.
  Then assert via `t.run(... ctx.db.get(userId))` that
  `passwordResetPending` is absent AND `displayName`/`isSiteAdmin`
  retain their seeded values.

  Note: no test for `passwordResetPending === false` is needed because
  the `v.optional(v.literal(true))` validator on the schema prevents
  that value from being inserted in the first place.

- [x] Task 5. Add tests to the same file covering
      `resetFlaggedPassword` end-to-end. `convex-test` resolves function
      paths by importing the module via `import.meta.glob` and looking up
      the named export
      (`node_modules/convex-test/dist/index.js:1395-1428`), so the
      `convexAuth({...}).store` mutation exported from `convex/auth.ts:4`
      is reachable as `auth:store` from inside
      `modifyAccountCredentials` (`modifyAccount.js:29-35`) and
      `invalidateSessions` (`invalidateSessions.js:8-15`). The full action
      is therefore exercisable under the harness with no fallback needed.

  Tests:
  - "resetFlaggedPassword rejects passwords shorter than 8 chars"
    (asserts the action throws AND that
    `users[id].passwordResetPending` is still `true` afterwards).
  - "resetFlaggedPassword rejects when no reset is pending" (generic
    error message; identical text to the missing-user case).
  - "resetFlaggedPassword rejects when the user has the flag set but
    no `authAccounts` row exists for the password provider" (asserts
    the action throws `"No reset pending."` — i.e. the library's
    underlying error is masked by the try/catch in Task 3 step 3 —
    AND that the flag has been consumed (re-flip required)).
  - "resetFlaggedPassword succeeds when flag is set and password is
    valid: flag is cleared, authAccounts.secret is rewritten" — seed
    a `users` row with the flag and an `authAccounts` row with a
    known hash (use `await new Scrypt().hash("oldpass")` from
    `"lucia"` if convenient, or just any sentinel string — we assert
    inequality, not a specific new value). Call the action, then
    re-fetch the `authAccounts` row and assert `secret !==
seededHash` and `passwordResetPending === undefined`.
  - "resetFlaggedPassword invalidates existing sessions for the user"
    — seed an `authSessions` row with `userId` matching, call the
    action, then assert the row is gone.
  - "resetFlaggedPassword is single-use: a second call after success
    throws `'No reset pending.'`".
  - (Stretch) "after a successful reset, signing in with the new
    password works" via `t.action(api.auth.signIn, { provider:
"password", params: { email, password: newPassword, flow:
"signIn" } })`. If the Scrypt round-trip is slow under
    edge-runtime, mark this as `.skip` with a one-line comment and
    move on; the secret-changed assertion above is the load-bearing
    one.

- [x] Task 6. Verify that the existing `convex/notes.test.ts`,
      `convex/drawbacks.test.ts`, etc., are unaffected (no schema field
      they care about is modified; the new field is optional). Rationale:
      regression sanity check.

### Frontend — sign-in page

- [x] Task 7. Extend `src/pages/SignInPage.tsx` to support a third
      `flow` value `"reset"`. Specifically:
  - Widen the `flow` state type at `src/pages/SignInPage.tsx:7` to
    `"signIn" | "signUp" | "reset"`.
  - Import `useAction` from `convex/react` and `api` from
    `../../convex/_generated/api`.
  - In `handleSubmit`, branch on `flow === "reset"`: call
    `await resetFlaggedPassword({ email, newPassword: password })`
    (where `resetFlaggedPassword = useAction(api.auth.resetFlaggedPassword)`).
    On success: (a) call `e.currentTarget.reset()` to wipe the password
    out of the DOM input before transitioning, (b) `setSuccess("Password
reset. Please sign in.")`, (c) `setFlow("signIn")`. On failure
    surface the thrown error via the existing `error` state.
  - Update the heading at `src/pages/SignInPage.tsx:35-37` to switch on
    all three flow values (`"Sign in to continue." | "Create an
account." | "Choose a new password. An admin must have authorised
this reset."`).
  - Update the submit button label at lines 65-69 to include the
    `"reset"` case (`"Set new password"`).
  - Update the autocomplete attribute at lines 57-59 to a three-way
    switch: `"current-password"` for `signIn`, `"new-password"` for
    both `signUp` and `reset`.
  - Secondary actions: render exactly these toggles per flow state,
    replacing the single toggle button at lines 71-79:

    | `flow`   | Visible secondary actions                       |
    | -------- | ----------------------------------------------- |
    | `signIn` | "Need an account? Sign up" · "Forgot password?" |
    | `signUp` | "Already have an account? Sign in"              |
    | `reset`  | "Back to sign in"                               |

    Each button calls `setFlow(...)` and additionally
    `setError(null)` + `setSuccess(null)` to clear any stale banner
    text from the previous flow.

  Rationale: keeps the single-file sign-in surface; reuses the same
  email + password inputs to minimise UI sprawl. The current-password
  vs new-password autocomplete switch is a small accessibility
  improvement. Clearing the password out of the DOM on success closes
  a small data-hygiene smell where the new password would otherwise
  sit in the input across the flow transition.

- [x] Task 8. Add a `success` state (`useState<string | null>(null)`)
      to `src/pages/SignInPage.tsx` alongside the existing `error` state.
      Render the success message in a sibling element to the existing
      `error-text` element using a `success-text` class (style with the
      existing theme green if available; otherwise the bare class is
      fine — themable later). The state is set by the reset-success
      branch in Task 7 and cleared on any flow transition. Rationale:
      without it, the flow change from `reset` back to `signIn` is silent
      and confusing.

### Verification round

- [x] Task 9. Run `npm run typecheck` and confirm no TypeScript
      errors. Common slip points: the `Id<"users">` annotation on the
      `runMutation` result, the widened `flow` union in the React state.

- [x] Task 10. Run `npm run lint` and confirm no ESLint errors. The
      repo has `eslint.config.js` at the root; CI / local convention
      expects a clean lint pass.

- [x] Task 11. Run `npm test` and confirm the full vitest suite passes,
      including the new `convex/auth.test.ts` cases.

- [ ] Task 12. Manual smoke test (out of scope for automated tests, but
      document the steps in the verification criteria below): from
      `npm run dev:all`, create a user, sign out, flip
      `passwordResetPending` to `true` via `npx convex dashboard`, complete
      the reset flow, sign in with the new password.

## Verification Criteria

- A user with `passwordResetPending !== true` who submits the reset
  form receives a `"No reset pending."` error.
- A user with `passwordResetPending === true` who submits the reset
  form with a valid new password (>= 8 chars) sees a success message,
  is bounced back to the sign-in flow, and can sign in with the new
  password.
- After a successful reset, the user's `users._id` is unchanged; all
  syndicates, players, notes, ledger entries, and other rows that
  reference it remain valid (verified by inspecting the dashboard).
- After a successful reset, the `passwordResetPending` field is absent
  on the user row.
- After a successful reset, any pre-existing `authSessions` rows for
  the user are deleted (`invalidateSessions` behaviour).
- A reset attempt with a password shorter than 8 characters is rejected
  and the flag is NOT consumed (a second attempt with a valid password
  on the same flag still succeeds).
- A reset attempt against a user whose flag is set but whose
  `authAccounts` row is missing is rejected with the same generic
  `"No reset pending."` message (the library's email-leaking error
  message does not reach the client). The flag IS consumed in this
  branch (admin must re-flip).
- A reset attempt against an email matching two `users` rows is
  rejected with `"No reset pending."`; admin must resolve the
  duplicate via the dashboard.
- An unauthenticated caller can invoke `api.auth.resetFlaggedPassword`
  but cannot invoke `internal.auth.consumePasswordResetFlag` (the
  internal mutation is not on the public API surface).
- `consumePasswordResetFlag` is single-use: a second call with the
  same email after a successful first call throws.
- After clearing the flag, all other fields on the `users` row
  (`displayName`, `isSiteAdmin`, `email`, etc.) are unchanged.
- An admin reading `convex/schema.ts` can discover the
  `passwordResetPending` field, its purpose, and the link to this plan
  via the comment block at the `users` table definition.
- All new and existing tests pass under `npm test`.
- `npm run typecheck` reports no errors.
- `npm run lint` reports no errors.

## Potential Risks and Mitigations

1. **Account enumeration via differentiated error messages.**
   Mitigation: `consumePasswordResetFlag` returns the same generic
   `"No reset pending."` for both "no user" and "flag unset". The
   action does not log either case at info level.

2. **Race between flag check and password write.**
   Mitigation: the mutation clears the flag inside its transaction, so
   two concurrent reset attempts see the flag exactly once. The
   password-write step can still fail post-flag-consumption; this is
   acceptable because admin can re-flip the flag and no auth state
   leaks during the window.

3. **`modifyAccountCredentials` typed for action context, not mutation
   context.**
   Mitigation: the action wraps the call; the mutation is invoked via
   `ctx.runMutation`. Per the Convex guidelines at
   `convex/_generated/ai/guidelines.md:88-92`, this is the canonical
   pattern; the small race window is documented in the trust-model
   discussion.

4. **`modifyAccountCredentials` throws if no `authAccounts` row exists
   for the user.**
   Mitigation: documented in assumptions; in the current single-
   provider deployment every user has the row. If a future contributor
   adds an OAuth provider, the action's error message ("Account does
   not exist") will surface and a follow-up can branch on provider.

5. **Unauthenticated public action could be hit by automated probing.**
   Mitigation: the action only succeeds when the admin has explicitly
   flipped the flag; without that, the worst case is an attacker
   learns which emails are registered (only if the error messages
   diverge — they don't, by design). Rate-limiting is not added in v1
   but is documented as a follow-up if the app's exposure expands.

6. **Frontend flow change ("reset" added) breaks existing typed code.**
   Mitigation: the `flow` state is a local `useState` inside
   `SignInPage.tsx`; no external code references it. The change is
   self-contained.

7. **Successful reset leaves a stale session on another device.**
   Mitigation: Task 3 step 4 calls `invalidateSessions` exactly as the
   library's own reset flow does (`Password.js:118`). Verified in
   Verification Criteria.

## Alternative Approaches

1. **Wire up the library's built-in OTP reset flow with a real email
   provider (Resend).** Trade-offs: cleaner long-term (self-serve;
   admin not involved at all), but requires email infrastructure,
   billing, and ongoing operational burden. Rejected in v1 because the
   app's user base is small and OOB requests are acceptable. Documented
   here as the natural upgrade if exposure grows.

2. **No-op reset provider + admin reads OTP code from the
   `authVerificationCodes` table.** Trade-offs: uses zero custom code
   on the backend, but the admin sees a one-time code and has to
   transmit it OOB. Functionally equivalent to the flag approach but
   leans on a library-internal table that's intended to be ephemeral;
   if the library reshapes that table the workaround breaks. Rejected
   for stability.

3. **Schema-level token instead of boolean (`{ tokenHash, expiresAt }`).**
   Trade-offs: removes the trust-model dependency on a short consumption
   window; admin issues a token that the user must present alongside
   their new password. Adds UI (a token field), code (token generation
   and hash verification), and the question of how the admin delivers
   the token. Rejected in v1 as overkill for the trust model; a clear
   upgrade path because replacing the boolean with the object on the
   schema is a forward-compatible migration once all existing rows
   have cleared the flag.

4. **Boolean flag with no atomic consumption (check, then clear after
   password write).** Trade-offs: simpler control flow but opens a
   race where two concurrent calls both observe the flag set and both
   succeed. Rejected: trivially fixed by clearing inside the mutation
   transaction.

5. **Add a dedicated admin UI button to flip the flag.** Trade-offs:
   nicer admin UX but introduces a new admin-only mutation surface
   that needs its own auth gating (the existing `requireSiteAdmin`
   helper covers this) and another page in the admin console. Not
   strictly required since the dashboard works; documented as a small
   v1.1 follow-up if admins find the dashboard friction noticeable.
