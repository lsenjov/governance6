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
- Update live as Players add notes and as the GM cycles clocks.
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
  - `targetKind === "game"` → no per-entity context. (Today the server
    refuses timers on non-minion notes
    (`convex/notes.ts:207-210`), so this branch is defensive only.)
- "A drawer, with a button next to GM TOOLS" = a new HUD button placed
  immediately after the existing GM Tools button
  (`src/pages/GameDetailPage.tsx:283-291`), opening a new drawer that
  reuses the in-file `Drawer` primitive at
  `src/pages/GameDetailPage.tsx:795-841` (same pattern as
  `GmToolsDrawer` and `GameLogDrawer`).
- "Clock" = the existing `<NoteTimerCell>`
  (`src/components/NoteTimerCell.tsx`). Reuse — do not redesign.
- The "joined player" (from selectedSyndicateId) follows the existing
  `by_selected_syndicate` index pattern already used by
  `convex/notes.ts:552` and `convex/syndicates.ts:157`.

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
  3. The note body (single-line truncated with the full body in a
     tooltip / `title` attr — full body is just one click away in the
     existing popover so we don't need to render a multi-line block
     in this overview drawer).
  4. Right-aligned secondary metadata: author display name +
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
- Game-target (defensive — currently unreachable because the server
  blocks timers on non-minion notes):
  `Game-wide`

The "(unassigned)" sentinel keeps the column count visually stable so
rows don't jitter when the player slot is null.

### Sort order

Sort the joined list with a stable, GM-friendly priority:

1. `ticking` past `dueAt` (overdue), most overdue first.
2. `ticking` future `dueAt`, soonest first.
3. `due_manual` (manually flagged overdue), newest `createdAt` first.
4. `done`, newest `createdAt` first.

Rationale: the GM scanning the drawer wants the screaming-overdue
items at the top; recently-completed items sink so the list is a
working queue, not a chronological log. Comparison uses `Date.now()`
on the client so the boundary is always live without the server
having to re-stamp on every read.

## Persistence model

No schema changes. The feature is a pure read aggregation over
`notes` + a pre-existing index walk for the player / syndicate /
minion joins. The existing `cycleNoteTimer` mutation is reused
verbatim for the click-to-cycle behaviour.

## Implementation Plan

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
      memory like `convex/notes.ts:548-558` does today),
    - `users` for every author user id ∪ player user id ∪ derived
      author ids,
    - `callRollSets` for every distinct `attachedRollSetId` (reuse
      the bulk-load + dedupe pattern from
      `convex/notes.ts:425-444`; reuse `projectRollSet`).
  - Project a flat row per timer-bearing note:
    ```
    {
      _id, createdAt, body, visibility, authorUserId,
      authorDisplayName,
      timer,                          // GM payload, never absent here
      attachedRolls,                  // RollSetView | null
      targetKind, targetSyndicateId?, targetMinionId?,
      minionName?, syndicateName?,
      playerId?, playerDisplayName?,
    }
    ```
    `playerId` / `playerDisplayName` are present only when a player
    in this game has selected the relevant syndicate.
  - Order: sort the projected array by the four-tier priority
    described in "Sort order". Doing the sort server-side keeps the
    client trivially renderable; the `now`-dependent boundary uses
    `Date.now()` (Convex `now()` is fine — both branches just need
    a consistent reference point per query result, and reactivity
    re-runs the query whenever any underlying note changes anyway).
  - Return type: `Promise<GmTodoRow[]>` where `GmTodoRow` is exported
    from `convex/notes.ts` for client reuse.
  - Rationale: a single GM-only query with denormalised joins is the
    minimum surface area for the new drawer. No new indices, no
    schema delta, no new mutation.

- [ ] **Task 2.** Export the `GmTodoRow` type from `convex/notes.ts`
  next to the existing `NoteListItem` type
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
  - Sort order: an overdue-ticking row precedes a future-ticking row;
    a future-ticking row with the soonest `dueAt` precedes one with a
    later `dueAt`; `due_manual` precedes `done`; within each band,
    the documented secondary key holds.
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
  CSS.

- [ ] **Task 5.** Render `<GmTodoDrawer>` conditionally on
  `viewerIsGm && gmTodoOpen` next to the existing
  `<GmToolsDrawer>` mount in the same component
  (`src/pages/GameDetailPage.tsx:310-319`). Pass `gameId` and an
  `onClose` that flips the local state, exactly like the GM Tools
  drawer.

- [ ] **Task 6.** Implement `GmTodoDrawer` as a new component in
  `src/pages/GameDetailPage.tsx` (co-located alongside
  `GmToolsDrawer` for symmetry; the existing file is the canonical
  home for game-detail drawers) OR as
  `src/components/GmTodoDrawer.tsx` if the file size is becoming
  unwieldy. Decision in a follow-up review — co-location is the
  default. The component:
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
  inside the same file, e.g. `formatGmTodoTarget(row)`. The helper
  returns a JSX fragment (not a string) so individual segments can
  carry the existing `.muted` separator class. Implementation tree:
  - minion-target: `Player • Syndicate • Minion`
  - syndicate-target: `Player • Syndicate`
  - game-target: `Game-wide` (defensive)
  - missing player slot: render `(unassigned)` literal (use the
    existing `.muted` token).

- [ ] **Task 8.** Sorting on the client. The server already returns
  pre-sorted rows (Task 1), so the client mounts them in array order.
  Document the contract in a comment on top of the component so a
  later refactor doesn't accidentally re-sort.

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

- [ ] **Task 12.** Optional badge on the "GM Todo" button showing
  the count of `ticking` (running or overdue) + `due_manual` rows
  whenever > 0. The count derives from the same query already in
  flight. If the badge styling already exists for `<NoteIcon>`
  (`src/components/NoteIcon.tsx:91-93`), reuse the markup; otherwise
  defer. Mark as **optional in v1**.

- [ ] **Task 13.** Client unit tests (vitest):
  - `formatGmTodoTarget(row)` renders the four branches above with
    correct fragments.
  - The drawer renders an empty-state node when the query returns
    `[]`.
  - Clicking a clock cell invokes the mutation with the correct
    `noteId` (mock `useMutation`).
  - The drawer never mounts when `viewerIsGm` is false (component
    invariant test on the parent).

### Documentation / housekeeping

- [ ] **Task 14.** Amend the file-top docblock in `convex/notes.ts`
  (`convex/notes.ts:12-35`) to mention the new GM-only aggregation
  query and explicitly call out that, like `attachedRollSetId` and
  `timer`, the projected payload never reaches Player sessions.

- [ ] **Task 15.** Add inline doc-comment headers to the new query
  and the new drawer component documenting:
  - the four-tier sort order,
  - the GM-only invariant,
  - the rationale for in-memory filtering of `timer !== undefined`
    (no dedicated index),
  - the read-amplification pattern (bulk-load auxiliaries once).

- [ ] **Task 16.** No standalone documentation file. Plan-level spec
  lives in this document; code comments cover the implementation.

## Verification Criteria

- A GM with no timer-bearing notes opens "GM Todo" and sees an
  "No clocks running." empty state.
- A GM creates a 5-minute timer on a minion-target note while a
  player has selected that syndicate. Opening "GM Todo" shows the
  row with `Player • Syndicate • Minion`, the clock counting down,
  and the body excerpted into the row.
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
  done — the drawer lists overdue, then running, then done.
- The popover-side notes UX (`NoteIcon`) is unchanged; the drawer
  renders timers in addition, never instead.
- No `console.error` / `console.warn` from the per-second
  `<NoteTimerCell>` re-renders when the drawer is open.

## Potential Risks and Mitigations

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
   Mitigation: if reviewer prefers, extract the new drawer into
   `src/components/GmTodoDrawer.tsx`. The plan is agnostic — Task 6
   notes both options. Default is co-location for symmetry with
   `GmToolsDrawer` and `GameLogDrawer`; a follow-up clean-up could
   extract all three together.

9. **Adding a per-row "Open in popover" deep-link is non-trivial
   (Task 11).**
   Mitigation: explicitly deferred in v1. The cycle action alone
   delivers the primary value; "Open" is a future polish.

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
