# Current Call rail section (GM-only)

## Objective

Add a new GM-only section titled **"Current Call"** at the **top** of the
right rail on the game detail page. The section deep-dives into whatever
call is at the head of the FIFO call queue (Rule 22) so the GM has every
piece of context in front of them while a call is active:

- the queue's top call (caller name, minion name, time created),
- the called minion (name, accent, description, skills),
- the latest 5 notes on that minion, displayed inline (no popover),
- an inline "add a new note" form targeting that minion,
- the minion's owning syndicate (name, leader),
- the syndicate's drawbacks (name + description).

When the queue is empty the section renders a quiet "No active call"
state, but is still visible so the GM knows it exists. The section does
not appear for Players, and does not appear in the `ready` state (the
rail itself isn't rendered then — `src/pages/GameDetailPage.tsx:74-103`).

## Project structure summary

- Right rail lives in `GameDetailPage.tsx:104-122` inside the
  `<aside className="game-rail">` and currently contains
  **Call Queue** + **POWER Standings**. The new section must be inserted
  **before** the existing `<section><h3>Call Queue</h3>…</section>` and
  gated by `viewer.isGm`.
- The mobile bottom drawer mirrors the rail in
  `GameDetailPage.tsx:1988-2012`. For parity, the new section should
  also be added there (GM-only).
- Backend FIFO ordering, GM-only call removal, and existing query shape
  for active calls are in `convex/calls.ts:97-138`. `activeCalls` already
  joins to player display name + minion name but does **not** include
  description, accent, skills, syndicate, or drawbacks.
- Notes API: `convex/notes.ts:158-231` (`listNotesForTarget`) already
  returns newest-first and respects GM full-visibility. Limiting to 5
  newest can be done client-side with `.slice(0, 5)`.
- Inline note rendering + the "post a note" form already exist inside
  the popover at `src/components/NoteIcon.tsx:200-318`, but are tightly
  coupled to popover positioning. They are good source material for an
  extracted, layout-agnostic component pair.
- Auth helpers used by the new query: `requireGameGm` from
  `convex/lib/auth.ts:53-63`.
- Drawback model + access in `convex/drawbacks.ts:83-93`.
- Syndicate model + access in `convex/syndicates.ts:204-235`. NOTE:
  `getWithChildren` only returns rows for which the viewer is owner or
  the syndicate is `isShared`, so the GM cannot rely on it for an
  arbitrary player-selected syndicate. The new query must read
  syndicate + drawbacks directly with GM authorisation.

## Key findings & rationale

1. **Single GM-only aggregator query is the right shape.** Composing
   the data on the client from `activeCalls` + `minions.listForSyndicate`
   + `drawbacks.listForSyndicate` + `syndicates.getWithChildren`
   would (a) require multiple round trips, (b) leak Convex semantic
   constraints (e.g. `getWithChildren` returning `null` to GMs of
   non-shared syndicates), and (c) couple unrelated UI to multiple
   subscriptions. A single new query co-locates GM-only authorisation
   and returns exactly what the section renders.

2. **Reuse note rendering, not the popover.** The popover in
   `NoteIcon.tsx` does positioning work the rail does not need.
   Extracting two small, layout-agnostic components — a list renderer
   and a create form — keeps a single source of truth for note display
   and authoring while letting the rail render them inline.

3. **Notes are already correctly scoped.** `listNotesForTarget` for a
   `minion` target returns newest-first; the GM sees every note (Rule
   from `notes.ts:158-209`). The rail just needs to slice to 5.

4. **Live-by-default.** Convex `useQuery` subscriptions auto-invalidate.
   Posting a note via the existing `api.notes.createNote` mutation will
   update both the inline list and any badge counts elsewhere on the
   page without manual refresh.

5. **No schema changes required.** All needed data already exists in
   `calls`, `minions`, `syndicates`, `drawbacks`, and `notes`.

## Implementation Plan

### Backend: GM-only "current call details" query

- [ ] Task 1. Add a new query `getCurrentCallDetails` to
      `convex/calls.ts` that takes `{ gameId }` and runs `requireGameGm`
      to enforce GM-only access (Rule 24, server-side regardless of UI).
      Return shape:
      ```
      | null
      | {
          call: {
              _id: Id<"calls">,
              createdAt: number,
              playerId: Id<"players">,
              playerName: string,
          },
          minion: {
              _id: Id<"minions">,
              name: string,
              accent: string | null,
              description: string | null,
              skills: string[],
          },
          syndicate: {
              _id: Id<"syndicates">,
              name: string,
              leader: string,
              drawbacks: Array<{
                  _id: Id<"drawbacks">,
                  name: string,
                  description: string,
              }>,
          },
        }
      ```
      Returning `null` when the queue is empty keeps the contract
      explicit and avoids ambiguous "stub" data on the client.

- [ ] Task 2. Implement the query body by reading the head of the FIFO
      with the existing index `by_game_active_time` and `take(1)`,
      mirroring `activeCalls` (`convex/calls.ts:114-120`) so ordering
      stays consistent. Resolve the player → user (display name fall-
      backs already used at `calls.ts:130-134`), the minion, the
      syndicate, and its drawbacks (sorted by `order` ascending,
      matching `drawbacks.listForSyndicate`).

- [ ] Task 3. Defensive nulls: if the head call's `minionId` no longer
      resolves (e.g. minion deletion cascade) or the syndicate is gone,
      return `null` rather than partial data, so the UI can render the
      empty state safely.

- [ ] Task 4. Add backend tests in a new `convex/calls.test.ts` (or
      reuse the existing one if present) covering:
      - returns `null` when queue is empty,
      - returns the FIFO **head** when multiple calls exist (verify by
        creating two calls in order),
      - includes minion `skills`/`accent`/`description` and the
        syndicate's drawbacks (sorted by `order`),
      - throws for non-GM participants and for non-participants,
      - is unaffected by removed (soft-deleted) calls (i.e. `isActive
        = false` rows are skipped).
      Follow the existing patterns in `convex/notes.test.ts:111-573` and
      `convex/calls`-adjacent test fixtures.

### Frontend: extract reusable inline note components

- [ ] Task 5. Refactor `src/components/NoteIcon.tsx` to extract two
      layout-agnostic exports without changing the popover's external
      behaviour:
      - `NoteList`: takes `notes` (array result type from
        `api.notes.listNotesForTarget`) plus `onDelete` and renders the
        existing item layout from `NoteIcon.tsx:229-269`.
      - `NoteCreateForm`: takes `gameId` + `target: NoteTarget` and
        renders the existing `<form>` from `NoteIcon.tsx:271-315`,
        including visibility toggle and immutability footer.
      The popover continues to use these components internally so we
      keep one source of truth. Rationale: the rail must render the
      same author/visibility/delete affordances inline as the popover
      does in a floating panel.

- [ ] Task 6. Update `NoteIcon.tsx`'s popover to consume the extracted
      components, keeping the public `NoteIcon` props identical so no
      callers change.

### Frontend: render the rail section

- [ ] Task 7. Create a new `CurrentCallRail` component in
      `src/pages/GameDetailPage.tsx` (co-located beside `CallQueueRail`,
      `PowerStandingsRail`). Props: `{ gameId, viewerIsGm,
      noteCounts? }`. Skips the underlying query with `"skip"` when
      `!viewerIsGm` so non-GMs never subscribe.

- [ ] Task 8. Inside `CurrentCallRail`, subscribe to
      `api.calls.getCurrentCallDetails` (Task 1) and the existing
      `api.notes.listNotesForTarget` for the head call's minion (skipped
      until the call resolves). Render in this vertical order using the
      existing `card tight` / `row-divider` / `badge` styles already
      used in the rail:
      1. **Header**: `<strong>{playerName}</strong> → <strong>{minionName}</strong>`
         with the call's relative/local time and a small "Remove call"
         button (reusing the same handler shape as `CallQueueRail`,
         `GameDetailPage.tsx:1396-1403`).
      2. **Minion details**: accent (muted suffix), description
         (whitespace-pre-wrap), and skills as badges. Reuse the visual
         language from the existing minion buy panel
         (`GameDetailPage.tsx:1202-1232`) and `SelectedSyndicateDetails`
         (`GameDetailPage.tsx:1900-1933`) for consistency.
      3. **Syndicate**: name + "Leader …" muted line. Optional `Link`
         to the syndicate editor mirrors
         `GameDetailPage.tsx:1939-1941` but is purely informational.
      4. **Drawbacks**: list in the same shape as
         `SelectedSyndicateDetails` (`GameDetailPage.tsx:1872-1888`):
         bold name + muted description.
      5. **Latest notes (≤5)**: `NoteList` (Task 5) fed with the first
         5 of the `listNotesForTarget` result. Above the list,
         show a small heading like "Latest notes" with the visible
         count and, if more than 5 exist, a muted hint like "+N older"
         (still discoverable via the existing `NoteIcon` on the minion
         row in the roster). No popover; rendering is fully inline.
      6. **Add a new note**: `NoteCreateForm` (Task 5) bound to
         `{ kind: "minion", minionId }`. Defaults visibility to
         `private` to match popover behaviour.

- [ ] Task 9. Empty state: when `getCurrentCallDetails` returns `null`,
      render the section with a single muted line: "No active call." so
      the section's presence remains discoverable.

- [ ] Task 10. Loading state: while either query is `undefined`, render
      the section with a muted "Loading…" placeholder; do not flash the
      empty state.

- [ ] Task 11. Insert the `<section><h3>Current Call</h3>{...}</section>`
      block in the rail JSX **above** the existing Call Queue section
      at `GameDetailPage.tsx:104-112`, gated by `viewer.isGm`. The
      existing rail order (Call Queue → POWER Standings) is preserved
      below it.

- [ ] Task 12. Mirror the new section inside the mobile bottom drawer
      at `GameDetailPage.tsx:1988-2012`, again gated on `viewer.isGm`,
      so GM mobile users get the same workflow. Place it as the first
      `<section>` inside the drawer.

### Styling / UX consistency

- [ ] Task 13. Reuse existing utility classes only — `card tight`,
      `row`, `row-wrap`, `row-divider`, `badge`, `muted`, `stack`,
      `error-text`. Do not introduce new global CSS unless a clear need
      emerges; the rail already has compact-card sizing rules at
      `src/index.css:465-498`.

- [ ] Task 14. Make sure long minion descriptions and note bodies wrap
      with `white-space: pre-wrap` (already used elsewhere) so the rail
      doesn't horizontally overflow on narrow viewports.

### Tests

- [ ] Task 15. Backend tests as specified in Task 4. Co-locate with
      existing `convex/*.test.ts` patterns and use the same fixtures
      helpers used by `convex/notes.test.ts`.

- [ ] Task 16. (Optional but recommended) A targeted UI smoke check via
      the existing test setup if the project has one — otherwise rely
      on backend coverage plus manual verification per the verification
      criteria below.

## Verification Criteria

- A GM viewing a `playing`-state game sees the **Current Call** section
  at the very top of the right rail, above the existing Call Queue.
- A Player viewing the same game does **not** see the section, and no
  query for `getCurrentCallDetails` is issued from their client.
- In the `ready` and `archived` states the rail behaviour is unchanged
  (rail hidden in `ready`; in `archived` the section renders read-only
  data and the "post note" form is still functional because notes are
  game-scoped, not state-locked — confirm against `notes.ts` behaviour).
- When the queue is empty the section shows "No active call."
- When a player adds or replaces their call, the section updates
  automatically (Convex live query) to reflect the new head.
- The displayed call is the **FIFO head** (oldest active `createdAt`),
  matching `Call Queue` ordering.
- Minion skills are listed in their stored order; minion description
  and accent render when present.
- Syndicate name + leader render; drawbacks render in `order`
  ascending, matching the editor's display order.
- The latest 5 notes appear inline (newest-first); GM-deletable; no
  popover anywhere in this section.
- The "add a new note" form posts to the correct minion target and the
  new note appears in the inline list immediately, in the popover on
  the minion row, and the badge count on that minion's `NoteIcon`
  increments — confirming a single source of truth.
- Removing the call via the inline button clears it and (if there is a
  next call) the section re-populates with the new head.
- A non-GM cannot reach the underlying query: calling
  `api.calls.getCurrentCallDetails` from a Player session throws
  "Only the Game Master can perform this action."
- All new and existing backend tests pass (`npm test` / Convex test
  runner).

## Potential Risks and Mitigations

1. **Stale or partial joins after cascading deletes.**
   If a minion or syndicate is removed mid-game, the head call could
   reference a missing entity.
   Mitigation: Task 3 — return `null` from `getCurrentCallDetails`
   when any required join is missing, and let the UI render its empty
   state.

2. **Refactoring the popover regresses note authoring elsewhere.**
   Extracting `NoteList`/`NoteCreateForm` from `NoteIcon.tsx` could
   subtly change layout/behaviour for every note popover on the page.
   Mitigation: keep the extracted components purely visual, leave
   positioning/keyboard handling in the popover wrapper, and verify
   that the popover renders identically to its pre-refactor form.

3. **Performance: extra subscription per render.**
   Adding two live queries (current-call details + minion notes) on the
   GM's screen is cheap individually but compounds with the existing
   `getNoteCountsForGameView`, `activeCalls`, and ledger queries.
   Mitigation: use `"skip"` whenever `!viewerIsGm` or when the head
   call is absent, so non-GMs and empty-queue states issue zero extra
   subscriptions.

4. **Mobile rail height.**
   On narrow viewports the bottom drawer could become very tall once
   skills + drawbacks + 5 notes + a form are stacked.
   Mitigation: keep typography compact, prefer existing `card tight`,
   and let the drawer scroll (it already does); cap the inline note
   list at 5 by design.

5. **Authorisation drift.**
   If `requireGameGm` semantics ever change, the new query could leak
   data.
   Mitigation: rely exclusively on `requireGameGm` (no ad-hoc checks),
   and add a backend test that explicitly verifies a Player session is
   rejected (Task 4).

## Alternative Approaches

1. **Compose on the client without a new query.**
   Use `activeCalls` (head only), `minions.listForSyndicate`,
   `drawbacks.listForSyndicate`, and a small extension to get the
   syndicate document. Trade-off: more round trips, more client
   plumbing, harder to enforce GM-only data exposure for an arbitrary
   player-selected syndicate (current `getWithChildren` returns `null`
   for non-shared syndicates the GM doesn't own — would require either
   relaxing that contract or duplicating logic).

2. **Embed the new section inside `CallQueueRail` instead of as a
   sibling.**
   Could promote the queue's first item into a "rich" card and render
   the rest as the existing slim list. Trade-off: muddles the pure
   FIFO list semantics, makes the queue component significantly
   larger, and complicates note-form ownership. A separate sibling
   section is cleaner and matches the user's "extra section at the top
   of the right rail" wording.

3. **Reuse the popover inline by un-anchoring it.**
   Render `NotesPopover` with `position: static` styling. Trade-off:
   leaks popover-specific markup (close button, dialog role) into a
   non-modal context; clearer to extract presentational sub-components
   instead (Task 5).

4. **Skip the inline create form; link to the existing minion
   `NoteIcon`.**
   Cheaper, but the user explicitly asked for an inline "section for
   adding a new note to that minion." Rejected.
