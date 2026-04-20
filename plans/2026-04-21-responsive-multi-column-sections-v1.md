# Responsive Multi-Column Section Layout

## Objective

On wide viewports, render the top-level `<section>` elements of the Game Detail page (Roster, Add Player, Your Syndicate, POWER, Your Minions, Call Queue) and the Syndicate Editor page (Drawbacks, Minions) in a 2-column layout at a medium breakpoint and a 3-column layout at a wide breakpoint. For example, Roster should sit next to POWER in a single row on a wide screen. Narrow / mobile viewports retain the current stacked single-column layout.

## Implementation Plan

- [ ] Task 1. Introduce a new `.section-grid` utility class in `src/index.css` that lays out its direct `<section>` children in a responsive CSS grid. Rationale: matches the existing utility-class approach (`.stack`, `.row`, `.row-wrap`) and is reusable across any page with multiple sections. The class should:
  - Default to `grid-template-columns: 1fr` (single column) so narrow screens match current behavior.
  - At `min-width: 900px`, switch to `repeat(2, minmax(0, 1fr))`.
  - At `min-width: 1400px`, switch to `repeat(3, minmax(0, 1fr))`.
  - Use `gap: 1.5rem` (matches the current inline `marginTop: "1.5rem"` used between sections).
  - Use `align-items: start` so each section hugs the top of its grid cell and does not stretch vertically (short sections in a row do not try to match the tallest sibling's height).
  - Descendants: `.section-grid > section { margin: 0; min-width: 0; }` — removes residual margins, and `min-width: 0` is critical so section contents (e.g., wide tables in PowerPanel) don't force grid tracks to overflow.
  - Optional tidy rule: `.section-grid > section > :first-child { margin-top: 0; }` to neutralize the default top margin on each section's `<h3>` heading within a grid cell.

- [ ] Task 2. Widen `.main-content` at the 3-column breakpoint so three columns actually have room. Rationale: the current `max-width: 1200px` at `src/index.css:130-136` would give each column only ~380px minus gaps, which is cramped for content like PowerPanel's 2-column table with a GM tools subpanel. Add a media query at `min-width: 1400px` that raises `max-width` to `1600px` (each column ≈ 510px including gap). Do not widen at 900–1399px — the current 1200px works well for 2 columns.

- [ ] Task 3. Update `src/pages/GameDetailPage.tsx` to wrap all six sections in a single `<div className="section-grid">` container inserted between the GM controls block and the current first `<section>Roster</section>`. Place **every** conditional section branch inside that wrapper, including the React fragment (`<>…</>`) around POWER / Your Minions / Call Queue. Rationale: keeps the single grid container so the browser performs one row-first auto-placement pass across all visible sections (so at 2 columns you get `Roster | POWER` on row 1 and `Your Minions | Call Queue` on row 2, matching the user's example). The wrapper should carry `style={{ marginTop: "1.5rem" }}` (or a dedicated class) to preserve the current separation between the header area and the sections.

- [ ] Task 4. Remove the now-redundant inline `style={{ marginTop: "1.5rem" }}` from each of the six `<section>` tags at `src/pages/GameDetailPage.tsx:70, 82, 89, 103, 114, 125`. Rationale: inter-section spacing is now handled by the grid `gap`, so the inline top-margins would add unwanted extra space inside grid cells and would be inconsistent with the grid model.

- [ ] Task 5. Update `src/pages/SyndicateEditorPage.tsx:41-57` to wrap the two `<section>` elements (Drawbacks, Minions) in a `<div className="section-grid">` container placed directly after `<SyndicateCore … />`. Give the wrapper `style={{ marginTop: "1.5rem" }}` for the same reason as Task 3. Rationale: the Syndicate editor benefits symmetrically — on wide screens Drawbacks and Minions sit side-by-side, doubling usable vertical space.

- [ ] Task 6. Remove the inline `style={{ marginTop: "1.5rem" }}` from both `<section>` tags at `src/pages/SyndicateEditorPage.tsx:41, 50`. Rationale: same as Task 4.

- [ ] Task 7. Visually verify no regressions for conditional sections in Game Detail:
  - State = "ready", GM viewer: Roster + Add Player → 2 columns at ≥ 900px.
  - State = "ready", non-GM with playerId: Roster + Your Syndicate → 2 columns at ≥ 900px.
  - State = "playing" with playerId: Roster + POWER + Your Minions + Call Queue → 2 columns × 2 rows at 900–1399px, or 3 columns × 2 rows (one partial) at ≥ 1400px. Confirm "Roster next to POWER" holds on the first row.
  - State = "archived", GM: Roster + POWER + Call Queue (no Minions) → same layout with a partial final row.
  - Narrow viewport (< 900px): all lists render as before (single column).

- [ ] Task 8. Run project health checks to confirm no regressions: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. Rationale: the changes are CSS + JSX wrapper additions with no type or API impact; checks should pass unchanged.

## Verification Criteria

- At viewport width < 900px, Game Detail and Syndicate Editor render their sections in a single column, visually indistinguishable from pre-change behavior. Section-to-section spacing is ~1.5rem.
- At viewport width 900–1399px, Game Detail renders exactly 2 columns of sections, with `Roster` appearing in the top-left cell and the next visible section (POWER when playing, Add Player / Your Syndicate when ready) in the top-right cell. Syndicate Editor renders Drawbacks and Minions side-by-side.
- At viewport width ≥ 1400px, the main-content area widens to 1600px and Game Detail renders 3 columns of sections; Syndicate Editor continues to render its 2 sections side-by-side with extra right-side whitespace (since it only has 2 sections).
- Each section hugs the top of its grid cell; a shorter section (e.g., Roster with one player) does not stretch to match the height of a taller sibling (e.g., POWER with GM tools expanded).
- Section headings (`h3`) render without extra top padding/space introduced by the new wrapper.
- PowerPanel's table and Your Minions' cards do not overflow their grid track at the 3-column breakpoint.
- No TypeScript, lint, or test regressions.

## Potential Risks and Mitigations

1. **PowerPanel table cramped in a 3-column track (~510px) at the ≥1400px breakpoint.**
   Mitigation: Task 2 widens main-content to 1600px at that breakpoint, keeping each column ~510px including gaps; PowerPanel's "Player | POWER" table is only two narrow columns and fits easily. If the GM tools sub-panel inside PowerPanel proves too cramped, fall back to 2 columns by removing only the `min-width: 1400px` rule (one-line revert).

2. **Auto-placement could give visually unbalanced rows (e.g., a very tall Your Minions next to a short Call Queue leaves dead space).**
   Mitigation: `align-items: start` keeps cells top-aligned so whitespace appears below short cells rather than stretching them; optionally add `grid-auto-flow: dense` later if desired. The ragged appearance is an accepted, standard CSS Grid behavior.

3. **Conditional rendering with React fragments inside the grid container.**
   Mitigation: React fragments are transparent to the DOM, so `<section>` children of the fragment will still be direct children of `.section-grid` and will participate in the grid. No special handling required.

4. **Residual `marginTop` inline styles if not removed in Tasks 4 and 6 would be additive to grid gap.**
   Mitigation: The CSS rule `.section-grid > section { margin: 0 }` defensively neutralizes any inline top margin; the inline removals in Tasks 4 and 6 are cleanup for clarity rather than strict correctness.

5. **Accessibility: reading order.**
   Mitigation: CSS Grid does not reorder the DOM, so screen-reader and keyboard tab order remain source order (Roster → Add Player/Your Syndicate → POWER → Your Minions → Call Queue), matching the existing behavior.

6. **Max-width change on main-content could affect any other full-width content on other pages at ≥1400px.**
   Mitigation: The widening is safe because all existing pages use centered, self-contained layouts (cards, lists, forms) that simply get more horizontal room; no page depends on a 1200px cap. Verify by spot-checking the Games, My Syndicates, Shared Syndicates, and Profile pages at ≥1400px. If undesired, scope the widening to a more specific selector such as `.main-content:has(.section-grid)` (CSS `:has()` is broadly supported in modern browsers).

## Alternative Approaches

1. **CSS `column-count` (newspaper-style columns).**
   Trade-offs: Simpler CSS (`columns: 2/3`), auto-balances heights. But places items column-first, so at 2 columns the order becomes `Roster / Add Player` in column 1 and `POWER / Your Minions / Call Queue` in column 2 — Roster would appear _above_ POWER, not _next to_ it. Directly conflicts with the user's stated example, so rejected.

2. **Fluid `auto-fit` + `minmax()` grid instead of explicit breakpoints.**
   Trade-offs: One rule (`grid-template-columns: repeat(auto-fit, minmax(480px, 1fr))`) auto-selects the column count. Elegant, but at very wide viewports it could produce 4+ columns (unlikely with main-content capped, but possible if the cap is also raised). Explicit breakpoints give predictable 1/2/3 tiers as the user described.

3. **Keep `.main-content` capped at 1200px and forgo 3 columns.**
   Trade-offs: Simpler (no main-content widening), but user explicitly asked for "two or three columns". This alternative delivers only 1 or 2 columns, falling short of the ask.

4. **Introduce the grid only on Game Detail page and not Syndicate Editor.**
   Trade-offs: Smaller scope, but inconsistent UX. Syndicate Editor has the same `<section>` structure and benefits from the same layout. Recommended only if scope needs to be trimmed.

5. **Use a dedicated wrapper class (e.g., `.page-sections`) with built-in top margin instead of the inline `style={{ marginTop: "1.5rem" }}` on the wrapper.**
   Trade-offs: Cleaner, more declarative. Minor refactor; can be folded into `.section-grid` via `.section-grid { margin-top: 1.5rem }` or kept as a separate class for reuse. Low priority cosmetic improvement.
