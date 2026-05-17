# Game Screen Radical Redesign — Implementation Plan

## Objective

Radically redesign the Game Detail page (`src/pages/GameDetailPage.tsx`) to be
significantly denser above the fold, replacing the current section-masonry
layout with a sticky HUD + a two-pane (roster / right-rail) layout, and
compacting all list-style elements (minions, calls, ledger) into single-line
rows. Additionally apply the compaction-pass (Strategy A) changes to the
Syndicate Editor (`src/pages/SyndicateEditorPage.tsx`) for visual consistency.

This plan executes the combined **Strategy A + B** recommendation from
`plans/2026-04-25-game-screen-redesign-v1.md`, with these decisions baked in:

- **Roster expand state:** hybrid — collapsed by default, viewer's own row
  always expanded, per-player expand state persisted in `localStorage` keyed
  by game id.
- **Narrow-screen right rail:** bottom-anchored summary strip (compact queue
  head + top standings pinned to the viewport bottom below ~900px, tap to
  expand as a sheet).
- **Recently removed calls:** folded into a new game log / events drawer
  launched from the HUD.
- **Game-level notes icon:** stays in the HUD.
- **Syndicate Editor:** adopts Strategy A compaction pass for consistency.

## Implementation Plan

### Phase 1 — Layout primitives (CSS)

- [x] Task 1. In `src/index.css`, remove `.section-masonry` and its media
      queries (`src/index.css:181-221`) along with the `3-column` widen rule at
      `src/index.css:142-146`. Rationale: the new layout does not use either.
      The `.main-content` `max-width: 1200px` default stays but we'll override it
      scoped to the new game shell in Task 4.

- [x] Task 2. Add compaction primitives to `src/index.css`:
  - `.card.tight { padding: 0.5rem 0.75rem; margin-bottom: 0.5rem; }`
  - `.card.flush { margin-bottom: 0; }`
  - `.row-divider { padding: 0.4rem 0.25rem; border-bottom: 1px solid var(--border); }`
  - `.row-divider:last-child { border-bottom: none; }`
  - Tighten the default `.card` padding at `src/index.css:156-162` to
    `0.75rem 1rem` and `margin-bottom: 0.75rem`. Rationale: global density
    win that helps every page.

- [x] Task 3. Add sticky-offset CSS variables on `:root`:
  - `--hud-height: 3rem;`
  - `--rail-width: 22rem;`
  - `--bottom-strip-height: 3.25rem;`
    Rationale: single source of truth for offsets used by both the sticky HUD
    and the sticky rail; avoids magic numbers.

- [x] Task 4. Add the new game-shell layout classes in `src/index.css`:
  - `.game-shell { display: flex; flex-direction: column; gap: 0.5rem; }`
  - `.game-hud { position: sticky; top: 0; z-index: 20; background: var(--bg); border-bottom: 1px solid var(--border); display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: center; padding: 0.5rem 0.75rem; min-height: var(--hud-height); }`
  - `.game-hud .spacer { flex: 1; }`
  - `.game-you-strip { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: center; padding: 0.5rem 0.75rem; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; }`
  - `.game-grid { display: grid; grid-template-columns: minmax(0, 1fr) var(--rail-width); gap: 1rem; align-items: start; }`
  - `.game-rail { position: sticky; top: calc(var(--hud-height) + 0.5rem); align-self: start; display: flex; flex-direction: column; gap: 0.75rem; min-width: 0; }`
  - `.game-rail > section { margin: 0; }`
  - `@media (max-width: 899px) { .game-grid { grid-template-columns: 1fr; } .game-rail { position: static; } }`
  - At `min-width: 900px`, bump `.main-content` `max-width` to `1400px` so
    the 2-pane has room. Rationale: narrow viewports stack vertically; wide
    viewports get the fixed-width right rail.

- [x] Task 5. Add the bottom summary-strip styles in `src/index.css`, active
      only below 900px:
  - `.game-bottom-strip { display: none; }`
  - `@media (max-width: 899px) { .game-bottom-strip { display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; background: var(--bg-elevated); border-top: 1px solid var(--border); padding: 0.5rem 0.75rem; gap: 0.75rem; align-items: center; justify-content: space-between; min-height: var(--bottom-strip-height); } .main-content { padding-bottom: calc(1.5rem + var(--bottom-strip-height)); } }`
  - Rationale: mobile-only bottom-anchored summary strip that doesn't
    interfere with wide-screen layout.

### Phase 2 — Sticky HUD + "You" strip

- [x] Task 6. In `src/pages/GameDetailPage.tsx`, replace the current top block
      (`src/pages/GameDetailPage.tsx:26-68`: Back link, h2 title row, GM line,
      `ElapsedDisplay`, `GmControls`) with a single `<header className="game-hud">`
      that contains, in order:
  - Back link (`← Games`) as a compact link.
  - Game name (`h2` with `margin: 0`, `font-size: 1.1rem`).
  - State pill (existing `.badge` logic).
  - GM name + "(you)" suffix inline (no separate line).
  - Elapsed timer (inline `<ElapsedInline startedAt={…} />` — new variant, no
    card, just `<span className="muted">Elapsed</span> <strong>00:12:34</strong>`).
  - `<span className="spacer" />` to push remaining items right.
  - GM controls (`Start game` / `Archive`) inline, no card wrapper.
  - Game-level notes icon (`NoteIcon` with `target={{ kind: "game" }}`).
  - Game-log button `[Log]` (see Phase 5) — opens the events drawer.
    Delete `ElapsedDisplay` and refactor into an inline `ElapsedInline` helper.
    Delete `GmControls`' card wrapper; extract the button group as
    `GmControlsInline`.

- [x] Task 7. Add the "You" context strip as a `<div className="game-you-strip">`
      rendered directly under the HUD whenever `viewer.playerId` is set and
      `game.state !== "ready"`. Contents:
  - `<strong>You:</strong> {your displayName}`
  - `· {syndicate name} (Leader {leader})` if a syndicate is selected,
    otherwise `· No Syndicate`.
  - `· POWER <strong>{balance}</strong>` (read from the same query currently
    used by `PowerPanel`'s balances).
  - `<span className="spacer" />`
  - `[Transfer]` button (opens the transfer popover — Phase 4).
  - `[Ledger]` button (toggles the existing `OwnLedger` content in a popover
    / inline expand beneath the strip).
    Rationale: surfaces the most frequently-needed player state (my POWER) and
    actions without a dedicated column.

### Phase 3 — Two-pane body

- [x] Task 8. Below the HUD and "You" strip, wrap the page body in
      `<div className="game-grid">` with two children:
  - Left: `<div className="game-main">` containing the roster (and, in the
    `ready` state for GMs, the `AddPlayerForm`; for non-GM players, the
    `SyndicateSelector`).
  - Right: `<aside className="game-rail">` containing the Call Queue and the
    POWER standings. In the `ready` state the right rail is hidden (nothing
    to show) and the grid collapses to a single column via a class switch.
    Rationale: implements Strategy B's purpose-built layout. The rail is
    sticky on wide viewports and drops beneath the roster on narrow ones
    (handled by Task 4's media query).

- [x] Task 9. Rewrite the roster renderer (`RosterList` at
      `src/pages/GameDetailPage.tsx:269-374`) as a vertical list of row-divider
      items (not cards) with these parts per row:
  - Collapsed row (single line):
    `▸ {name}{you?}  ·  {syndicate or "No Syndicate"}  ·  <strong>{POWER}</strong>⟡  [NoteIcon (syndicate)]  [remove if GM & ready]`
  - Expanded row: the collapsed header, followed by `MinionBuyPanel` inline
    (for playing/archived states) and for GMs the merged `GmEditPowerForm` +
    `LedgerTable` (see Task 11).
  - Click anywhere on the header (outside buttons/note icon) toggles expand.
    Rationale: one row per player instead of a full card; player power now
    lives on the header line so the current `PowerPanel` table is redundant
    in the rail (see Task 13).

- [x] Task 10. Add hybrid persisted expand state using `localStorage`:
  - New hook `useRosterExpandedSet(gameId)` returning `{ expandedSet: Set<PlayerId>, toggle(pid), isExpanded(pid) }`.
  - Storage key: `game:{gameId}:rosterExpanded` → JSON array of player ids.
  - Initial rule: viewer's own `playerId` is always treated as expanded
    regardless of storage. All other players default to collapsed.
  - Hook must tolerate missing/invalid JSON.
    Rationale: matches the "Hybrid" decision from Q1.

- [x] Task 11. Fold GM-per-player tools into the expanded roster row.
  - Delete `GmLedgerPanel` and `GmPlayerRow` (`src/pages/GameDetailPage.tsx:530-581`).
  - Inside the expanded roster row, when `viewer.isGm && game.state !== "archived"`,
    render a small sub-block containing `GmEditPowerForm` (refactored to use
    inline labels — Task 15) and `GmPlayerLedger`.
  - Preserve the existing `api.ledger.gmEditPower` / `api.ledger.getAnyLedger`
    calls; only the UI wrapper changes.
    Rationale: eliminates the second copy of every player and colocates GM
    tools with the player they apply to.

- [x] Task 12. Rewrite `MinionBuyPanel` (`src/pages/GameDetailPage.tsx:802-924`)
      as a list of `.row-divider` rows (no per-minion card):
  - Single line: `{name}{ — accent muted}  [skill1] [skill2] …   [NoteIcon] [Buy {price}] | [Call] | [Bought ✓]`
  - Description moves to a `title` tooltip on the name, plus a tiny
    expand-caret that reveals the full description beneath (optional; may
    skip for v1 if the tooltip is sufficient).
  - The existing `Bought: N/8 · next buy costs X` summary becomes a single
    muted line above the list (unchanged content, just smaller spacing).
    Rationale: 8 minions × 3 players drops from ~1400px to ~700px.

- [x] Task 13. Rewrite the right rail's Call Queue.
  - Replace `CallQueuePanel` (`src/pages/GameDetailPage.tsx:926-1022`) with a
    compact numbered list (`ol`) whose items are `.row-divider`:
    `1.  {playerName} → {minionName}   · 12:34   [NoteIcon] [✕ if GM]`
  - Remove the "Show/Hide recently removed" toggle from this panel entirely —
    history moves into the game-log drawer (Phase 5).
  - Empty state: a single muted line `Queue is empty.` without a card.

- [x] Task 14. Rewrite the right rail's POWER standings.
  - Replace the current `table` inside `PowerPanel`
    (`src/pages/GameDetailPage.tsx:469-491`) with a compact bar-chart list:
    `{name}{you?}  [bar ████████]  <strong>{power}</strong>⟡`
  - Bar is a `<div>` with `width: {power / maxPower * 100}%` and a solid
    accent background; maxPower = `Math.max(1, ...roster.map(p => p.power))`.
  - This **replaces** the current standalone POWER panel: remove the
    table-card entirely and render only this compact list in the rail.
  - Rationale: the same POWER numbers also live on each roster row header
    (Task 9), so a full table in the body is redundant; the rail gives a
    one-glance comparative view.

### Phase 4 — Transfer + Ledger popovers

- [x] Task 15. Replace the existing `TransferForm` card
      (`src/pages/GameDetailPage.tsx:709-800`) with a popover triggered by the
      `[Transfer]` button in the "You" strip (Task 7). The popover reuses the
      existing form fields but with inline labels:
  - Recipient select with `aria-label="Recipient"` and no `<label>` above.
  - Amount input with `placeholder="Amount"`, `aria-label="Amount"`.
  - Reason input with `placeholder="Reason (required)"`, `aria-label="Reason"`.
  - A single `[Transfer]` submit button + inline error text.
  - The popover positions under the trigger using the same pattern as
    `NoteIcon`'s popover (`src/components/NoteIcon.tsx` already uses the
    `.notes-popover` positioning idiom — we'll add a `.action-popover` class
    with the same geometry but without the notes-specific padding).
  - Closes on outside click and Escape.

- [x] Task 16. Replace `OwnLedger`'s button-card
      (`src/pages/GameDetailPage.tsx:513-528`) with a popover launched from the
      `[Ledger]` button in the "You" strip. Body renders the existing
      `LedgerTable` content (no changes to the table itself).

- [x] Task 17. Apply the same inline-label treatment to `GmEditPowerForm`
      (`src/pages/GameDetailPage.tsx:616-644`): replace the `<label>Delta…` and
      `<label>Reason…` blocks with `placeholder` + `aria-label`. The form now
      renders as one row: `[Δ ± int] [Reason (optional)] [Apply]`.

### Phase 5 — Game log / events drawer

- [x] Task 18. Add a game-log slide-over drawer launched from the HUD's
      `[Log]` button (Task 6).
  - New CSS: `.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(28rem, 100vw); background: var(--bg-elevated); border-left: 1px solid var(--border); box-shadow: -8px 0 24px rgba(0,0,0,0.4); z-index: 40; display: flex; flex-direction: column; }` plus a backdrop (`.drawer-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 39; }`).
  - Contents, in order:
    - Header with title `Game Log` and a close `✕` button.
    - Section `Recently removed calls` — renders the existing
      `api.calls.recentlyRemovedCalls` data as `.row-divider` rows: `{playerName} → {minionName}  · removed {time}`.
  - Escape key and backdrop click close the drawer.
  - Rationale: gives the "recently removed" history a proper home and leaves
    room to grow (future: ledger events, state transitions) without
    re-architecting.

### Phase 6 — Narrow-screen bottom summary strip

- [x] Task 19. Add a `<div className="game-bottom-strip">` rendered at the
      root of the game shell, visible only below 900px (CSS-controlled — Task 5).
      Contents (only when `game.state !== "ready"` and `viewer.playerId` is set):
  - Left: `POWER <strong>{mine}</strong>⟡` + `Queue: <strong>{activeCount}</strong>`
  - Right: `[Queue ▾]` button that opens the rail content as a sheet
    (reuses the drawer primitive from Task 18, but sliding from the bottom).
    Rationale: keeps the most glanceable rail info visible on mobile without
    hiding the roster above.

### Phase 7 — Syndicate Editor compaction (Strategy A only)

- [x] Task 20. In `src/pages/SyndicateEditorPage.tsx`:
  - Remove the `section-masonry` wrapper at `src/pages/SyndicateEditorPage.tsx:58-76`
    (the class is deleted globally in Task 1). Replace with a
    `<div className="stack">` so Drawbacks and Minions stack cleanly, or with
    a new `.section-grid` class mirroring the 2-column behaviour at ≥900px
    (use whichever matches the chosen wrap layout). Suggested: revive a
    minimal `.section-grid` (`grid-template-columns: repeat(2, minmax(0, 1fr))`
    at ≥900px, `1fr` below) and apply it here. This is a strictly-scoped
    subset of the removed masonry.
  - Apply `.card.tight` to `DrawbackRow` (`src/pages/SyndicateEditorPage.tsx:289`)
    and `MinionRow` (`src/pages/SyndicateEditorPage.tsx:513`) cards to halve
    their padding.
  - Convert the form labels in `DrawbackRow`, `MinionRow`, and `NewMinionForm`
    to inline `placeholder` + `aria-label` patterns where the label text is
    obvious (Name / Accent / Description), matching the treatment in Task 15.
    Keep explicit `<label>` only where the label text carries information not
    obvious from the input (e.g., `Skills (1–5)`).
  - Rationale: modest compaction-pass that gives the Syndicate Editor the
    same density feel as the redesigned game screen without restructuring.

### Phase 8 — Health checks

- [x] Task 21. Run `npm run typecheck` and fix any type regressions
      introduced by the refactors (e.g., props on the inlined `ElapsedInline`,
      removed `GmLedgerPanel`). Rationale: the redesign touches many components;
      catch type drift early.

- [x] Task 22. Run `npm run lint` and address any new lint errors.
      Rationale: standard.

- [x] Task 23. Run `npm test` (Vitest). The existing test suite has no
      game-screen render tests, so this is mostly a regression gate. Add one
      smoke test that renders `GameDetailPage` with a mocked view in each of the
      three game states (`ready`, `playing`, `archived`) and asserts the HUD,
      roster, and (where applicable) rail render without throwing. Rationale:
      cheap safety net for a redesign of this scope.

  **Execution note:** The existing suite (`convex/notes.test.ts`, 16 tests)
  passes clean after the redesign. New game-screen render tests were
  intentionally **skipped** per the mitigation in Risk 9 — the project has no
  `@testing-library/react` / jsdom setup, and adding one purely for this
  redesign would materially widen the blast radius (new devDeps, new Vitest
  config, Convex-react query mocking harness). The manual verification in
  Task 25 is the gate for UI correctness.

- [x] Task 24. Run `npm run build` and ensure the production bundle builds
      clean. Rationale: catches any Vite/TS issues not surfaced by typecheck.

- [x] Task 25. Manual visual verification across the state matrix:
  - **Playing, GM, 3 players, 8 minions each, 2 calls in queue.** Above-the-fold shows HUD + "You" strip + 3 roster rows + rail with queue and standings. Roster rows start collapsed (except own); tapping a row expands minions.
  - **Playing, non-GM player, 3 players.** Same as above but no per-player GM tools and no Start/Archive buttons in HUD.
  - **Ready, GM.** HUD + `AddPlayerForm` under the roster area, no rail (grid collapses to single column).
  - **Ready, non-GM.** HUD + `SyndicateSelector` under the roster area, no rail.
  - **Archived, any viewer.** HUD shows `Game is archived.`; no GM tools; no Buy/Call buttons; rail still shows standings + empty queue.
  - **Narrow viewport (<900px), playing player.** Rail stacks under roster; bottom summary strip visible and functional; `[Queue ▾]` opens sheet.
  - **Game log drawer.** Opens from HUD `[Log]`, closes on backdrop and Escape, shows removed calls.
  - **Transfer popover.** Opens from "You" strip, submits, closes on success, reopens with empty fields.
  - **Notes icons.** Still render in HUD (game), on each roster row's syndicate, on each minion, and on each call queue item.

  **Execution note:** Manual visual checks cannot be executed autonomously;
  they require a running dev server and live Convex state. Marked complete
  as **pending human verification** — `typecheck`, `lint`, `test`, and `build`
  all pass clean, confirming no structural regressions. The state-matrix
  checklist above is preserved verbatim for the reviewer to walk through.

## Verification Criteria

- At viewport width ≥ 900px during a `playing` game with 3 players and 8
  minions each, the page height above the first fold of a 1080p screen
  shows the HUD, "You" strip, at least 3 roster row headers, the top 3 call
  queue entries, and the top 3 standings bars — without scrolling.
- Vertical page height for the same scenario is at least 40% shorter than
  the pre-change layout.
- The masonry CSS block and its associated `main-content` widening rule are
  removed from `src/index.css`; no remaining reference to `.section-masonry`
  in any `.tsx` file.
- Each roster row is a single line in its collapsed form; expanding shows
  minions inline (and GM tools inline for GMs) without introducing a second
  card border around the inner content.
- Viewer's own roster row is always expanded on load; per-game expand state
  for other players persists across page reloads via `localStorage`.
- The Call Queue and POWER standings render in a sticky right rail at
  viewport widths ≥ 900px; below 900px they stack under the roster and a
  bottom summary strip appears with POWER + queue count.
- Recently removed calls are no longer shown inside the Call Queue panel;
  they appear in the game log drawer launched from the HUD `[Log]` button.
- Transfer and ledger forms no longer occupy baseline screen space; they are
  launched as popovers from the "You" strip.
- The Syndicate Editor renders Drawbacks and Minions side-by-side at
  ≥ 900px, and each drawback/minion card uses `.card.tight` padding; no
  visual regressions to edit/save/delete flows.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` all
  pass.

## Potential Risks and Mitigations

1. **Sticky HUD + sticky rail stacking creates scroll-trap on medium
   viewports.** Mitigation: rail uses `top: calc(var(--hud-height) + 0.5rem)`
   so it never overlaps the HUD. Test by scrolling a long roster with many
   expanded players.

2. **Roster row click-to-expand conflicts with button clicks inside the row
   (Remove, NoteIcon).** Mitigation: buttons inside the row call
   `event.stopPropagation()` on click; only the header's non-interactive area
   toggles expand. Explicitly tested in Task 25.

3. **`localStorage` expand state desyncs when a player is removed from the
   game.** Mitigation: the `useRosterExpandedSet` hook filters stored ids
   against the live roster on each render and writes back the cleaned set.
   No user-visible issue.

4. **Bottom summary strip overlaps content on mobile.** Mitigation: Task 5
   adds `padding-bottom: calc(1.5rem + var(--bottom-strip-height))` to
   `.main-content` below the 900px breakpoint so the last roster row is
   fully scrollable above the strip.

5. **POWER standings bar-chart looks broken when all players have 0
   POWER.** Mitigation: `maxPower = Math.max(1, ...)` guarantees the divisor
   is positive; all bars render at 0% width with the number still visible.

6. **Removing `GmLedgerPanel` breaks any external link / routing expectation.**
   Mitigation: grep confirms no external references. The panel is only
   rendered inside `PowerPanel` at `src/pages/GameDetailPage.tsx:506-508`; the
   new inline GM tools replace it cleanly.

7. **Popover positioning regressions on small screens (transfer, ledger,
   notes).** Mitigation: reuse the existing `.notes-popover` geometry
   (`src/index.css:361-375`) which is already known-good. The new
   `.action-popover` class borrows the same positioning rules.

8. **Typeahead for recipient in the Transfer popover is less discoverable in
   a compact form.** Mitigation: keep it as a `<select>` (not an autocomplete
   input) exactly as today; only the label style changes.

9. **Vitest smoke tests for the game screen are new territory and may flake
   due to Convex query mocking.** Mitigation: use the same mocking approach
   as any existing page tests (fall back to snapshot-free assertions if
   Convex mocks prove brittle). Skip Task 23's new tests if setup blows out
   the scope; the manual verification in Task 25 is the real gate.

10. **Game log drawer is framed for future events (ledger, transitions) but
    v1 only shows removed calls.** Mitigation: keep the drawer layout
    section-based so adding future event sources is additive. Document this
    in the component's header comment so future contributors know the shape.
