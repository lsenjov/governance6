# Allow Players to See Their Chosen Syndicate's Details During READY

## Objective

During the `ready` game phase, give non-GM players a clear, read-only view
of the **full details** (description, drawbacks, minions, skills, badges) of
the Syndicate they have currently selected — without forcing them to leave
the game page to navigate to the Syndicate Editor (`/syndicates/{id}`).

The aim is purely additive: keep the existing `<SyndicateSelector>`
unchanged in behavior, and surface a read-only details panel for whatever
syndicate the player has currently chosen so they can confirm their pick
and review their leader, drawbacks, and minion roster before the GM starts
the game.

## Context Summary

- **Selector today** (`src/pages/GameDetailPage.tsx:1480-1551`): renders a
  radio list of selectable syndicates returned by
  `api.syndicates.listSelectable` (`convex/syndicates.ts:240-265`). Each
  row shows only `name`, `leader`, and `Played` / `Shared` badges. The
  description, drawbacks, and minions are not visible.
- **Selection lifecycle**: locked to the `ready` state by
  `convex/games.ts:88-117` (Rule 13). Only the player themselves can call
  `selectSyndicate`. Selection is cleared when null is passed.
- **Roster join**: `gameDetail.roster` already exposes
  `selectedSyndicateId` and a denormalized `selectedSyndicate` summary
  (`convex/games.ts:264-280`), but only `name` and `leader` — not children.
- **Source query for full details**: `api.syndicates.getWithChildren`
  (`convex/syndicates.ts:204-235`) already returns
  `{ ...syndicate, drawbacks, minions, isOwner, canEdit }` and enforces
  visibility (owner OR `isShared=true`) — exactly the same selectability
  rule used by `listSelectable`. **No backend changes are required.**
- **Existing render of selectable details**: `SyndicateEditorPage` renders
  the same shape but as editable forms; we should not couple the READY
  view to the editor's form components. A small read-only display
  component is the right unit.
- **Where READY UI lives**: the player-side READY block is rendered at
  `src/pages/GameDetailPage.tsx:117-128` inside the
  `game-main` column under the heading "Your Syndicate". The new details
  panel should appear in this same section, anchored by the player's
  current `selectedSyndicateId`.

## Assumptions

1. Scope is limited to **non-GM players** during the **`ready`** state.
   Playing/archived already display the selected syndicate's name in the
   YouStrip (`src/pages/GameDetailPage.tsx:335-377`) and roster cards;
   they are out of scope here.
2. GMs do not select a syndicate, so this feature is gated on
   `viewer.playerId !== null` and `!viewer.isGm`. The GM-side
   `<AddPlayerForm>` block is unchanged.
3. The details view is **read-only** — no editing, sharing toggle, or
   deletion controls. Players who own the syndicate and want to edit it
   can navigate to the existing editor page via a link.
4. `api.syndicates.getWithChildren` is the single data source. It already
   gates visibility correctly (owner OR `isShared`) and matches what
   `listSelectable` exposes, so any syndicate a player can pick is also
   one they can view.
5. When the player has **no** current selection, the details panel is
   not rendered (no error; no skeleton). The selector's existing copy
   already covers the empty-selection state.
6. We render details for the **currently-selected** syndicate, not for
   each row in the radio list. Showing per-row inline previews is a
   plausible alternative (Alternative 2) but would inflate the READY
   view and is unnecessary because the selection is cheap to change.
7. No schema, mutation, or query changes. No new translations or analytics.

## Implementation Plan

### Phase 1 — Read-only details component

- [ ] Task 1. Add a new `<SelectedSyndicateDetails>` component in
  `src/pages/GameDetailPage.tsx` (co-located with `<SyndicateSelector>`
  to keep the READY-only UI together; new file is unnecessary per the
  project's existing pattern of large feature components living in this
  file). Props:
  - `syndicateId: Id<"syndicates">` (the currently selected id; if null,
    the parent does not render this component).
  - Internal: `useQuery(api.syndicates.getWithChildren, { syndicateId })`.
    Use the standard `undefined → loading`, `null → "not accessible"`,
    object → render path used by `SyndicateEditorPage.tsx:33-35`.
  - Render layout (read-only, mirrors the editor's information density
    but as static text, not inputs):
    - Header row: `<strong>{name}</strong>` with right-aligned
      `Played` / `Shared` badges (reuse `.badge warning` /
      `.badge accent` classes already used at
      `src/pages/GameDetailPage.tsx:1534-1535`).
    - Subline: `Leader {leader}` in the existing `.muted` style.
    - Description block: rendered as paragraphs preserving newlines
      (`white-space: pre-wrap`) and an empty-state `No description.`
      muted line when the field is blank.
    - Drawbacks section (`<h4>Drawbacks ({drawbacks.length}/5)</h4>`):
      list each `name` + truncated `description`. Empty state:
      `No drawbacks.` muted.
    - Minions section (`<h4>Minions ({minions.length}/8)</h4>`): list
      each minion's `name` (bold), optional `accent` (muted small),
      `description` (`pre-wrap`), and `skills` rendered as small pill
      badges (reuse `.badge` style or a comma-joined muted line — pick
      whichever already exists in the editor for consistency; if no
      pill style exists, use a comma-joined list to avoid new CSS).
    - Footer affordance: a muted link `Open in Syndicate Editor →`
      pointing to `/syndicates/{syndicateId}`. Open in the same tab.
      (Owner-only? No — we keep the link visible regardless; the
      editor itself already handles owner vs read-only viewers via
      `data.canEdit` at `src/pages/SyndicateEditorPage.tsx:48-54`.)
  - Wrap the whole block in `<div className="card stack">` to match the
    selector's container so they read as a coherent pair.
  - Rationale: gives the player a complete picture of the syndicate they
    selected without leaving the game flow, while delegating any actual
    editing (description, drawback edits, minion changes) to the
    existing editor screen.

- [ ] Task 2. Decide and document presentation density. Two acceptable
  variants:
  - **Variant A (default)**: Always render the details panel below the
    selector when a selection exists. Simple, no extra clicks.
  - **Variant B**: Render a collapsed `<details>`/disclosure with the
    syndicate name as the summary, expanded by default the first time
    a selection is made and collapsible after. Useful if vertical
    bloat is a concern on small viewports.
  - Pick **Variant A** for v1. Variant B can be revisited if real-world
    usage shows the panel pushes the rest of the READY UI offscreen on
    mobile. Rationale: simpler, fewer states, fewer hooks.

### Phase 2 — Wire-up in the READY player block

- [ ] Task 3. In the existing READY player section at
  `src/pages/GameDetailPage.tsx:117-128`, after the
  `<SyndicateSelector>`, derive `selectedSyndicateId` from the same
  roster lookup the selector already uses
  (`roster.find((p) => p._id === viewer.playerId)?.selectedSyndicateId`)
  and, when truthy, render `<SelectedSyndicateDetails syndicateId={…} />`.
  The wrapping `<section>` heading "Your Syndicate" should remain a
  single section containing both the selector and the details panel,
  so the player sees them as one cohesive unit.
  - Rationale: anchors the new view in the exact place the player is
    already focused while choosing.

- [ ] Task 4. Confirm the GM-side branch
  (`src/pages/GameDetailPage.tsx:110-115`) is unchanged. The new
  component is rendered only inside the non-GM branch (Task 3).
  Rationale: GMs do not select a syndicate during READY; surfacing
  details for them would be incorrect placement (their per-player
  roster row already shows the chosen-syndicate name and a
  `<NoteIcon>` for that target at
  `src/pages/GameDetailPage.tsx:786-808`).

### Phase 3 — Visual polish

- [ ] Task 5. Reuse existing CSS classes only (`.card`, `.stack`,
  `.row`, `.row-wrap`, `.row-divider`, `.muted`, `.badge`,
  `.badge warning`, `.badge accent`, `.section-grid`). Do **not**
  introduce new CSS variables, breakpoints, or class names.
  Rationale: keeps the change contained and avoids interfering with
  the v2/v4/v5 game-screen redesign work tracked in
  `plans/2026-04-25-game-screen-redesign-v*.md`.

- [ ] Task 6. Skill list rendering: prefer a comma-joined muted line
  (`<span className="muted" style={{ fontSize: "0.85rem" }}>{skills.join(", ")}</span>`)
  over per-skill pills, unless an existing pill class is already in
  use elsewhere for skills (none observed in `SyndicateEditorPage`'s
  read-only path). Rationale: avoids new CSS while keeping the list
  scannable.

- [ ] Task 7. Use `white-space: pre-wrap` on description fields so
  authored newlines render. Cap description with no truncation in the
  details view (the editor textareas are 4 rows but the read-only view
  should show full content; players need this to make their pick).
  Rationale: details view is the primary place players read these
  fields; truncation would defeat the feature's purpose.

### Phase 4 — Health checks

- [ ] Task 8. Run `npm run typecheck`. Expected clean — the new
  component only uses existing types (`Id<"syndicates">`,
  `Doc<"syndicates">` and the children docs from `getWithChildren`).
  Rationale: standard.

- [ ] Task 9. Run `npm run lint` and address new lint findings.
  Rationale: standard.

- [ ] Task 10. Run `npm test` (Vitest). The convex test suite
  (`convex/notes.test.ts`, `convex/treasonGrants.test.ts`, etc.) is
  unaffected because no Convex code changes; the existing suite should
  remain green. No new tests are added because the project has no
  React testing harness (per the v2 plan note at
  `plans/2026-04-25-game-screen-redesign-v2.md:265-278`). Manual
  verification covers the new UI.

- [ ] Task 11. Run `npm run build` to confirm the production bundle is
  clean. Rationale: catches any Vite/TS issues missed by typecheck.

- [ ] Task 12. Manual visual verification matrix:
  - **READY, non-GM, no selection.** Selector shown; details panel
    not rendered.
  - **READY, non-GM, owned syndicate selected.** Details panel shows
    name, `Played`/`Shared` badges (when applicable), leader,
    description, drawbacks count + list, minions count + list (with
    accents and skills), and the `Open in Syndicate Editor →` link
    navigating to `/syndicates/{id}` in the same tab.
  - **READY, non-GM, shared (non-owned) syndicate selected.** Details
    panel renders identically; `Shared` badge visible; clicking the
    editor link opens the editor in read-only mode (handled by
    `SyndicateEditorPage.tsx:48-54`).
  - **READY, non-GM, change selection.** Picking a different
    syndicate updates the panel reactively (Convex live query). No
    stale data lingers.
  - **READY, non-GM, clear selection.** Clicking `Clear selection`
    (`src/pages/GameDetailPage.tsx:1540-1548`) hides the details
    panel.
  - **READY, GM viewer.** No details panel anywhere in the page (the
    GM branch is unchanged; Add Player form continues to render).
  - **PLAYING / ARCHIVED, any viewer.** No details panel renders
    (READY-only feature).
  - **Editor-page deletion of a played-eligible syndicate while the
    game is READY.** Deletion clears the player's
    `selectedSyndicateId` (`convex/syndicates.ts:155-166`). Confirm
    the details panel disappears reactively without errors.

## Verification Criteria

- A non-GM player in a `ready` game sees a read-only details panel for
  their currently-selected syndicate immediately under the selector.
- The panel includes: name, leader, `Played`/`Shared` badges,
  description (newlines preserved), drawbacks list with names and
  descriptions, minions list with names, accents, descriptions, and
  skills, plus a link to the full editor page.
- The panel does not render when no syndicate is selected.
- The panel reacts live to selection changes (radio click, clear,
  upstream syndicate edits, deletion-cascade unselect).
- Visibility matches `listSelectable`: shared syndicates owned by other
  users render correctly; private syndicates owned by other users do
  not (they are also not selectable).
- No backend (`convex/`) code is modified; no schema changes; no new
  CSS files or class names.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`
  all pass.

## Potential Risks and Mitigations

1. **Vertical bloat pushes Add Player / Roster offscreen on mobile.**
   Mitigation: details panel is rendered only when a selection exists;
   description and lists wrap naturally. If usage shows the panel is
   too tall on phones, switch to Variant B (collapsed `<details>`)
   per Task 2 — a one-line follow-up.
2. **Stale data after another tab edits the same syndicate.**
   Mitigation: `useQuery(api.syndicates.getWithChildren, …)` is a
   live-reactive Convex subscription, so external edits propagate
   automatically — same model used by `SyndicateEditorPage`.
3. **Visibility leak for non-shared, non-owned syndicates.**
   Mitigation: `getWithChildren` already returns `null` for inaccessible
   syndicates; the component renders a muted "Syndicate not
   accessible." line and nothing else — never the children. This is
   defence-in-depth; in practice, `listSelectable` already constrains
   the set the player can have selected.
4. **Confusion between "details" link and the editor's own state.**
   Mitigation: the link copy is `Open in Syndicate Editor →`, making
   it clear this is a navigation away from the game; the read-only
   banner inside the editor (`SyndicateEditorPage.tsx:48-54`) already
   communicates that non-owners cannot edit.
5. **Coupling with the in-flight game-screen redesign
   (`plans/2026-04-25-game-screen-redesign-v5.md`).** The redesign
   leaves the READY-state layout on the v2 design (single column,
   `<SyndicateSelector>` in the main column) — see the v5 plan note at
   `plans/2026-04-25-game-screen-redesign-v5.md:274-282` and v5 Task 24
   matrix (`plans/2026-04-25-game-screen-redesign-v5.md:544-547`).
   Mitigation: this feature changes only the READY non-GM branch of
   `GameDetailPage.tsx` and reuses existing classes — it does not
   touch `<RosterCard>`, `<RosterCardGrid>`, or any
   playing-/archived-state code paths. Both efforts can land in
   either order without conflict.
6. **Performance: an extra Convex query per page load while READY.**
   Mitigation: the query is small (one syndicate + its drawbacks +
   minions; existing limits cap drawbacks at 5 and minions at 8). It
   is gated on a non-null selection, so it does not fire when the
   player has not chosen yet. This is the same query already used by
   the Syndicate Editor page.

## Alternative Approaches

1. **Inline preview per selector row (expandable).** Each row in
   `<SyndicateSelector>` becomes expandable, fetching details on
   demand. Trade-offs: lets players compare options, but adds
   per-row state, multiple in-flight queries while browsing, and
   pushes the existing roster further down the page. Rejected for v1
   because the task scope is "their **chosen** syndicate" — i.e.,
   post-pick — and live-comparing options is a separate UX concern.
2. **Modal / drawer triggered by a "View" button on the selected
   row.** Trade-offs: keeps the page compact but hides the details
   behind an extra interaction. Rejected for v1 because the player's
   first action after picking is precisely to confirm what they
   chose; a click-to-open modal slows that down without benefit.
3. **Reuse `SyndicateCore` from `src/pages/SyndicateEditorPage.tsx`
   in disabled mode.** Trade-offs: minimal new code, but couples the
   READY view to the editor form's lifecycle, useState, mutations,
   and disabled-input styling. Rejected because we want a
   dedicated read-only display, not a form whose inputs happen to be
   disabled — and because lifting `SyndicateCore` into a shared
   module is a larger refactor than the feature warrants.
4. **Extend `roster.selectedSyndicate` denormalisation in
   `convex/games.ts:264-280` to include drawbacks + minions.**
   Trade-offs: avoids a second Convex query, but inflates every
   `gameDetail` payload for every viewer (GM included) regardless of
   whether they need the children. Rejected because the cost
   profile is wrong: only a non-GM player's own row needs full
   children, and only during READY.
