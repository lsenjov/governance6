# Current Call section (GM-only)

## Objective

Add a new GM-only section titled **"Current Call"** at the **top** of the
**main (right) column** on the game detail page, above the Roster. The
section deep-dives into whatever call is at the head of the FIFO call
queue (Rule 22) so the GM has every piece of context in front of them
while a call is active:

- the queue's top call (caller name, minion name, time created),
- the called minion (name, accent, description, skills),
- the latest 5 notes on that minion, displayed inline (no popover),
- an inline "add a new note" form targeting that minion,
- the minion's owning syndicate (name, leader),
- the syndicate's drawbacks (name + description).

When the queue is empty the section renders a quiet "No active call"
state, but is still visible so the GM knows it exists. The section does
not appear for Players, and does not appear in the `ready` state (the
left rail isn't rendered then either —
`src/pages/GameDetailPage.tsx:74-103`). It is rendered inside
`<div className="game-main">` so it occupies the same wide column as
Roster / Public Bid / Treason Grants / Goals, giving the GM enough
horizontal real estate for a side-by-side context-and-notes layout.

## Project structure summary

- The page is a two-column grid:
  `grid-template-columns: var(--rail-width) minmax(0, 1fr)`
  (`src/index.css:439-444`). The narrow **left rail**
  (`<aside className="game-rail">`, `GameDetailPage.tsx:104-122`)
  currently holds **Call Queue** + **POWER Standings**. The wider **main
  (right) column** (`<div className="game-main">`,
  `GameDetailPage.tsx:125-189`) holds **Roster**, **PublicBidSection**,
  **TreasonGrantsSection**, **GoalsSection**. The new section must be
  inserted as the **first child** of `<div className="game-main">`,
  above the existing Roster `<section>`, gated by `viewer.isGm`.
- The mobile bottom drawer (`GameDetailPage.tsx:1988-2012`) only
  mirrors the **left rail** content (Queue + POWER). The new section
  lives in `game-main`, which on narrow viewports already stacks below
  the rail (or alone when `single-column`); no drawer mirroring is
  required.
- Backend FIFO ordering, GM-only call removal, and the existing query
  shape for active calls are in `convex/calls.ts:97-138`. `activeCalls`
  already joins to player display name + minion name but does **not**
  include description, accent, skills, syndicate, or drawbacks.
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
- A reusable two-column wrapper `section-grid`
  (`src/index.css:339-359`) collapses to a single column under 900px
  and is already used by the Syndicate Editor; it is a natural fit for
  the new section's "context on the left, notes on the right" layout.

## Key findings & rationale

1. **Main column, not the left rail.** The section bundles call header
   + minion descriptors + skills as badges + syndicate + drawbacks +
   five inline notes + an inline create form. That is far too much
   content for a narrow sidebar (`var(--rail-width)`); placing it in
   `game-main` (a) gives it the horizontal room it needs, (b) lets the
   notes panel sit beside the call/minion context using the existing
   `section-grid` two-column rule, and (c) keeps the left rail's
   purpose tight (live queue + standings only).

2. **Single GM-only aggregator query is the right shape.** Composing
   the data on the client from `activeCalls` + `minions.listForSyndicate`
   + `drawbacks.listForSyndicate` + `syndicates.getWithChildren`
   would (a) require multiple round trips, (b) leak Convex semantic
   constraints (e.g. `getWithChildren` returning `null` to GMs of
   non-shared syndicates), and (c) couple unrelated UI to multiple
   subscriptions. A single new query co-locates GM-only authorisation
   and returns exactly what the section renders.

3. **Reuse note rendering, not the popover.** The popover in
   `NoteIcon.tsx` does positioning work the section does not need.
   Extracting two small, layout-agnostic components — a list renderer
   and a create form — keeps a single source of truth for note display
   and authoring while letting the new section render them inline.

4. **Notes are already correctly scoped.** `listNotesForTarget` for a
   `minion` target returns newest-first; the GM sees every note (Rule
   from `notes.ts:158-209`). The new section just needs to slice to 5.

5. **Live-by-default.** Convex `useQuery` subscriptions auto-invalidate.
   Posting a note via the existing `api.notes.createNote` mutation will
   update both the inline list and any badge counts elsewhere on the
   page without manual refresh.

6. **No schema changes required.** All needed data already exists in
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

- [ ] Task 4. Add backend tests in a new `convex/calls.test.ts`
      covering:
      - returns `null` when queue is empty,
      - returns the FIFO **head** when multiple calls exist (verify by
        creating two calls in order),
      - after `removeCall` on the head, the query returns the **next**
        head (exercises the verification criterion that the section
        re-populates with the new head),
      - includes minion `skills`/`accent`/`description` and the
        syndicate's drawbacks (sorted by `order`),
      - throws for non-GM participants and for non-participants.
      Follow the existing patterns in `convex/notes.test.ts:111-573` and
      `convex/calls`-adjacent test fixtures.

      Note: defensive-null tests for missing minion/syndicate are
      omitted because once a game enters `playing` state, syndicates
      lock and their minions cannot be deleted, so the missing-join
      branch (Task 3) is purely defence-in-depth and not reachable
      via the supported game lifecycle.

### Frontend: extract reusable inline note components

- [ ] Task 5. Refactor `src/components/NoteIcon.tsx` to extract two
      layout-agnostic exports without changing the popover's external
      behaviour:
      - `NoteList`: takes `notes` (array result type from
        `api.notes.listNotesForTarget`) plus `onDelete` and renders the
        existing item layout from `NoteIcon.tsx:229-269`.
      - `NoteCreateForm`: takes `gameId` + `target: NoteTarget` and
        renders the existing `<form>` from `NoteIcon.tsx:271-315`,
        including visibility toggle and immutability footer. Use
        `React.useId()` to generate unique ids for the textarea and
        visibility checkbox (and matching `htmlFor`) so multiple
        instances on the page (popover + main-column section) don't
        collide on the currently-hardcoded `note-body` /
        `note-visibility` ids (`NoteIcon.tsx:282, 298`).
      Also export the existing `NoteTarget` type (`NoteIcon.tsx:6-9`)
      and the `buildListArgs` helper (`NoteIcon.tsx:320`) so the new
      section can construct list-query args identically.
      The popover continues to use these components internally so we
      keep one source of truth. Rationale: the new section must render
      the same author/visibility/delete affordances inline as the
      popover does in a floating panel.

- [ ] Task 6. Update `NoteIcon.tsx`'s popover to consume the extracted
      components, keeping the public `NoteIcon` props identical so no
      callers change.

### Frontend: render the main-column section

- [ ] Task 7. Create a new `CurrentCallSection` component in
      `src/pages/GameDetailPage.tsx`, co-located beside the other
      main-column section components (e.g. near `PublicBidSection`,
      `TreasonGrantsSection`). Props: `{ gameId, viewerIsGm }` —
      match the existing main-column convention (`viewerIsGm`,
      `GameDetailPage.tsx:141, 147`) rather than the left rail's
      `isGm` shorthand. The component returns `null` when
      `!viewerIsGm`, and skips its underlying queries with `"skip"`
      when `!viewerIsGm` so non-GMs never subscribe.

- [ ] Task 8. Inside `CurrentCallSection`, subscribe to
      `api.calls.getCurrentCallDetails` (Task 1) and the existing
      `api.notes.listNotesForTarget` for the head call's minion (skipped
      until the call resolves). Layout:

      The outer wrapper is a `<section>` with an `<h3>Current Call</h3>`
      heading (matching neighbouring main-column sections like
      `Roster` at `GameDetailPage.tsx:127`).

      Inside, render a header row spanning the full width:

      - **Header row** (full width, above the two columns):
        `<strong>{playerName}</strong> → <strong>{minionName}</strong>`,
        the call's relative/local time, and a "Remove call" button on
        the right (reuse the same handler shape as `CallQueueRail`,
        `GameDetailPage.tsx:1396-1403`).

      Below the header, use the existing `section-grid` class
      (`src/index.css:339-359`) to render two columns that collapse to
      one under 900px:

      - **Left column — Context** (`<section>`):
        1. **Minion details**: accent (muted suffix), description
           (whitespace-pre-wrap), and skills as `badge`s. Reuse the
           visual language from the existing minion buy panel
           (`GameDetailPage.tsx:1202-1232`) and
           `SelectedSyndicateDetails`
           (`GameDetailPage.tsx:1900-1933`).
        2. **Syndicate**: name + "Leader …" muted line. No link to
           the syndicate editor — the GM may not have permission to
           open a player-owned, non-shared syndicate, and the section
           is informational, not navigational.
        3. **Drawbacks**: list in the same shape as
           `SelectedSyndicateDetails` (`GameDetailPage.tsx:1872-1888`):
           bold name + muted description.

      - **Right column — Notes** (`<section>`):
        1. **Latest notes (≤5)**: a small heading "Latest notes"
           with the visible count, then `NoteList` (Task 5) fed with
           the first 5 of the `listNotesForTarget` result. If more
           than 5 exist, show a muted hint like "+N older" beneath
           the list (still discoverable via the existing `NoteIcon`
           on the minion row in the roster). No popover; rendering
           is fully inline.
        2. **Add a new note**: heading "Add a note", then
           `NoteCreateForm` (Task 5) bound to
           `{ kind: "minion", minionId }`. Defaults visibility to
           `private` to match popover behaviour.

      Use existing utility classes only — `card`, `card tight`,
      `row`, `row-wrap`, `row-divider`, `badge`, `muted`, `stack`,
      `error-text`, `section-grid`. No new global CSS.

- [ ] Task 9. Empty state: when `getCurrentCallDetails` returns `null`,
      render the `<section>` with the `<h3>` heading and a single
      muted line: "No active call." (no two-column body). The section
      stays present so the GM knows it exists.

- [ ] Task 10. Loading state: while `getCurrentCallDetails` is
      `undefined`, render the section with a muted "Loading…"
      placeholder; do not flash the empty state.

- [ ] Task 11. Insert `<CurrentCallSection gameId={gid}
      viewerIsGm={viewer.isGm} />` as the **first child** of
      `<div className="game-main">` at `GameDetailPage.tsx:125`,
      **above** the existing `Roster` `<section>`. The component
      itself returns `null` for non-GMs, so no extra outer guard is
      required, but the placement only renders meaningfully in
      states where the main column is shown (i.e. when `gid` is set
      and `view` has resolved — already enforced by the early
      returns at `GameDetailPage.tsx:66-69`). Note that in `ready`
      state the left rail is hidden but the main column still
      renders; the section will display "No active call." there
      because no calls can exist (`convex/calls.ts:26-28`).

- [ ] Task 12. (No mobile-drawer change.) The mobile bottom drawer
      (`GameDetailPage.tsx:1988-2012`) only mirrors the **left rail**
      (Call Queue + POWER Standings). Because `CurrentCallSection`
      lives in `game-main`, on narrow viewports it already stacks in
      the natural document flow alongside Roster / Public Bid /
      Treason Grants / Goals; no drawer mirroring is needed and the
      drawer's contents are intentionally left unchanged.

### Styling / UX consistency

- [ ] Task 13. Reuse existing utility classes only — `card`,
      `card tight`, `row`, `row-wrap`, `row-divider`, `badge`,
      `muted`, `stack`, `error-text`, `section-grid`. Do not
      introduce new global CSS unless a clear need emerges; the main
      column already has the spacing rules at
      `src/index.css:450-463`, and `section-grid`
      (`src/index.css:339-359`) provides the responsive two-column
      behaviour for free.

- [ ] Task 14. Make sure long minion descriptions and note bodies wrap
      with `white-space: pre-wrap` (already used elsewhere) so the
      section doesn't horizontally overflow on narrow viewports, and
      verify the `section-grid` collapse at 900px reflows cleanly
      (Context above, Notes below) without layout shift.

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
  as the **first** section in the main (right) column, above Roster.
- A Player viewing the same game does **not** see the section, and no
  query for `getCurrentCallDetails` is issued from their client.
- In the `ready` state the left rail is hidden but the main column
  still renders; the section shows "No active call." (calls require
  `game.state === "playing"`, `convex/calls.ts:26-28`). In `archived`
  the same "No active call." state is shown for the same reason.
- When the queue is empty the section shows "No active call."
- When a player adds or replaces their call, the section updates
  automatically (Convex live query) to reflect the new head.
- The displayed call is the **FIFO head** (oldest active `createdAt`),
  matching `Call Queue` ordering in the left rail.
- Minion skills are listed in their stored order; minion description
  and accent render when present.
- Syndicate name + leader render; drawbacks render in `order`
  ascending, matching the editor's display order.
- At ≥900px viewport, the Context column (minion + syndicate +
  drawbacks) and the Notes column (latest 5 + create form) sit
  side-by-side via `section-grid`. Below 900px they stack
  Context-then-Notes without overflow.
- The latest 5 notes appear inline (newest-first); GM-deletable; no
  popover anywhere in this section.
- The "add a note" form posts to the correct minion target and the
  new note appears in the inline list immediately, in the popover on
  the minion row, and the badge count on that minion's `NoteIcon`
  increments — confirming a single source of truth.
- Removing the call via the inline "Remove call" button clears it and
  (if there is a next call) the section re-populates with the new
  head.
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

4. **Section pushes Roster below the fold for GMs.**
   On short viewports the new section will sit above Roster and may
   require scrolling to reach the roster.
   Mitigation: keep the section compact when collapsed (empty state
   is a single muted line), keep typography compact in the populated
   state via `card tight`, and rely on the natural sticky left rail
   to keep Call Queue + POWER visible without scrolling. The trade-off
   (richer current-call context vs. one-screen Roster) is intentional
   and matches the user's request to deep-dive the active call for
   the GM.

5. **Authorisation drift.**
   If `requireGameGm` semantics ever change, the new query could leak
   data.
   Mitigation: rely exclusively on `requireGameGm` (no ad-hoc checks),
   and add a backend test that explicitly verifies a Player session is
   rejected (Task 4).

## Alternative Approaches

1. **Place the section in the left rail (original v1 plan).**
   Rejected: the left rail is `var(--rail-width)` wide and is sized
   for compact lists (queue + standings). The section's content
   (description, skills as badges, syndicate, drawbacks, five notes,
   create form) is data-rich and benefits from a side-by-side
   Context/Notes layout the rail cannot give without ugly wrapping or
   custom rules. Putting it in `game-main` reuses `section-grid` for
   free.

2. **Compose on the client without a new query.**
   Use `activeCalls` (head only), `minions.listForSyndicate`,
   `drawbacks.listForSyndicate`, and a small extension to get the
   syndicate document. Trade-off: more round trips, more client
   plumbing, harder to enforce GM-only data exposure for an arbitrary
   player-selected syndicate (current `getWithChildren` returns `null`
   for non-shared syndicates the GM doesn't own — would require either
   relaxing that contract or duplicating logic).

3. **Embed the new section inside `CallQueueRail` instead of as a
   sibling.**
   Could promote the queue's first item into a "rich" card and render
   the rest as the existing slim list. Trade-off: muddles the pure
   FIFO list semantics, makes the queue component significantly
   larger, complicates note-form ownership, and still leaves the
   rich content trapped in the narrow left rail.

4. **Reuse the popover inline by un-anchoring it.**
   Render `NotesPopover` with `position: static` styling. Trade-off:
   leaks popover-specific markup (close button, dialog role) into a
   non-modal context; clearer to extract presentational sub-components
   instead (Task 5).

5. **Skip the inline create form; link to the existing minion
   `NoteIcon`.**
   Cheaper, but the user explicitly asked for an inline "section for
   adding a new note to that minion." Rejected.
