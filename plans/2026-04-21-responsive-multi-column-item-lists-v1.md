# Responsive Multi-Column Item Lists

## Objective

On wider viewports, render item lists (Games, My Syndicates, Shared Syndicates, and the in-game Roster / Minion lists) in 2 columns at a medium breakpoint and 3 columns at a wide breakpoint, while preserving the existing single-column layout on narrow / mobile viewports. This should be achieved via a reusable CSS utility class so the pattern can be consistently applied and easily maintained.

## Implementation Plan

- [ ] Task 1. Define a new responsive grid utility class in `src/index.css` (e.g. `.card-grid`). Rationale: a single source of truth for the responsive column behavior, consistent with existing utility-class patterns like `.stack`, `.row`, `.row-wrap`, `.grid-2`, `.grid-3`. The class should:
  - Default to 1 column (`grid-template-columns: 1fr`) so narrow screens keep the current stacked layout.
  - At `min-width: 720px` switch to `repeat(2, minmax(0, 1fr))`.
  - At `min-width: 1080px` switch to `repeat(3, minmax(0, 1fr))`.
  - Use a `gap` that matches the visual spacing already produced by `.stack` (~`1rem`).
  - Ensure children stretch (`align-items: stretch`) so cards in the same row share height.

- [ ] Task 2. Ensure cards inside `.card-grid` look right when placed side-by-side. Rationale: current `.card` has `margin-bottom: 1rem` at `src/index.css:146-152`, which would double-space grid rows. Add a rule that neutralizes `margin-bottom` for `.card` elements inside `.card-grid` (grid `gap` handles spacing), and make direct-child cards fill the grid cell (`height: 100%`). This avoids regressing existing `.stack` usage elsewhere.

- [ ] Task 3. Apply `.card-grid` to the Games list container in `src/pages/GamesListPage.tsx:62`, replacing the `<div className="stack">` wrapper that contains the `games?.map(...)` cards. Rationale: this is the primary "items list" page users see after sign-in.

- [ ] Task 4. Apply `.card-grid` to the My Syndicates list container in `src/pages/SyndicatesListPage.tsx:100`, replacing the `<div className="stack">` wrapper around the syndicate card map. Rationale: same user-facing list pattern as Games.

- [ ] Task 5. Apply `.card-grid` to the Shared Syndicates list container in `src/pages/SharedSyndicatesPage.tsx:21`, replacing the `<div className="stack">` wrapper around the shared syndicate card map. Rationale: same user-facing list pattern; benefits equally from multi-column display.

- [ ] Task 6. Apply `.card-grid` to the Roster list in `src/pages/GameDetailPage.tsx:316-371`, on the `<div className="stack">` that wraps the `roster.map(...)` cards (keep the error message rendered above the grid, not inside it, to preserve full-width error display). Rationale: on wider screens, a 2- or 3-column roster is much more scannable than a long vertical list. Assumption: the error banner should remain full-width above the grid.

- [ ] Task 7. Apply `.card-grid` to the Minion list in `src/pages/GameDetailPage.tsx:840-920`, on the outer `<div className="stack">` that wraps `data.minions.map(...)`. Keep the error banner and the "Bought: X/8 · next price…" muted summary outside the grid so they render full-width above it. Rationale: consistent multi-column presentation of minion cards on wide screens.

- [ ] Task 8. Visually verify no regressions in:
  - Form cards (create Game / create Syndicate forms above the lists) — these are not inside the new grid and should remain unchanged.
  - Empty-state `muted` messages ("No games yet.", "No Syndicates yet.", etc.) — should still render normally; confirm they are siblings of the grid container, not children, so they don't become a grid cell.
  - Narrow mobile widths (<720px) — all five lists should still appear as a single vertical column and match the pre-change look.

- [ ] Task 9. Spot-check horizontal layout of row cards (`.card.row` with `justify-content: space-between`, e.g. the Syndicates card with its Delete button). At narrower grid tracks the right-aligned button should remain visible; if button overflows on the narrowest 2-column track, add `flex-wrap: wrap` / `gap` where necessary. Rationale: with ~360px/track at the 2-column breakpoint, long syndicate names alongside a Delete button may wrap, which is acceptable, but should be confirmed.

- [ ] Task 10. (Optional) Add a brief inline comment in `src/index.css` near `.card-grid` explaining the breakpoints, since they do not appear elsewhere in the stylesheet. Rationale: future maintainers can quickly find and adjust the thresholds without hunting through media queries.

## Verification Criteria

- At viewport width < 720px: all five affected lists display exactly one item per row (no horizontal shrinkage, no layout shift vs. current behavior).
- At viewport width 720–1079px: Games, My Syndicates, Shared Syndicates, Roster, and Minion lists each display exactly 2 items per row with equal column widths.
- At viewport width ≥ 1080px: the same five lists display exactly 3 items per row with equal column widths.
- Vertical and horizontal spacing between cards is visually consistent with the current single-column spacing (~1rem) and no double-spacing appears from residual `.card` margins.
- Cards in the same grid row have equal height regardless of description/badge content differences.
- Empty-state messages (`No games yet.`, `No Syndicates yet.`, `No shared Syndicates yet.`, `No Players yet.`, `No Syndicate selected.`) and inline error banners continue to render full-width above their respective lists.
- Forms (Create Game, Create Syndicate, Add Player) remain full-width single-column and are unaffected.
- No TypeScript, lint, or test regressions (`npm run typecheck`, `npm run lint`, `npm test`).

## Potential Risks and Mitigations

1. **Card internal layout (`.card.row` with `justify-content: space-between`) may crowd at the 2-column breakpoint on mid-size screens.**
   Mitigation: Rely on the existing `row-wrap` / flex behavior; if necessary, convert the affected `.row` wrappers inside cards to `.row-wrap`, or allow the right-hand action (Delete / badge) to wrap beneath the title at narrow grid tracks. Verify via Task 9.

2. **Double spacing between cards due to `.card { margin-bottom: 1rem }` combining with grid `gap`.**
   Mitigation: Task 2 explicitly zeroes the bottom margin for `.card` elements that are direct children of `.card-grid`; the existing rule continues to apply outside the grid, preserving current behavior elsewhere.

3. **Unequal card heights producing a ragged visual appearance.**
   Mitigation: Task 2 sets children to stretch and `height: 100%`, so all cards in a row visually align.

4. **Breakpoints may not match the aesthetic preferences of the project.**
   Mitigation: Breakpoints are centralized in the single `.card-grid` rule; changing them later is a one-line edit. Document them in a comment (Task 10).

5. **Regression risk for in-game panels (Roster, Minions) if the maintainer prefers them to stay single-column for readability during live play.**
   Mitigation: Tasks 6 and 7 are listed last and can be skipped or reverted independently. If desired, the scope can be trimmed to only the three top-level list pages.

6. **Accessibility: reading order in a CSS grid follows DOM order, which remains top-to-bottom per source; but keyboard tab order across a 3-column grid may feel less linear for some users.**
   Mitigation: CSS Grid does not alter DOM order, so tab order remains source order (left-to-right, row-by-row), which matches the visual order. No ARIA changes needed.

## Alternative Approaches

1. **Use `grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))` on a single utility class.**
   Trade-offs: Simpler CSS (no media queries), auto-adapts to any viewport, and columns emerge naturally based on available space. However, it cannot enforce a strict "2 at medium, 3 at wide" cap — at very wide viewports it could show 4+ columns, which may or may not be desired. Recommended if the user prefers fully fluid behavior instead of discrete 1/2/3 tiers.

2. **Reuse and enhance the existing `.grid-2` / `.grid-3` classes.**
   Trade-offs: Avoids adding a new class. However, those classes are fixed at 2 or 3 columns with no mobile fallback — retrofitting them with media queries would silently change the semantics of a class name that implies a fixed column count, risking surprise if they're used elsewhere later. Using a new `.card-grid` is safer and clearer.

3. **Use CSS columns (`column-count: 2/3` with media queries) instead of CSS grid.**
   Trade-offs: Works with variable-height cards without needing explicit stretching, but breaks up cards across columns in an uneven, newspaper-like flow, and does not align rows horizontally. Not recommended for card lists with interactive children.

4. **Apply multi-column layout only to the three top-level list pages (Games, My Syndicates, Shared Syndicates) and leave in-game Roster / Minion lists single-column.**
   Trade-offs: Smaller surface area for change and less visual disruption during live gameplay. However, it loses the readability win on wide screens for rosters and minion catalogs. This corresponds to stopping after Task 5.
