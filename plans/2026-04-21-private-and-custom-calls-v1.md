# Private and Custom Calls

## Objective

Extend the Call Queue so a Player may enqueue a **custom call** (free-form text label) in addition to the existing bought-Minion call. Add a **Private Call** shortcut that creates a custom call whose label is the literal string `"Private Call"`. All other queue semantics (one active Call per Player, FIFO, GM removal, recently-removed history) are preserved and apply uniformly to both call kinds.

## Initial Assessment

### Project Structure Summary

- Backend lives in `convex/` with per-feature modules; auth/authorization helpers in `convex/lib/auth.ts`.
- Call Queue rule (Rule 22 in `plans/2026-04-20-init-v4.md:42`) is implemented in `convex/calls.ts:1-181` and backed by the `calls` table in `convex/schema.ts:118-130`.
- Client: `CallQueuePanel` (`src/pages/GameDetailPage.tsx:922-999`) and the per-Minion "Call" button inside `MinionBuyPanel` (`src/pages/GameDetailPage.tsx:909-917`).
- Existing replace-in-place semantics: `addOrReplaceCall` (`convex/calls.ts:22-70`) preserves `createdAt` and `_id` when a Player already has an active Call and patches the `minionId` instead of inserting.

### Relevant Files and Implications

- `convex/schema.ts:118-130` — `calls` table currently requires `minionId`; this must become optional so custom calls can omit it, with a new `kind` discriminator and a `label` field.
  - Implication: requires a schema change and back-compat treatment of existing rows (which all have `minionId` set).
- `convex/calls.ts:22-70` — `addOrReplaceCall` is minion-specific; custom calls need a sibling mutation with the same replace-in-place invariants.
- `convex/calls.ts:97-181` — `activeCalls` and `recentlyRemovedCalls` currently dereference `minionId` via `ctx.db.get`; they must branch on `kind` and project either `minionName` (minion call) or `label` (custom/private call).
- `src/pages/GameDetailPage.tsx:922-999` — `CallQueuePanel` renders a hard-coded `<strong>{c.playerName}</strong> called <strong>{c.minionName}</strong>`; needs a conditional that displays the label for custom calls and must now also host a "Make a custom call" / "Private Call" submission form for the current Player (since custom calls are not tied to any Minion or Syndicate).
- `src/pages/GameDetailPage.tsx:356-365` — `MinionBuyPanel` only renders when the roster entry has `selectedSyndicateId`; a Player without a Syndicate must still be able to submit a custom/private call, so the new form must live outside `MinionBuyPanel`.
- `convex/_generated/api.d.ts` is regenerated — no manual change.

### Prioritized Challenges and Risks

1. **Schema evolution without breaking existing rows** — highest risk; existing `calls` documents have `minionId` required. Making `minionId` optional is backward-compatible for readers; must ensure all write paths still set it for minion calls. Prioritized first because every other task depends on the final schema shape.
2. **Replace-in-place across kinds** — second highest; when a player switches between a Minion call and a custom/private call, the single-active-per-player invariant must hold, and the row must be patched (preserving `_id`/`createdAt`) rather than re-inserted, matching Rule 22's subtlety already codified in `plans/2026-04-20-init-v4.md:142`.
3. **Server-side label validation** — third; free-form input is untrusted, needs length/whitespace validation to avoid denial-of-service via massive strings or empty queue entries.
4. **UI placement** — fourth; the form must be reachable by Players who have no Syndicate selected, so it cannot live inside `MinionBuyPanel`.
5. **Regression surface for queries** — lowest of the major risks; `activeCalls` and `recentlyRemovedCalls` are consumed by one UI component, which narrows the blast radius.

## Implementation Plan

### Phase 1 — Schema

- [ ] Task 1. Update `convex/schema.ts:118-130` `calls` table:
  - Make `minionId` optional: `minionId: v.optional(v.id("minions"))`.
  - Add `kind: v.optional(v.union(v.literal("minion"), v.literal("custom")))`. Treat undefined as `"minion"` in readers for back-compat with existing rows (all of which have `minionId` set).
  - Add `label: v.optional(v.string())`.
  - Keep all existing indexes unchanged (`by_game_active_time`, `by_game_removed_time`, `by_game_player_active`); the invariants they encode are kind-independent.
    Rationale: smallest possible change that admits custom calls without disturbing existing rows or invariants.

### Phase 2 — Backend mutations

- [ ] Task 2. Extract the replace-in-place branch of `convex/calls.ts:22-70` into a private helper `upsertActiveCall(ctx, { gameId, player, patch, insert })` where `patch` is the partial fields to set on an existing active call and `insert` is the full new document. Rationale: both the existing minion path and the new custom path need the exact same "one active per player; preserve `_id` and `createdAt` on replace" semantics; centralising it prevents drift.

- [ ] Task 3. Refactor `addOrReplaceCall` (minion path) to use the helper. Behavioural change: on replace, also explicitly set `kind: "minion"` and clear `label: undefined` in the patch (important when the existing active call was a custom one and the player switches to a minion call). Idempotent no-op check is extended: same minion **and** `kind === "minion"` → no-op. Rationale: guarantees the row's kind discriminator is always consistent with its content.

- [ ] Task 4. Add mutation `addOrReplaceCustomCall({ gameId, label })`:
  - Require `requireGamePlayer` and `game.state === "playing"` (mirrors current minion mutation).
  - Validate `label`: trim; reject empty; reject length > 80 chars. Rationale: prevents blank or oversized entries; 80 matches short-title conventions elsewhere in the codebase (syndicate leader etc.) and is enough for "Need GM attention" style messages.
  - Use the helper: insert `{ gameId, playerId, kind: "custom", label, createdAt, isActive: true }` when no active call, otherwise patch `{ kind: "custom", label, minionId: undefined }` and treat same-`label` + `kind==="custom"` as a no-op.
    Rationale: keeps a single clean entry point for custom calls; the Private button is a client-side shortcut, not a server-side concept.

- [ ] Task 5. Leave `removeCall` (`convex/calls.ts:76-92`) unchanged. Rationale: soft-delete is kind-independent.

### Phase 3 — Backend queries

- [ ] Task 6. Update `activeCalls` (`convex/calls.ts:97-138`) to branch on `kind`:
  - When `kind === "custom"`: return `{ ..., kind: "custom", label: c.label ?? "" }` without fetching a minion.
  - Otherwise (including rows with `kind === undefined` for back-compat): resolve `minionId` as today and return `{ ..., kind: "minion", minionId, minionName }`.
  - Keep `playerName` resolution unchanged for both branches.
    Rationale: single query remains the UI's source of truth; avoids a second round-trip from the client.

- [ ] Task 7. Mirror the same branching in `recentlyRemovedCalls` (`convex/calls.ts:143-181`). Rationale: removed history must display the label for a custom call that was subsequently removed (or whose player switched off it — because our replace-in-place means a replaced call never appears in history, only GM-removed ones do).

- [ ] Task 8. Define and export a TypeScript union type `CallRow` in `convex/calls.ts` reflecting the new shape (`{ kind: "minion"; minionId; minionName; ... } | { kind: "custom"; label; ... }` plus shared fields). Rationale: gives the client a discriminated union it can pattern-match exhaustively.

### Phase 4 — Client

- [ ] Task 9. In `src/pages/GameDetailPage.tsx:922-999` `CallQueuePanel`, update the active-list renderer to switch on `c.kind`:
  - For `"minion"`: keep the current `<strong>{playerName}</strong> called <strong>{minionName}</strong>` layout.
  - For `"custom"`: render `<strong>{playerName}</strong> called <strong>{label}</strong>` (no special badge; the label already communicates intent, per the feedback "Private Call" is just a specific label).
    Apply the same branching to the recently-removed list.
    Rationale: identical information architecture; only the trailing noun changes.

- [ ] Task 10. Add a new sub-component `CustomCallForm` inside `CallQueuePanel` visible only when the viewer is a Player (not GM) **and** `gameState === "playing"`. It contains:
  - A controlled `<input>` for a custom label, client-side length-capped at 80 chars with trim-on-submit.
  - A primary "Add custom call" button that calls `api.calls.addOrReplaceCustomCall({ gameId, label })`.
  - A secondary "Private Call" button that calls the same mutation with a hard-coded `label: "Private Call"`.
  - Show a concise help line: "Replaces your current call, if any." to make the one-active-per-player rule discoverable.
  - Error surface using the same pattern as other mutations on this page.
    Rationale: placing the form in the Call Queue section (rather than inside `MinionBuyPanel`) guarantees reachability for Players with no Syndicate selected; grouping it with the queue also provides immediate visual confirmation of the submitted call.

- [ ] Task 11. Extend `CallQueuePanel`'s props to include the viewer (e.g. `{ gameId, isGm, isPlayer, gameState }`). Update the call site in `src/pages/GameDetailPage.tsx:70-100` to pass the new props from the existing `viewer` and `game.state` values. Rationale: component needs to know both whether to render the mutating form and whether mutations are currently allowed.

- [ ] Task 12. Leave the per-Minion "Call" button in `MinionBuyPanel` (`src/pages/GameDetailPage.tsx:909-917`) unchanged. Rationale: that affordance is the existing minion path; custom/private is additive.

### Phase 5 — Tests

- [ ] Task 13. Add a `convex/calls.test.ts` covering (all with `convex-test`):
  - Custom call inserts when no active call exists; row has `kind="custom"`, `label` set, `minionId` unset.
  - Private Call is a custom call whose label is exactly `"Private Call"`.
  - Switching minion→custom replaces in place: same `_id`, same `createdAt`, `minionId` cleared, `kind` flipped, `label` set.
  - Switching custom→minion replaces in place: same `_id`, same `createdAt`, `label` cleared (or ignored), `kind="minion"`, `minionId` set.
  - Same-label custom submission is a no-op (no new row; no change to `createdAt`).
  - Empty/whitespace-only labels rejected; labels > 80 chars rejected.
  - Non-participant callers rejected; game state must be `"playing"`.
  - GM `removeCall` works on a custom call the same way (soft-delete; appears in removed history with its label intact).
    Rationale: Rule 22's replace-in-place is the subtlest invariant in this feature (flagged in `plans/2026-04-20-init-v4.md:142`); custom calls must honour it.

### Phase 6 — Docs/comments

- [ ] Task 14. Update the file-top doc comment in `convex/calls.ts:10-20` to mention two call kinds (minion, custom) and note that Private Call is a client-side shortcut for a custom call with label `"Private Call"`. Rationale: inline documentation is the project's preferred source-of-truth for subtle invariants.

## Verification Criteria

- A Player whose Syndicate is unset can still submit a Private Call and see it appear in the queue; the call is attributed to them and shows the text "Private Call".
- A Player with an existing Minion call who submits a custom call ends up with exactly **one** active queue row, preserving the original queue position (`createdAt` unchanged, `_id` unchanged), with `kind="custom"` and `label` set; and vice versa.
- Submitting the same custom label twice in a row results in no additional DB writes (observable via queue order being unaffected and no new timestamp).
- GMs can remove custom/private calls; removed custom calls appear in the "recently removed" list with their label preserved.
- Clients rendering the queue never show `"Unknown Minion"` for a custom call; the label is shown instead.
- Server rejects empty, whitespace-only, and >80-char labels with a clear error surfaced in the form.
- Existing minion-call paths remain green: same-minion replacement is still a no-op; adding a Minion call for an unbought minion still fails.
- All new code is covered by `convex-test` cases enumerated in Task 13.

## Potential Risks and Mitigations

1. **Back-compat read of rows with undefined `kind`.** Existing rows in `calls` have `minionId` set and no `kind` field.
   Mitigation: Readers treat `kind === undefined` as `"minion"` and resolve `minionId` as today. No data migration required.
2. **Kind/content drift on replace.** Replacing a custom call with a minion call (or vice versa) must patch _both_ `kind` and the mutually-exclusive field, or a row could end up with both `minionId` and `label` set.
   Mitigation: centralise in `upsertActiveCall` helper (Task 2); always write `kind` and explicitly `undefined`-out the unused field in the patch.
3. **Injection-style abuse via free-form label.** A long or HTML-ish label could break the UI.
   Mitigation: server-side length cap + trim (Task 4); client renders labels as text (React's default escaping) — never `dangerouslySetInnerHTML`.
4. **Users confuse "Private Call" with a visibility feature.** The label could be misread as hiding the call from the GM or other Players.
   Mitigation: keep queue visibility unchanged (all active calls visible to all participants); document in the Task 14 file-top comment; optionally add a tooltip on the button in Task 10 noting "posts the text 'Private Call' to the queue".
5. **Index coverage.** Adding `kind` to query predicates could tempt adding a new index unnecessarily.
   Mitigation: do not add any index; all reads are scoped by `(gameId, isActive)` and filter `kind` in memory — `activeCalls` already `.collect()`s the full active set.

## Alternative Approaches

1. **Separate `customCalls` table.** Keep `calls` schema unchanged; route custom calls through a new table and merge at query time.
   Trade-offs: avoids a schema change, but duplicates the "one active per player" invariant across two tables, doubles the indexes, complicates FIFO ordering across tables, and makes GM removal non-uniform. Rejected as materially more complex for negligible isolation benefit.
2. **Discriminated-union mutation args on `addOrReplaceCall`.** Instead of a new mutation, extend the existing one to accept `v.union(v.object({ minionId }), v.object({ label }))`.
   Trade-offs: slightly fewer public APIs, but conflates two distinct user intents behind one name and forces every call-site — and every test — to disambiguate via a runtime discriminator. The proposed split (minion vs custom mutation) reads better in client code and keeps the Private button's implementation trivially a one-liner.
3. **Make "Private" a first-class visibility flag.** Treat Private Call as a GM-only or originator-only visible call rather than a public "Private Call" label.
   Trade-offs: introduces a visibility model on top of the queue with meaningful UX implications, contradicts the feedback ("just creates a custom call with the text 'Private Call'"), and risks scope creep into per-Player queue filtering. Rejected per the explicit feedback.
