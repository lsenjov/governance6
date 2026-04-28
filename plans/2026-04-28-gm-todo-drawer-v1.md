# GM Todo Drawer

## Objective

Give the GM a single at-a-glance "todo list" of every note in the
current game that has a clock attached, so the running sheet of
in-flight skill-check timers is one click away from the HUD instead of
buried inside per-target note popovers. The drawer must:

- Be reachable from a new HUD button placed next to the existing
  "GM Tools" button (visible to the GM only).
- Subscribe to a single GM-only Convex query that returns every note
  in the game whose `timer` is set.
- For each entry, render the existing clock cell (cycling on click,
  same UX as inside the notes popover) plus enough context for the GM
  to know which player / syndicate / minion the timer belongs to.
- Update live as the GM creates timers and cycles clocks. (Only the
  GM can create timer-bearing notes — `convex/notes.ts:165-216` gates
  the `timerMinutes` arg behind `requireGameGm` — so Player writes
  never enter this surface.)
- Strip every shred of the feature from non-GM payloads (button hidden,
  query refuses non-GM callers, drawer never mounts on Player
  sessions) — Rule 24 server-side authority, mirroring the existing
  timer wire-format treatment in `convex/notes.ts:357-475`.

## Background — what the spec maps to

- "All notes with a clock" = notes whose persisted `timer` sub-object
  is set. The schema is already in place
  (`convex/schema.ts:289-313`); the field is GM-only on the wire
  (`convex/notes.ts:467-471`).
- "Lists the player, syndicate, and minion it's attached to" = for
  each timer-bearing note, render a target context line derived from
  `targetKind` + the standard FK joins:
  - `targetKind === "minion"` → minion → `minion.syndicateId` →
    syndicate → player who has selected that syndicate (if any).
  - `targetKind === "syndicate"` → syndicate → player who has selected
    it (if any).
  - `targetKind === "game"` → no per-entity context.
  All three branches are reachable in v1 — see Task 0b, which relaxes
  the timer gate so the GM can attach a clock to game- and
  syndicate-target notes too.
- "A drawer, with a button next to GM TOOLS" = a new HUD button placed
  immediately after the existing GM Tools button
  (`src/pages/GameDetailPage.tsx:283-291`), opening a new drawer that
  reuses the shared `Drawer` primitive (extracted in Task 0a out of
  its current home at `src/pages/GameDetailPage.tsx:795-841`, where
  `GmToolsDrawer` and `GameLogDrawer` use it today).
- "Clock" = the existing `<NoteTimerCell>`
  (`src/components/NoteTimerCell.tsx`). Reuse — but Task 0c rewires
  the cell's per-instance 1Hz interval onto a shared heartbeat hook so
  every clock on the page ticks in lockstep.
- The "joined player" (from selectedSyndicateId) follows the existing
  `by_selected_syndicate` index pattern already used by
  `convex/notes.ts:552` and `convex/syndicates.ts:157`. Within-game
  uniqueness of the selection is enforced as a prerequisite (Task
  0d), so each timer row carries at most one selecting player.

## Design — drawer UX

### Button

- Label: "GM Todo".
  - Avoids "Todo" alone (ambiguous on a tiny HUD), avoids "Timers"
    (wider scope — would imply non-note timers), avoids "Clocks"
    (collides with the cell caption `CLOCK`).
- Placement: between the existing "GM Tools" button and the
  game-level `<NoteIcon>` (`src/pages/GameDetailPage.tsx:283-298`),
  i.e. directly to the right of "GM Tools".
- Class / styling: `secondary`, mirroring "GM Tools" / "Log" so the
  HUD stays visually homogeneous. No new design tokens.
- Visibility: gated on `viewerIsGm` exactly like the GM Tools button.
- Optional badge: a numeric indicator of "active todos" (count of
  ticking + due_manual notes; done items don't contribute) when > 0.
  Defer this to a later iteration unless trivially cheap; the v1 plan
  delivers it as an enhancement (Task 12) rather than the critical
  path.

### Drawer body

- Title: "GM Todo".
- One section, one virtual list (no nested sections in v1 — sorting
  alone gives a usable order).
- Each row renders, left-to-right:
  1. The clock cell via `<NoteTimerCell>` (size `sm`,
     `viewerIsGm={true}`, `onCycle={() => cycle({ noteId })}`).
  2. The target context line (see "Target context" below).
  3. The pinned skill-check roll set, when present (the same
     `<RollSetDisplay>` the popover renders inline next to a note's
     body), so the GM can see at a glance WHAT skill check this
     clock is timing without opening the popover. After Task 0b a
     game- or syndicate-target timer-bearing note carries no
     `attachedRollSetId` (no head call to pin), so this column is
     absent for those rows. The drawer renders the column slot at a
     fixed width and lets it collapse to empty so neighbouring rows
     stay aligned.
  4. The note body (single-line truncated with the full body in a
     tooltip / `title` attr — full body is just one click away in the
     existing popover so we don't need to render a multi-line block
     in this overview drawer).
  5. Right-aligned secondary metadata: author display name +
     visibility badge + relative createdAt timestamp.
- Empty state: "No clocks running." in the existing `.muted` style.
- Loading state: "Loading…" `.muted`, matching `<NoteList>`'s
  convention (`src/components/NoteIcon.tsx:329-330`).

### Target context line

Format examples (text only — actual markup uses spans + `.muted`
separators so the unset segments collapse):

- Minion-target, syndicate selected by a player:
  `Alice • Crimson Cabal • Smiler`
- Minion-target, syndicate not selected by anyone in this game:
  `(unassigned) • Crimson Cabal • Smiler`
- Syndicate-target, syndicate selected by a player:
  `Alice • Crimson Cabal`
- Syndicate-target, no selector:
  `(unassigned) • Crimson Cabal`
- Game-target:
  `Game-wide`

All three branches are produced by the public API after Task 0b
(no longer defensive). The "(unassigned)" sentinel keeps the column
count visually stable so rows don't jitter when the player slot is
null.

### Sort order

The GM scanning the drawer wants the screaming-overdue items at the
top; recently-completed items sink so the list is a working queue,
not a chronological log. The boundary between overdue and
future-ticking depends on wall-clock time, which is **not** a
reactive dependency in Convex queries — calling `Date.now()` inside
a query handler captures a snapshot at execution time but does not
cause the query to re-run as time passes. Sorting that boundary
server-side would freeze the order until an unrelated mutation
triggers a re-query, which directly defeats the drawer's purpose.

**Server-side ordering** (Task 1) is therefore time-independent:

1. `ticking` (any), secondary key `dueAt` ascending.
2. `due_manual` (manually flagged overdue), `createdAt` descending.
3. `done`, `createdAt` descending.

**Client-side refinement** (Task 8) splits tier 1 against
`Date.now()` on each tick:

1a. `ticking` past `dueAt` (overdue), most overdue first.
1b. `ticking` future `dueAt`, soonest first.
2.  `due_manual`, `createdAt` descending.
3.  `done`, `createdAt` descending.

The re-evaluation rides the same 1Hz heartbeat that
`<NoteTimerCell>` already uses for its countdown
(`src/components/NoteTimerCell.tsx:122-126`). The drawer subscribes
to a single 1Hz tick state at the parent level and recomputes the
ordered array via `useMemo`, so we do not multiply the per-cell
intervals.

## Persistence model

No schema changes. The feature is a pure read aggregation over
`notes` + a pre-existing index walk for the player / syndicate /
minion joins. The existing `cycleNoteTimer` mutation is reused
verbatim for the click-to-cycle behaviour.

## Implementation Plan

### Pre-steps (shared infrastructure)

- [ ] **Task 0a.** Extract the `Drawer` primitive into a new file
  `src/components/Drawer.tsx`. The primitive currently lives inline
  at `src/pages/GameDetailPage.tsx:795-841` and is consumed by
  `GmToolsDrawer` and `GameLogDrawer` (same file). Move the function
  verbatim into the new module, export it, and update the three
  existing call sites to import from `../components/Drawer`. No
  behaviour change. Rationale: importing an in-file helper from a
  4000+ line page module is awkward and creates a circular shape
  once `GmTodoDrawer` lives in `src/components/`. Doing the
  extraction first keeps the v1 diff for the new feature small.
  Acceptance: existing drawer tests / smoke flows pass; only the
  import path changes for `GmToolsDrawer` and `GameLogDrawer`.

- [ ] **Task 0b.** Relax the timer gate in `convex/notes.ts:181-216`
  (the `createNote` handler) so the GM may attach `timerMinutes` to
  any note kind they author. Concrete edits:
  - Keep guard #1 (`role !== "gm"` rejected) and guard #2
    (`timerMinutes` must be in `TIMER_PRESET_MINUTES`).
  - Drop guard #3 (the `attachedRollSetId === undefined` rejection,
    `convex/notes.ts:207-211`). The error message and the rationale
    comment go too — replace with: "The GM may attach a timer to
    any note they author. When the note pins a live skill check
    (minion-target on the head call) the timer accompanies the
    pinned roll set; on game- or syndicate-target notes the timer
    stands alone."
  - The `attachedRollSetId` resolution itself stays exactly as it
    is today (`convex/notes.ts:164-179`) — minion-target on the
    head call still pins a roll set, other targets still don't.
  - Update the file-top docblock (`convex/notes.ts:30-34`) to drop
    the "only on minion-target head-call notes" implication.
  Tests in `convex/notes.test.ts`:
  - GM creating a `targetKind: "game"` note with `timerMinutes: 5`
    succeeds and the row carries a `ticking` timer.
  - GM creating a `targetKind: "syndicate"` note with `timerMinutes`
    on a syndicate selected by a player in this game succeeds and
    carries a `ticking` timer.
  - Player attempting either of the above is still rejected with
    "Only the GM may post a note with a timer.".
  - The minion-target on-head-call timer path continues to work
    (no regression on the existing test).
  Rationale: the GM Todo drawer needs all three target kinds
  exercised through the public API to be a useful working surface,
  and there is no Rule 24 reason to restrict GM-authored timers to
  the minion case — the head-call check existed solely to protect
  the "timer ⇒ pinned roll set" invariant the original Note Timers
  v1 plan asserted. That invariant relaxes here.

- [ ] **Task 0c.** Introduce a shared 1Hz heartbeat hook so every
  `<NoteTimerCell>` and the new drawer's sort refinement use the
  same timer source.
  - New file `src/lib/useNow.ts`. Implementation: a module-scope
    `Set<() => void>` of subscribers and a single lazy
    `setInterval(1000)`. The first subscriber starts the interval;
    the last unsubscriber clears it. `useNow()` returns the
    current `Date.now()` reading and re-renders the caller on each
    tick. Public surface: `export function useNow(): number`.
  - Refactor `src/components/NoteTimerCell.tsx:118-128`: drop the
    per-instance `useState`/`useEffect` interval pair; replace with
    `const now = useNow()` and use `now` in `deriveTimerState` and
    the remaining-ms math. The `now` argument supplied to
    `deriveTimerState` already exists
    (`src/components/NoteTimerCell.tsx:128`), so the change is
    local.
  - Skip the heartbeat for cells whose `timer.kind !== "ticking"`:
    keep the existing optimisation by gating subscription inside
    the cell with a `useNow` variant that takes a `subscribed:
    boolean`, OR simply call `useNow()` unconditionally and accept
    that done/due_manual cells re-render every second alongside
    the rest of the page. The simpler unconditional path is fine
    in practice — these cells render maybe a dozen at peak and the
    work is trivial. Pick the simpler variant; document the
    decision in the hook's docblock.
  - The drawer (Task 8) uses `const now = useNow()` directly for
    the sort split — no separate interval at the drawer level.
  - Tests:
    - Mounting two `<NoteTimerCell>` components results in a
      single `setInterval` (assert via a Vitest spy on
      `globalThis.setInterval`).
    - Unmounting the last subscriber clears the interval.
    - `formatTimerValue` and `deriveTimerState` are unchanged and
      their existing tests still pass.
  Trade-off: a small refactor in one component + one new module.
  Payoff: every clock on the page ticks in lockstep, the drawer's
  sort refinement piggybacks on the same heartbeat for free, and
  the misleading "we do not multiply the per-cell intervals" claim
  in earlier drafts becomes literally true.

- [ ] **Task 0d.** Enforce within-game uniqueness of
  `players.selectedSyndicateId` during the `ready` stage in
  `convex/games.ts:94-117` (`selectSyndicate`). Concrete edit: in
  the non-null branch, before the `ctx.db.patch`, query the
  `by_selected_syndicate` index for `args.syndicateId`, filter to
  the current `gameId`, and reject if any row other than the
  caller's own `player._id` is present. Error message: "Another
  Player in this game has already selected that Syndicate.".
  Tests in `convex/games.test.ts` (or `selectSyndicate.test.ts` if
  the existing file is large):
  - First player to select a shared syndicate succeeds.
  - A second player in the same game attempting to select the same
    syndicate is rejected with the new error.
  - The same syndicate may still be selected once per OTHER game
    (cross-game isolation preserved — the existing test at
    `convex/notes.test.ts:393` covers this shape).
  - A player may re-select a syndicate they already had selected
    (idempotent — the only `by_selected_syndicate` row that
    matches is theirs).
  Rationale: the GM Todo drawer projects a single
  `playerId` / `playerDisplayName` per row (Task 1). Without this
  invariant the projection silently drops one of two equally valid
  selectors. Making the database invariant authoritative removes
  the ambiguity at its source. The check is also natural under the
  rules — Rule 13 already implies one-player-one-syndicate during
  ready, but the mutation never enforced it.

### Server (Convex)

- [ ] **Task 1.** Add a new GM-only query
  `listGameNotesWithTimers({ gameId })` in `convex/notes.ts`. The
  handler must:
  - Call `requireGameGm(ctx, args.gameId)` first — Rule 24 server-side
    authority. Non-GM callers get the same error surface as
    `cycleNoteTimer`.
  - Read every note for this game via the existing index
    `by_game_kind_created` (range over the `gameId` prefix only).
    Notes are bounded per game so a single index walk is safe; no
    pagination needed.
  - Post-filter in-memory to rows where `n.timer !== undefined`.
    (Adding a dedicated index on `(gameId, hasTimer)` is rejected —
    the working set per game is small and an index can't cover the
    optionality of a sub-object cheaply. See Risks.)
  - Bulk-resolve auxiliaries with at most one batched read per kind
    so we never N+1 the table:
    - `minions` for every distinct `targetMinionId`,
    - `syndicates` for every distinct `targetSyndicateId` ∪
      `minion.syndicateId`,
    - `players` for every distinct `selectedSyndicateId` matching
      those syndicate ids (use the existing
      `by_selected_syndicate` index, restricted by `gameId` in
      memory like `convex/notes.ts:548-558` does today). The
      Task 0d invariant guarantees at most one matching player per
      `(gameId, syndicateId)` pair, so the projection picks the
      single hit (or none) without ambiguity.
    - `users` for every author user id ∪ player user id ∪ derived
      author ids,
    - `callRollSets` for every distinct `attachedRollSetId` (reuse
      the bulk-load + dedupe pattern from
      `convex/notes.ts:425-444`; reuse `projectRollSet`). After
      Task 0b a game- or syndicate-target timer-bearing note has
      no `attachedRollSetId`, so the resulting `attachedRolls`
      key is omitted on those rows (matching the existing GM-only
      invariant: key absent rather than `null` when there were
      never any rolls to attach).
  - Project a flat row per timer-bearing note:
    ```
    {
      _id, createdAt, body, visibility, authorUserId,
      authorDisplayName,
      timer,                          // GM payload, never absent here
      attachedRolls?,                 // RollSetView | null; key absent on
                                      // game/syndicate-target rows
      targetKind, targetSyndicateId?, targetMinionId?,
      minionName?, syndicateName?,
      playerId?, playerDisplayName?,
    }
    ```
    `playerId` / `playerDisplayName` are present only when a player
    in this game has selected the relevant syndicate (and Task 0d
    guarantees there is at most one). Differences vs. `NoteListItem`
    that consumers should know about: no `isMine`, no `canDelete`
    (the drawer never offers delete), and additional joined naming
    fields. The new shape is a parallel projection — the existing
    `<NoteList>` component is NOT reused, so this is not a breaking
    change for popover code paths.
  - Order: sort the projected array by the time-independent ordering
    described in "Sort order" (tier 1 = `ticking` by `dueAt` asc,
    tier 2 = `due_manual` by `createdAt` desc, tier 3 = `done` by
    `createdAt` desc). Do **not** call `Date.now()` in the handler:
    the overdue / future split is refined client-side because the
    Convex query is not reactive on wall-clock time. Sorting on the
    server still removes the bulk of the work and keeps the client
    handler trivial.
  - Return type: `Promise<GmTodoNoteRow[]>` where `GmTodoNoteRow` is
    exported from `convex/notes.ts` for client reuse. Naming chosen
    for parallelism with `NoteListItem`; leaves the unqualified
    `GmTodoRow` symbol available for a future v2 that aggregates
    non-note items into the same drawer.
  - Rationale: a single GM-only query with denormalised joins is the
    minimum surface area for the new drawer. No new indices, no
    schema delta, no new mutation.

- [ ] **Task 2.** Export the `GmTodoNoteRow` type from
  `convex/notes.ts` next to the existing `NoteListItem` type
  (`convex/notes.ts:337-354`). Re-use `NoteTimer`, `RollSetView`, and
  the `Id<...>` aliases already in scope. Rationale: clients consume
  the same shape the server projects without redefining a parallel
  TS type.

- [ ] **Task 3.** Server tests in `convex/notes.test.ts` (or a sibling
  test file if the existing one is large):
  - `listGameNotesWithTimers` rejects Players (mirrors the
    `cycleNoteTimer` Player-rejection test).
  - Returns `[]` when no notes carry a timer.
  - Returns only timer-bearing notes; non-timer notes in the same
    game are filtered out.
  - For a minion-target timer note, the row carries `minionName`,
    `syndicateName`, and the selecting player's `playerId` /
    `playerDisplayName`.
  - For the same minion's syndicate when no player has selected it,
    `playerId` / `playerDisplayName` are absent.
  - For a syndicate-target timer note (now reachable via Task 0b),
    the row carries `syndicateName` and the selecting player's
    `playerId` / `playerDisplayName`, no `minionName`, and no
    `attachedRolls` key.
  - For a game-target timer note (also reachable via Task 0b), the
    row carries no `minionName`, no `syndicateName`, no `playerId`,
    and no `attachedRolls` key.
  - Server-side sort order: a `ticking` row precedes a `due_manual`
    row precedes a `done` row; within the `ticking` band, the row
    with the soonest `dueAt` is first; within `due_manual` and
    `done`, `createdAt` descending. The overdue-vs-future split
    inside `ticking` is intentionally NOT exercised here — it lives
    in the client refinement (Task 8) and is covered by client
    tests (Task 13).
  - Author display name is resolved from `users.displayName` /
    `users.email` / `"Unknown"` exactly like the existing
    `listNotesForTarget` code path.
  - GM viewer sees `attachedRolls` populated for notes that pinned a
    roll set; the field is `null` (key present) when the row had no
    `attachedRollSetId` — match the existing GM-only invariant.
  - Cross-game isolation: notes in another game with a timer do not
    leak into the result.

### Client (React)

- [ ] **Task 4.** Add `gmTodoOpen` local state and a "GM Todo" button
  in the HUD header at `src/pages/GameDetailPage.tsx:283-298`. Place
  the button immediately after the existing "GM Tools" button, gated
  by the same `viewerIsGm` check. Style it with the existing
  `secondary` class so it matches the surrounding HUD chrome. No new
  CSS. The button is intentionally NOT gated by
  `hideManagementControls` — it stays visible whether or not the GM
  has hidden management controls, mirroring the timer-cell carve-out
  documented at `src/components/NoteIcon.tsx:322-326` (timers are
  gameplay state, not destructive management affordances). The GM
  Tools button itself follows the same convention today
  (`src/pages/GameDetailPage.tsx:283-291` checks only `viewerIsGm`).

- [ ] **Task 5.** Render `<GmTodoDrawer>` conditionally on
  `viewerIsGm && gmTodoOpen` next to the existing
  `<GmToolsDrawer>` mount in the same component
  (`src/pages/GameDetailPage.tsx:310-319`). Pass `gameId` and an
  `onClose` that flips the local state, exactly like the GM Tools
  drawer. As with Task 4, the mount condition deliberately ignores
  `hideManagementControls`.

- [ ] **Task 6.** Implement `GmTodoDrawer` as a new component in
  `src/components/GmTodoDrawer.tsx`. Extraction is preferred over
  co-location with `GmToolsDrawer` because `GameDetailPage.tsx` is
  already 4000+ lines (Risk 8); adding another in-file drawer makes
  the situation worse. The drawer imports `Drawer` from the shared
  module created in Task 0a. The component:
  - Uses `useQuery(api.notes.listGameNotesWithTimers, { gameId })`.
  - Uses `useMutation(api.notes.cycleNoteTimer)` for the cell click
    handler. Errors surfaced via a local `setErr` channel (mirrors
    `NotesPopover.handleCycleTimer` at
    `src/components/NoteIcon.tsx:234-240`).
  - Renders the `<Drawer onClose={onClose} title="GM Todo">` shell.
  - Empty/loading branches as in the design.
  - Each row: a flex container with the `<NoteTimerCell>` on the
    left and the row's body / metadata stack on the right. Reuse
    the existing `.note-item` markup conventions where it makes
    sense; no new CSS classes unless the diff turns up an alignment
    issue that can't be resolved with inline styles.

- [ ] **Task 7.** Render the target context line as a small helper
  inside `src/components/GmTodoDrawer.tsx`, e.g.
  `formatGmTodoTarget(row)`. The helper returns a JSX fragment
  (not a string) so individual segments can carry the existing
  `.muted` separator class. Implementation tree:
  - minion-target: `Player • Syndicate • Minion`
  - syndicate-target: `Player • Syndicate`
  - game-target: `Game-wide`
  - missing player slot: render `(unassigned)` literal (use the
    existing `.muted` token).

- [ ] **Task 8.** Client-side sort refinement. The server returns
  rows in the time-independent ordering documented in "Sort order"
  (Task 1). The drawer:
  - Reads the current wall-clock via the shared `useNow()` hook
    introduced in Task 0c. No drawer-local interval — the hook
    already provides the lockstep heartbeat that
    `<NoteTimerCell>` rides.
  - Derives the rendered order via `useMemo([rows, now], …)`:
    tier-1 `ticking` rows are partitioned into overdue
    (`now >= dueAt`, most-overdue first) and future
    (`now < dueAt`, soonest first); tiers 2 and 3 are kept in the
    server's order. Because the server already sorts ticking rows
    by `dueAt` ascending, the partition is just splitting the
    sorted list at the first index where `dueAt > now` — both
    halves stay in their existing order with no re-sort.
  - Document the split-of-responsibility contract in a doc comment
    at the top of the component so a later refactor doesn't
    accidentally re-sort on the server (which would be reactivity-
    broken — see "Sort order" rationale).

- [ ] **Task 9.** Click semantics on the timer cell mirror the
  popover (running → done, done → due_manual, due_manual → done).
  Reuse the existing mutation; do NOT introduce a parallel cycle
  helper. The reactive query causes the row to re-render and the
  sort order to re-stabilise without manual cache work.

- [ ] **Task 10.** Visibility note: the drawer must NEVER mount on a
  Player session, but the server query is also GM-only. Defence in
  depth — the button gate alone is not sufficient (see Risks).

- [ ] **Task 11.** Inline note-list link affordance (lightweight): on
  each row, expose a button labelled "Open" (or render the row body
  as a secondary action) that opens the standard notes popover for
  the note's target. Implementation note: this requires hoisting
  state into the GameDetailPage that selects which `NoteIcon`'s
  popover should be shown next, which is non-trivial. Defer to a
  follow-up plan unless cheap; the cycle-on-click cell already
  delivers the primary action ("mark done"). Mark this task explicit
  as **deferred** in v1.

- [ ] **Task 12.** **Deferred — out of scope for v1.** A numeric
  badge on the "GM Todo" button showing the count of `ticking` +
  `due_manual` rows would be useful, but the existing
  `.note-icon-badge` class (`src/components/NoteIcon.tsx:91-93`) is
  positioned for the 16×16 svg in `NoteGlyph`
  (`src/components/NoteIcon.tsx:108-124`); pasting it onto a
  `secondary` text button needs new CSS to look right. The HUD
  button is GM-only and immediately adjacent to the drawer it opens,
  so the cost/value ratio of styling work doesn't clear v1. Revisit
  in a follow-up if field reports show GMs missing overdue clocks.

- [ ] **Task 13.** Client unit tests (vitest):
  - `formatGmTodoTarget(row)` renders the four branches above
    (minion / syndicate / game / unassigned-player) with correct
    fragments.
  - The drawer renders an empty-state node when the query returns
    `[]`.
  - Clicking a clock cell invokes the mutation with the correct
    `noteId` (mock `useMutation`).
  - Gating: rendering `<GmTodoDrawer>` itself is the unit under
    test. Test the parent gate (`viewerIsGm && gmTodoOpen`) at
    the level of the gating expression, not by mounting
    `GameDetailPage` — extract a tiny `<GmTodoMount>` wrapper if
    needed, or assert in a focused render test that the button
    and drawer are absent when `viewerIsGm` is false. Avoid
    pulling the 4000-line page into a unit test.
  - Client sort refinement: given three `ticking` rows whose `dueAt`
    straddle a fixed `now`, the overdue rows precede the future
    rows, and within each sub-band the ordering matches the
    documented secondary key. Use a fake-timer harness or pass
    `now` as a prop / context override to keep the test
    deterministic. The `useNow` hook should expose a test seam
    (e.g. an env-controlled override or a context provider) so the
    test does not need to fight `setInterval` directly.

### Documentation / housekeeping

- [ ] **Task 14.** Amend the file-top docblock in `convex/notes.ts`
  (`convex/notes.ts:12-35`) to mention the new GM-only aggregation
  query and explicitly call out that, like `attachedRollSetId` and
  `timer`, the projected payload never reaches Player sessions.
  Also update the Note Timers paragraph to reflect Task 0b — timers
  are GM-only on every target kind, not just minion-target.

- [ ] **Task 15.** Add inline doc-comment headers to the new query
  and the new drawer component documenting:
  - the four-tier sort order,
  - the GM-only invariant,
  - the rationale for in-memory filtering of `timer !== undefined`
    (no dedicated index),
  - the read-amplification pattern (bulk-load auxiliaries once),
  - the `attachedRolls` key being absent on game- and
    syndicate-target rows (post Task 0b) — not an oversight, the
    note never pinned a roll set,
  - the `playerId` / `playerDisplayName` projection assuming the
    Task 0d uniqueness invariant.

- [ ] **Task 16.** No standalone documentation file. Plan-level spec
  lives in this document; code comments cover the implementation.

## Verification Criteria

- A GM with no timer-bearing notes opens "GM Todo" and sees an
  "No clocks running." empty state.
- A GM creates a 5-minute timer on a minion-target note while a
  player has selected that syndicate. Opening "GM Todo" shows the
  row with `Player • Syndicate • Minion`, the pinned roll set, the
  clock counting down, and the body excerpted into the row.
- Clicking the clock cell from inside the drawer cycles the timer
  identically to the popover (ticking → done → due_manual → done).
- A second GM session viewing the same drawer sees the cycle in real
  time (live query).
- A Player session: the "GM Todo" button is absent from the HUD; a
  forged direct call to `api.notes.listGameNotesWithTimers` is
  rejected by `requireGameGm`.
- A note in a different game with a timer does NOT show up in this
  game's drawer.
- Cross-target check: a syndicate-level timer-bearing note (if it
  exists, despite the server's gating today) renders with
  `Player • Syndicate` and no minion slot.
- Sort sanity: with three timers — one overdue, one running, one
  done — the drawer lists overdue, then running, then done. Crossing
  a `dueAt` boundary while the drawer is open re-sorts the list
  within ~1s without requiring an unrelated mutation to land
  (verifies the client-side refinement, Task 8).
- The popover-side notes UX (`NoteIcon`) is unchanged; the drawer
  renders timers in addition, never instead.
- A GM may now create a 5-minute timer on a game-target note and on
  a syndicate-target note (Task 0b). Both rows appear in the drawer
  with their respective context lines and no pinned roll set.
- Two players in the same `ready`-state game may not select the same
  syndicate (Task 0d): the second `selectSyndicate` call rejects.
- All visible `<NoteTimerCell>` instances on the page tick on the
  same second-boundary (Task 0c) — visually verifiable by opening
  the drawer alongside a notes popover and watching the seconds line
  up.
- No `console.error` / `console.warn` from per-second
  `<NoteTimerCell>` re-renders when the drawer is open.

## Potential Risks and Mitigations

0. **Cross-cutting pre-step churn (Tasks 0a–0d).**
   The four pre-steps each touch shared infrastructure: a primitive
   move, a server-side gate relaxation, a hook refactor, and a
   selection-uniqueness invariant. Each is small in isolation but
   together they expand the v1 diff beyond the drawer itself.
   Mitigation: each pre-step lands as its own commit with its own
   tests so a regression in one doesn't block the others. Task 0c
   is the most invasive (touches every existing `<NoteTimerCell>`
   call site indirectly via the cell's internals); confine the
   change to the cell file and the new hook so review surface stays
   localised. Task 0d adds an invariant — confirm with the GM
   workflow that no existing test fixture creates two players with
   the same selection in one game (the existing tests only ever
   share a syndicate selection ACROSS games — see
   `convex/notes.test.ts:393`).

1. **Player accidentally seeing the GM Todo button.**
   Mitigation: gate the button on `viewerIsGm`, gate the drawer mount
   on `viewerIsGm`, AND gate the query handler on `requireGameGm`.
   Three layers, defence-in-depth, matching the existing pattern for
   the GM Tools drawer.

2. **Read amplification — N+1 per row across `minions`,
   `syndicates`, `players`, `users`, `callRollSets`.**
   Mitigation: bulk-resolve every auxiliary in one pass per table
   using `Set` dedupe + an explicit per-id `ctx.db.get` loop, exactly
   like the existing GM-only roll-set decoration in
   `convex/notes.ts:425-444`. Notes per game are bounded so the total
   work stays small.

3. **Sort instability when `dueAt` is null in the persisted record.**
   Mitigation: not possible — schema rejects `{kind:"ticking"}`
   without `dueAt` (`convex/schema.ts:303-310`). Sort code asserts
   `kind === "ticking"` before reading `dueAt`.

4. **Duplicate "selected by player" lookup pattern divergence from
   the canonical helper.**
   Mitigation: factor the "find player who selected this syndicate
   in this game" logic into a small helper in `convex/notes.ts` or
   `convex/lib/players.ts` that both `assertSyndicateVisibleInGame`
   (`convex/notes.ts:528-561`) and the new aggregator can call. If
   that refactor blows up the diff, defer the helper extraction and
   inline a comment pointing back to the existing implementation as
   the source of truth.

5. **Drawer becoming a separate "second source of truth" for note
   actions, drifting from the popover (delete affordance, public/private
   toggle, edit-in-place, etc).**
   Mitigation: v1 deliberately exposes only the cycle action — the
   single thing the GM does most often on these timers. Other note
   operations (delete, change visibility — neither of which exists
   today: notes are author-immutable post-creation) stay in the
   popover. Document this scope decision in the drawer's docblock so
   future contributors don't reflexively add a Delete button.

6. **Query response size if a long-lived game accumulates dozens of
   timer-bearing notes including completed ones.**
   Mitigation: practical limits remain small (timers are GM-driven
   and per-skill-check). If field reports show drawer scroll fatigue,
   add a "hide done" toggle in v2 that filters
   `timer.kind === "done"` client-side. v1 keeps everything visible
   to preserve the audit log feel.

7. **Clock skew between GM browsers.**
   Mitigation: same as `<NoteTimerCell>` today — the cell ticks off
   the local clock; a >5s skew is acceptable. Already documented in
   the timer plan (`plans/2026-04-28-2026-04-28-note-timers-v1.md`
   Risk 4).

8. **`GameDetailPage.tsx` already exceeds 4000 lines; adding another
   drawer worsens it.**
   Mitigation: Task 6 commits to extracting the new drawer into
   `src/components/GmTodoDrawer.tsx` from the start. A follow-up
   clean-up can extract `GmToolsDrawer` and `GameLogDrawer` to match;
   the new drawer is built the right way so it doesn't add to that
   debt.

9. **Adding a per-row "Open in popover" deep-link is non-trivial
   (Task 11).**
   Mitigation: explicitly deferred in v1. The cycle action alone
   delivers the primary value; "Open" is a future polish.

10. **Convex query reactivity does not extend to wall-clock time.**
    A query that branches on `Date.now()` captures a single
    timestamp at execution and freezes until an unrelated read
    triggers a re-run. Mitigation: the server query is
    time-independent (Task 1) and the overdue/future split lives
    client-side on a 1Hz tick (Task 8). See "Sort order" for the
    full split-of-responsibility rationale.

11. **`useNow` singleton interaction with React Strict Mode and
    test isolation.**
    A module-scope subscriber set + lazy interval can leak between
    Vitest test cases if a component unmounts after the next test
    starts. Mitigation: the hook clears the interval as soon as the
    last subscriber unsubscribes (already in Task 0c's spec); add
    an `afterEach` in the relevant test file that asserts the
    subscriber set is empty + `globalThis.setInterval` was not left
    pending. Strict mode's double-mount is a non-issue because the
    hook reference-counts subscriptions correctly; the test for
    "two cells share one interval" doubles as the strict-mode
    sanity check.

## Alternative Approaches

1. **Per-row subscription instead of one aggregate query.** Render the
   drawer as a list of `<NoteIcon>`-style children, each with its own
   `listNotesForTarget` subscription. Trade-off: zero new server code
   but N parallel subscriptions per drawer mount, plus the joining
   logic moves to the client. Rejected — the join is non-trivial
   (player ↔ syndicate ↔ minion) and pushing it to the client
   re-implements the existing `assertSyndicateVisibleInGame` shape.

2. **Schema-level `notes.hasTimer` boolean + dedicated index.** Adds
   `(gameId, hasTimer)` for O(1) head reads. Trade-off: introduces a
   denormalised flag that must stay in sync with the `timer` sub-
   object (write amplification, drift risk). Rejected on the basis
   that working sets per game are small and an in-memory filter
   after a single index walk is plenty for v1. Revisit if the
   `notes` table per game grows into the thousands.

3. **Server-side push of "due now" notifications via the Convex
   scheduler.** Trade-off: removes the polling-style UX (the GM
   doesn't have to peek into the drawer to know something fired).
   Rejected — out of scope. v1 is a static drawer, not a
   notification system.

4. **Render the drawer at the bottom (`bottom` prop on `Drawer`)
   like a notification tray.** Trade-off: closer to a HUD overlay
   feel. Rejected — the side drawer matches the existing GM Tools
   and Game Log drawers, keeping the HUD interaction model uniform.

5. **Combine into the existing GM Tools drawer as a new section.**
   Trade-off: one fewer button on the HUD. Rejected because the GM
   Tools drawer is positioned as "rarely-used GM utilities"
   (`src/pages/GameDetailPage.tsx:336-342`); a live timer dashboard
   is the opposite — a frequently-checked working surface — and
   shouldn't compete for the same drawer real estate. A dedicated
   button keeps the affordances orthogonal.
