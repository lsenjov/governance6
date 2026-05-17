# Notes for Minions in the Recently Removed Calls list

## Objective

Add a `<NoteIcon>` to each `kind === "minion"` row in the **Recently
removed calls** section of the Game Log drawer, mirroring the existing
inline-icon pattern used everywhere else a minion name is rendered
(roster, current-call section, call queue rail). The icon must:

- target the minion (`{ kind: "minion", minionId }`), not the removed
  call row,
- show the same badge count as the icon for the same minion elsewhere
  on the page (i.e. fed by the existing
  `useNotesCountMap(gameId)` subscription via `resolveNoteCount`),
- open the same `<NotesPopover>` UI used everywhere else (popover
  position, create form, GM-only delete, etc.), and
- respect the per-game **Hide management controls** toggle exactly
  the same way the other in-game `<NoteIcon>` instances do.

Custom-call rows (`kind === "custom"`) are intentionally untouched —
they have no minion to point at.

Players see the same notes here that they would see on the same minion
anywhere else in the app (no extra GM gating). Per `feedback`:

> "Players should see same notes they would see on minions elsewhere."

This is strictly a client-side change. No Convex schema, query, or
mutation changes. The existing `api.calls.recentlyRemovedCalls` payload
already carries `minionId` on minion rows
(`convex/calls.ts:548-557`, `:600-608`), and the existing
`api.notes.*` surface already covers minion-target notes.

Per the same `feedback` thread:

> "3. No opinion, minions should not be deleted."

So the dangling-minion edge case is treated as out-of-scope: minions
are never hard-deleted, and `recentlyRemovedCalls` already falls back
to the literal string `"Unknown Minion"` when the id no longer
resolves (`convex/calls.ts:607`). If this invariant is ever violated,
the icon will simply render a popover that lists "No notes yet." — no
UI breakage, no privacy leak (the visibility check inside
`api.notes.listNotesForTarget` still runs on the id).

## Project Structure Summary

- Convex backend (no changes): the read driving this UI is
  `recentlyRemovedCalls` at `convex/calls.ts:559-612`. Its row shape is
  the discriminated union `RemovedCallRow` at
  `convex/calls.ts:548-557`. Notes API is `convex/notes.ts:1-826`
  (untouched).
- React client: the Game Log drawer lives in
  `src/pages/GameDetailPage.tsx:807-874` (`GameLogDrawer`). It is
  rendered by `GameHud` at `src/pages/GameDetailPage.tsx:320-322`.
  `GameHud` already receives `hideManagementControls`
  (`src/pages/GameDetailPage.tsx:244-256`) and can forward it to
  `GameLogDrawer` without any new plumbing through
  `GameDetailPage`.
- Shared note UI: `<NoteIcon>` and `NoteTarget` are at
  `src/components/NoteIcon.tsx:14-108`. The badge-count hook is
  `useNotesCountMap` / `resolveNoteCount` at
  `src/hooks/useNotesCountMap.ts:10-51` (already covers
  `kind: "minion"` targets).
- Authoritative rules: `plans/2026-04-20-init-v4.md` (game rules) +
  `plans/2026-04-20-notes-feature-v3.md` (notes feature). Nothing in
  those rules changes here.

## Relevant Files Examination

- `src/pages/GameDetailPage.tsx:823-874` — `GameLogDrawer`. Today it
  takes `{ gameId, onClose }` only. The minion-row branch lives at
  `:847-851` and currently renders only the minion name. We need to
  drop a `<NoteIcon>` next to that strong tag and pass the new
  `noteCounts` + `hideManagementControls` props through the
  component signature.
- `src/pages/GameDetailPage.tsx:320-322` — `GameLogDrawer` call site
  in `GameHud`. We need to forward `hideManagementControls` (already
  in scope here at `:244-256`) and the new `noteCounts` value.
- `src/pages/GameDetailPage.tsx:81-92` and `:235-256` — `GameHud`
  prop signature + props passed in from the page. `GameHud` does not
  currently receive `noteCounts`; it only receives the precomputed
  `gameNoteCount` scalar (`:243`). We have two options for
  propagation; see Design Decision 2 below — **flagged for review**.
- `src/components/NoteIcon.tsx:14-108` — `<NoteIcon>` + `NoteTarget`.
  Already covers `kind: "minion"`. No change.
- `src/hooks/useNotesCountMap.ts:10-51` — single shared subscription
  the rest of the page already uses. Already covers `byMinion`. No
  change.
- `convex/calls.ts:548-612` — `recentlyRemovedCalls` shape. Today
  `kind === "minion"` rows already carry `minionId: Id<"minions">`
  on the wire (`:600-608`). No change.
- `src/pages/GameDetailPage.tsx:1152-1169` — reference implementation
  of the inline-icon pattern (NoteIcon next to a strong tag, wrapped
  in `<span onClick={(e) => e.stopPropagation()} style={{ display:
  "inline-flex" }}>`). Copy this convention.

## Design Decisions & Assumptions

1. **Client-only change.** `recentlyRemovedCalls` already returns
   `minionId` on minion rows; the notes API already lists minion
   notes; the count map already provides `byMinion`. The entire
   change is wiring up one inline `<NoteIcon>` plus the props that
   feed it. No schema or query edits.

2. **Plumbing `noteCounts` to `GameLogDrawer` — REVIEW REQUEST.** Two
   sensible options; both keep the wire format unchanged:

   **Option A (preferred).** Thread `noteCounts` through `GameHud`
   into `GameLogDrawer`. Pros: zero new subscriptions on the client
   (`GameDetailPage` already opens one at
   `src/pages/GameDetailPage.tsx:59`); matches the pattern every
   other section in this file uses (`RosterList`,
   `TreasonGrantsSection`, `GoalsSection`,
   `CallQueueRail`). Cons: widens `GameHud`'s prop surface by one
   parameter.

   **Option B.** Call `useNotesCountMap(gameId)` directly inside
   `GameLogDrawer`. Pros: zero prop changes on `GameHud`. Cons:
   opens a second subscription tracker for the same query (Convex
   client dedupes the actual server query, so the wire cost is
   nil, but it diverges from the convention used everywhere else
   in this file).

   **Default for implementation:** Option A. Reviewer should flag if
   they'd prefer B. Whichever option is chosen, the `<NoteIcon
   count={…}>` value comes from
   `resolveNoteCount(noteCounts, { kind: "minion", minionId })`.

3. **`hideManagementControls` propagation.** `GameHud` already
   receives this prop (`src/pages/GameDetailPage.tsx:244-255`).
   Forward it to `GameLogDrawer` and from there into the new
   `<NoteIcon>` so the per-game toggle applies (suppresses the
   GM-only Delete button inside the popover). Matches the behaviour
   of every other in-game `<NoteIcon>` (see e.g.
   `src/pages/GameDetailPage.tsx:1167`,
   `src/pages/GameDetailPage.tsx:2785`).

4. **Minion rows only.** Per `feedback`: "1. Yes" (scope is minion
   rows only). Custom-call rows render unchanged — they have no
   `minionId` to target, and per Design Decision 4 of
   `plans/2026-04-28-private-and-custom-calls-v2.md` they were never
   wired to a notes target. We do NOT add a goal/grant/syndicate
   note path here.

5. **No dangling-minion handling beyond what already exists.** Per
   `feedback`: "3. No opinion, minions should not be deleted."
   Treat this as an invariant: the server still produces
   `"Unknown Minion"` for that case (`convex/calls.ts:607`), but
   we don't suppress the icon. The popover will list whatever
   notes the visibility filter allows; if the minion has been
   hard-deleted (against the invariant), the popover will show "No
   notes yet." or the count will be 0. No new test for this case
   — it's outside our design contract.

6. **Player vs GM visibility.** Per `feedback`: "4. Players should
   see same notes they would see on minions elsewhere." We do NOT
   add a GM-only gate around the icon. The shared `<NoteIcon>` +
   `api.notes.listNotesForTarget` already handle visibility per the
   notes-feature spec
   (`plans/2026-04-20-notes-feature-v3.md`): public notes are
   visible to every participant; private notes are visible to the
   author and the GM only. Same here.

7. **Icon placement and spacing.** Inline next to
   `<strong>{c.minionName}</strong>` inside the existing row,
   wrapped in `<span onClick={(e) => e.stopPropagation()} style={{
   display: "inline-flex", marginLeft: "0.25rem" }}>`. The
   `display: "inline-flex"` half matches the established convention
   at `src/pages/GameDetailPage.tsx:1152-1169` (and the equivalent
   call sites in `TreasonGrantRow` / `GoalRowView`). The
   `marginLeft: "0.25rem"` is an intentional divergence: every
   other inline-icon parent in this file is a flex container with
   `gap` set (e.g. `<span className="row" style={{ gap:
   "0.5rem" }}>` at `src/pages/GameDetailPage.tsx:1130-1132`), so
   the gap rule produces the inter-element spacing for free. The
   `GameLogDrawer` row at `:844-858` is a plain `<div>` with no
   `gap` and no `row`-class flex behaviour, so we need an explicit
   `marginLeft` to keep the icon from butting up against the
   `<strong>`. The row has no click-handler today, so the
   `stopPropagation` is purely defensive but matches the
   convention.

8. **Label string.** Use `c.minionName` as the bare label — matches
   the roster's `<NoteIcon label={m.name} … />` site. `<NoteIcon>`
   already prefixes its `aria-label` with `"Notes: "`
   (`src/components/NoteIcon.tsx:90`), so passing `c.minionName`
   produces `"Notes: <minion name>"`. Passing `"Notes for <name>"`
   would double up the word "Notes" in screen-reader output.

9. **No new page-level tests; one cheap server-side test.** The
   Game Log drawer is not covered by any vitest snapshot or test
   today (see `src/pages/`'s lack of `.test.tsx` files for
   `GameDetailPage`). The Convex tests for `recentlyRemovedCalls`
   (`convex/calls.test.ts:1428-1564`) and for notes
   (`convex/notes.test.ts`) already cover the underlying behaviour
   we depend on. We add **one** server-side test (Task 6) locking
   the specific invariant this feature surfaces:
   `getNoteCountsForGameView` must still aggregate notes into
   `byMinion[minionId]` after the minion's call has been removed
   (i.e. note counts are scoped by minion id, not by call state).
   Manual smoke test (Task 8) covers the rest.

10. **`noteCounts` loading state.** `useNotesCountMap` returns
    `undefined` during initial load
    (`src/hooks/useNotesCountMap.ts:10-16`); `resolveNoteCount`
    collapses that to `0`
    (`src/hooks/useNotesCountMap.ts:38-39`). The icon therefore
    renders unbadged on first paint and the badge appears once the
    counts hydrate — same behaviour as every other inline
    `<NoteIcon>` on the page. No special-case handling required.

## Implementation Plan

### Phase 1 — Plumbing

- [x] Task 1. Extend `GameLogDrawer`'s prop signature at
      `src/pages/GameDetailPage.tsx:823-829` to add
      `noteCounts: ReturnType<typeof useNotesCountMap>` and
      `hideManagementControls: boolean`. Keep `gameId` and `onClose`
      as-is. The drawer remains presentational — no new
      subscriptions inside it (per Design Decision 2 Option A).

- [x] Task 2. Extend `GameHud`'s prop signature at
      `src/pages/GameDetailPage.tsx:235-256` to add
      `noteCounts: ReturnType<typeof useNotesCountMap>`. `GameHud`
      already receives `hideManagementControls` (`:244-255`), so no
      new prop for that. Forward both into the `GameLogDrawer`
      call site at `src/pages/GameDetailPage.tsx:320-322`:
      ```tsx
      <GameLogDrawer
        gameId={gameId}
        noteCounts={noteCounts}
        hideManagementControls={hideManagementControls}
        onClose={() => setLogOpen(false)}
      />
      ```

- [x] Task 3. Pass `noteCounts` into `GameHud` from
      `GameDetailPage` at `src/pages/GameDetailPage.tsx:81-92`. The
      value is already computed at
      `src/pages/GameDetailPage.tsx:59` (`const noteCounts =
      useNotesCountMap(gid);`), so we just thread the existing
      reference through. The existing `gameNoteCount` scalar prop
      stays — it's used by the game-target icon already inside
      `GameHud` and the new prop is independent.

### Phase 2 — Render the icon

- [x] Task 4. Inside the `removed?.map(...)` block at
      `src/pages/GameDetailPage.tsx:843-863`, extend the minion
      branch (`c.kind === "minion"` at `:847-851`) to render a
      `<NoteIcon>` next to the minion name. Concretely, replace:
      ```tsx
      {c.kind === "minion" ? (
        <>
          <span className="muted"> called </span>
          <strong>{c.minionName}</strong>
        </>
      ) : ( … )}
      ```
      with:
      ```tsx
      {c.kind === "minion" ? (
        <>
          <span className="muted"> called </span>
          <strong>{c.minionName}</strong>
          <span
            onClick={(e) => e.stopPropagation()}
            style={{ display: "inline-flex", marginLeft: "0.25rem" }}
          >
            <NoteIcon
              gameId={gameId}
              target={{ kind: "minion", minionId: c.minionId }}
              count={resolveNoteCount(noteCounts, {
                kind: "minion",
                minionId: c.minionId,
              })}
              label={c.minionName}
              hideManagementControls={hideManagementControls}
            />
          </span>
        </>
      ) : ( … )}
      ```
      `NoteIcon` and `resolveNoteCount` are already imported at the
      top of the file (`src/pages/GameDetailPage.tsx:1-10`). The
      custom branch (`:852-857`) stays unchanged.

      Note on typing: `c.minionId` is `Id<"minions">` directly off
      the `RemovedCallRow` minion variant
      (`convex/calls.ts:548-553`); no cast or `!` is required at
      the call site. The server handler at `convex/calls.ts:606`
      does its own internal cast because the underlying `calls`
      column stores `minionId` as optional — that's a server
      concern that does not leak into the exported `RemovedCallRow`
      type.

### Phase 3 — Verification

- [x] Task 5. `npm run typecheck` (project script: see
      `package.json`) to confirm the new `c.minionId` access
      type-checks. The `kind === "minion"` narrow gives us
      `minionId: Id<"minions">` directly; no cast required.

- [x] Task 6. Add one `convex-test` case in `convex/notes.test.ts`
      that locks Design Decision 9's invariant: note counts are
      scoped by minion id, not by call state. Shape:
      1. Seed a game with one minion and one Player whose call
         targets that minion.
      2. Author both a `public` and a `private` note on the
         minion as the Player while the call is active.
      3. Remove the call (GM-side mutation — use whichever
         existing test helper or call removal mutation
         `notes.test.ts` / `calls.test.ts` peers already use; do
         not introduce a new helper).
      4. Assert `api.notes.getNoteCountsForGameView` for the
         Player returns `byMinion[minionId] === 2`, for the GM
         returns `byMinion[minionId] === 2`, and for a second
         non-author Player returns `byMinion[minionId] === 1`
         (public only).
      5. The assertion fires AFTER call removal — i.e. the count
         is unchanged by the call removal.
      Rationale: this is the exact invariant the new icon surfaces
      and is not already covered — existing `byMinion` tests
      typically assert during an active-call state. One ~15-line
      test catches the most likely future regression.

- [x] Task 7. `npm run lint` and `npm test` to confirm no
      regressions.

- [x] Task 8. Manual smoke test (two browser contexts, GM + Player):
      1. As GM, attach a private note and a public note to a minion
         while their call is at the head of the queue.
      2. Remove the call.
      3. Open the Game Log drawer. The minion row in
         **Recently removed calls** should show the speech-bubble
         icon with a badge count of 2 (GM sees both private and
         public).
      4. As another Player (different from the author) in a second
         window, the same row should show count 1 (public only)
         and the popover should list the public note only.
      5. Toggle **Hide management controls** in GM Tools and
         reopen the popover: the Delete button on listed notes
         should disappear, matching every other `<NoteIcon>`.
      6. Confirm `kind === "custom"` rows in the same list do NOT
         render an icon.

## Verification Criteria

- The minion branch of each Recently Removed Calls row renders a
  `<NoteIcon target={{ kind: "minion", minionId }} />` inline next
  to the minion name; the custom branch is unchanged.
- The badge count on that icon equals the count returned by the
  shared `useNotesCountMap(gameId)` subscription for the same
  minion — i.e. it matches the count shown on the same minion
  anywhere else on the page (roster, current call, call queue
  rail) for the same viewer.
- Clicking the icon opens the standard `<NotesPopover>` with the
  minion's note list, the standard create form, GM-only deletion,
  and the standard visibility filter for the viewer.
- The per-game **Hide management controls** toggle suppresses the
  Delete button on listed notes inside the popover, matching the
  rest of the page.
- No new Convex subscription is opened on the client. No Convex
  query or mutation is changed. No schema field is added.
- Type-check and lint pass; existing tests still pass.

## Potential Risks and Mitigations

1. **Prop drift through `GameHud`.** Adding `noteCounts` to
   `GameHud`'s signature widens its surface by one parameter.
   **Mitigation:** `GameHud` already takes ten-plus props and
   already plumbs `hideManagementControls` and other shared state;
   one more reactive object matches the existing pattern. Reviewer
   may prefer Option B (Design Decision 2) — flagged in plan.

2. **Off-game-id minion target.** A malicious or stale `minionId`
   couldn't leak notes from another game because
   `api.notes.listNotesForTarget` re-validates participation via
   the `gameId` arg (`convex/notes.ts:619-740`). Recently-removed
   rows are always for the current game (the query filters by
   `gameId`, `convex/calls.ts:574-578`), so this risk is theoretical.

3. **Dangling minion id.** Per Design Decision 5, considered
   out-of-scope. If it ever happens, the popover shows an empty list
   and the badge is 0 — no UI failure mode.

4. **Performance.** Each row already renders some text and a date;
   the added `<NoteIcon>` is a small button with a cheap render and
   no extra subscription. The popover is mounted lazily on click.
   No measurable cost.

5. **Accessibility.** The wrapping
   `<span onClick={e => e.stopPropagation()} style={{ display:
   "inline-flex" }}>` is presentational only and carries no
   role/aria. Matches the established pattern at
   `src/pages/GameDetailPage.tsx:1152-1169`. The icon's own
   `aria-label` comes from `<NoteIcon>` itself.

## Alternative Approaches

1. **Inline the note list in the row (no popover).** Rejected —
   diverges from the established pattern. Every other minion-name
   call site in this codebase uses the icon + popover. Consistency
   wins.

2. **Add a GM-only gate so Players don't see this icon in the
   drawer.** Rejected per `feedback` answer 4 — Players see the
   same notes they would see on minions elsewhere; gating only in
   the drawer would be inconsistent.

3. **Render an icon on custom-call rows too, targeting the call
   itself.** Rejected — custom calls have no notes target in the
   data model (`NoteTarget` covers `game`, `syndicate`, `minion`,
   `grant`, `goal` — not calls). Out of scope; would require a
   schema extension.

4. **Suppress the icon when `c.minionName === "Unknown Minion"`.**
   Considered as a defensive measure for the dangling-id case.
   Rejected per Design Decision 5: minions are an invariant, and
   gating on a literal string comparison is fragile (the fallback
   string could change). If we ever start hard-deleting minions,
   address it server-side by widening `RemovedCallRow` to signal
   absence explicitly.
