# Game Screen "Command Deck" — Strategy C Implementation Plan

## Objective

Layer **Strategy C** from `plans/2026-04-25-game-screen-redesign-v1.md:120-146` on
top of the v2 HUD + 2-pane foundation, turning the Game Detail page
(`src/pages/GameDetailPage.tsx`) into a live-game "command deck" dashboard:

- A sticky **bottom action dock** for the current player's high-frequency
  actions (`Buy`, `Call`, `Transfer`, `Notes`).
- A **roster-as-grid** layout where each player is a compact card with a
  dense 4×2 **minion tile grid** (square tiles, state-colored).
- A **narrow left call-queue rail** with syndicate-colored numbered pills.
- A **GM slide-over overlay** replacing the inline GM-per-player tools.
- A **unified notes drawer** that replaces the per-target `NoteIcon` popover
  with a single slide-over surface.

This plan assumes v2 (`plans/2026-04-25-game-screen-redesign-v2.md`) has
shipped — it builds on the sticky HUD, "You" strip, grid shell, compaction
primitives, and drawer component already in place.

## Assumptions (defaults baked in — confirm before execution)

Strategy C introduces several UX decisions that were deliberately deferred
from v2. Defaults are listed below; flag any you want to change before I
start implementation.

| # | Decision | Default |
|---|----------|---------|
| 1 | Does the action dock replace v2's mobile bottom-summary strip, or coexist? | **Replace** — one unified `.action-dock` at the bottom that adapts (mobile: queue summary + `[Buy]` `[Call]` `[•••]`; desktop: full dock). |
| 2 | Does `[Buy]` in the dock one-click-buy, or open a picker? | **Always a picker.** All unbought minions cost the same `nextPrice` (the ladder in `convex/minionBuys.ts:14` is based on `boughtCount`, not per-minion), so there is no "cheapest" shortcut. The dock button is labelled `[Buy {nextPrice} ▾]` and opens the unbought-minion picker on click. |
| 3 | Tile grid breakpoints within each roster card | **Fixed 4×2** at all widths; tiles flex to match card width. |
| 4 | Roster-card column count | **1** <900px, **2** 900–1399px, **3** 1400–1799px, **4** ≥1800px. |
| 5 | Where do POWER standings live once the left rail holds the queue? | **New slim right rail** — 3-pane layout on ≥1280px (queue · roster · standings); right rail collapses into roster headers on 900–1279px; everything stacks <900px. |
| 6 | GM slide-over scope | Δ power form + per-player ledger only. Archive/start buttons **stay in the HUD**. |
| 7 | Notes drawer replaces `NoteIcon` popover **only inside the game screen** | Yes — other pages (Syndicate Editor, etc.) keep the existing popover. |
| 8 | Minion description visibility in tile grid | **Tooltip (`title=`) + on-tap flip** — tap a tile to reveal description on the back of the tile; tap again to flip back. Buy/Call live on the front. (Fallback: hover reveal on desktop.) |
| 9 | Tile click behaviour when unbought + affordable + self | **Buy immediately** (no confirm); error toast on failure. |
| 10 | Syndicate color mapping for queue pills | Hash of syndicate name → one of 8 preset hues; deterministic across sessions. No schema changes. |

## Implementation Plan

### Phase 1 — Layout primitives (CSS)

- [ ] Task 1. Introduce 3-pane shell variables and classes in `src/index.css`:
  - Add `:root` vars: `--queue-rail-width: 8rem;` and
    `--standings-rail-width: 14rem;` (replaces `--rail-width` usage inside
    the game shell; the old var stays for any external callers).
  - New class `.game-grid-3 { display: grid; grid-template-columns: var(--queue-rail-width) minmax(0, 1fr) var(--standings-rail-width); gap: 1rem; align-items: start; }`.
  - Media-query overrides:
    - `@media (max-width: 1279px) { .game-grid-3 { grid-template-columns: var(--queue-rail-width) minmax(0, 1fr); } .game-standings-rail { display: none; } }`
    - `@media (max-width: 899px) { .game-grid-3 { grid-template-columns: 1fr; } .game-queue-rail { position: static; } }`
  - Rationale: lets us keep v2's `.game-grid` for the ready-state fallback
    while the "playing" state switches to the 3-pane shell.

- [ ] Task 2. Roster grid (inside the center pane) in `src/index.css`:
  - `.roster-cards { display: grid; grid-template-columns: 1fr; gap: 0.75rem; }`
  - `@media (min-width: 900px) { .roster-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }`
  - `@media (min-width: 1400px) { .roster-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); } }`
  - `@media (min-width: 1800px) { .roster-cards { grid-template-columns: repeat(4, minmax(0, 1fr)); } }`
  - `.roster-card { padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elevated); display: flex; flex-direction: column; gap: 0.5rem; }`
  - `.roster-card.self { border-color: var(--accent); }`
  - Rationale: implements assumption #4.

- [ ] Task 3. Minion tile grid in `src/index.css`:
  - `.minion-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.35rem; perspective: 600px; }`
  - `.minion-tile { position: relative; aspect-ratio: 1 / 1; min-height: 4.25rem; transform-style: preserve-3d; transition: transform 180ms ease; cursor: pointer; }`
  - `.minion-tile.flipped { transform: rotateY(180deg); }`
  - `.minion-tile-face { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: space-between; padding: 0.35rem; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); backface-visibility: hidden; overflow: hidden; font-size: 0.75rem; }`
  - `.minion-tile-face.back { transform: rotateY(180deg); background: var(--bg-elevated); font-size: 0.7rem; line-height: 1.2; padding: 0.35rem 0.4rem; }`
  - State modifiers:
    - `.minion-tile.state-bought .minion-tile-face.front { background: color-mix(in srgb, var(--success) 18%, var(--bg)); border-color: var(--success); }`
    - `.minion-tile.state-queued .minion-tile-face.front { box-shadow: 0 0 0 2px var(--accent); animation: tile-pulse 1.6s ease-in-out infinite; }`
    - `.minion-tile.state-unaffordable { opacity: 0.45; cursor: not-allowed; }`
    - `@keyframes tile-pulse { 0%,100% { box-shadow: 0 0 0 2px var(--accent); } 50% { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 60%, transparent); } }`
  - Rationale: assumption #3, #8, #9.

- [ ] Task 4. Left queue rail + pill styles in `src/index.css`:
  - `.game-queue-rail { position: sticky; top: calc(var(--hud-height) + 0.5rem); align-self: start; display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }`
  - `.queue-pill { display: flex; align-items: center; gap: 0.35rem; padding: 0.35rem 0.4rem; border-radius: 999px; font-size: 0.72rem; line-height: 1; background: var(--bg-elevated); border: 1px solid var(--border); }`
  - `.queue-pill .num { font-weight: 700; font-size: 0.68rem; background: var(--accent); color: var(--bg); border-radius: 999px; padding: 0.1rem 0.35rem; min-width: 1.1rem; text-align: center; }`
  - `.queue-pill[data-color="0"] { --pill-hue: 210; } … [data-color="7"] { --pill-hue: 330; }` (8 preset hues)
  - `.queue-pill { border-color: hsl(var(--pill-hue, 210) 50% 45%); }`
  - Rationale: implements assumption #10.

- [ ] Task 5. Bottom action dock in `src/index.css`:
  - `.action-dock { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; display: flex; gap: 0.5rem; padding: 0.5rem 0.75rem; background: var(--bg-elevated); border-top: 1px solid var(--border); min-height: var(--bottom-strip-height); align-items: center; }`
  - `.action-dock .summary { margin-right: auto; font-size: 0.85rem; }`
  - `.action-dock button { padding: 0.4rem 0.75rem; }`
  - `@media (max-width: 899px) { .action-dock .dock-desktop-only { display: none; } }`
  - Ensure `.main-content` still has its bottom padding from v2's Task 5 so
    the dock doesn't cover the last row.
  - Rationale: merges v2's `.game-bottom-strip` into a single dock
    (assumption #1). Deletion of `.game-bottom-strip` is handled in Task 15.

- [ ] Task 6. Slide-over overlay class in `src/index.css`:
  - `.slide-over` reuses v2's `.drawer` layout but is wider:
    `.drawer.wide { width: min(40rem, 100vw); }`
  - Add a `.drawer-section { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }` helper for the GM overlay's player list.
  - Rationale: the GM overlay and the notes drawer both benefit from a
    uniform section divider.

### Phase 2 — Bottom action dock

- [ ] Task 7. Create `<ActionDock>` component in
  `src/pages/GameDetailPage.tsx` rendered at the root of the game shell
  (above `BottomStrip`, which is deleted in Task 15). The dock is only
  rendered when `viewer.playerId` is set and `game.state === "playing"`.
  - Left (`.summary`): `POWER <strong>{myPower}</strong> · Queue <strong>{activeCount}</strong>`.
  - Buttons (desktop order): `[Buy {nextPrice} ▾]` `[Call ▾]` `[Transfer]`
    `[Notes]`.
  - Hide `[Transfer]` and `[Notes]` text on mobile — keep `[Buy]`, `[Call]`,
    and a `[•••]` overflow that opens a sheet with Transfer + Notes.
  - Wire `[Buy {nextPrice} ▾]` to open a minion-picker popover listing the
    viewer's unbought minions; clicking one invokes
    `api.minionBuys.buyMinion`. The picker shows each unbought minion's
    name, accent, and skills; the single global `nextPrice` is shown once
    in the popover header (not per row) since all unbought minions cost
    the same. The dock button is disabled when `nextPrice === null` (all 8
    bought) or when the viewer's POWER < `nextPrice`.
  - Wire `[Call ▾]` to a popover listing the viewer's bought minions;
    clicking one invokes `api.calls.addOrReplaceCall`.
  - `[Transfer]` re-uses the existing `<ActionPopover>` from v2 with the
    current `TransferForm` — the "You" strip's Transfer trigger moves here
    (see Task 8).
  - `[Notes]` opens the new `<NotesDrawer>` from Phase 5 pre-loaded with
    the game-level target.

- [ ] Task 8. Collapse the v2 "You" strip into the HUD + action dock:
  - The HUD keeps `{yourName} · {syndicate} · POWER {X}` as inline metadata
    (muted text, right side before the spacer).
  - Remove the `<YouStrip>` component rendering; the Transfer / Ledger
    buttons move to the action dock and the HUD respectively.
  - Ledger becomes a HUD `[Ledger]` button (popover identical to v2's
    `LedgerButton`) for the current viewer.
  - Rationale: the "You" strip was a transitional UI in v2; Strategy C
    obviates it by promoting dock + HUD.

### Phase 3 — Roster-as-grid + minion tile grid

- [ ] Task 9. Rewrite `<RosterList>` (`src/pages/GameDetailPage.tsx:654-698`)
  to render a `<div className="roster-cards">` with a `<RosterCard>` per
  player.
  - `<RosterCard>` replaces the current single-line `<RosterRow>`:
    - Header row: portrait dot (syndicate color), `{displayName}{you?}`,
      `{syndicate name}`, `<strong>{POWER}</strong>⟡`, right-aligned
      `[•••]` menu (only visible on hover / always visible when GM).
    - Body: `<MinionTileGrid>` (always visible — no expand/collapse
      toggle in this layout; the cards are dense enough that every player
      shows their minions by default).
  - `useRosterExpandedSet` is retained but repurposed to govern the
    description-flip state **per-tile** (keyed by minion id). Because the
    flip is per-tile and not per-player, we may introduce a parallel hook
    `useFlippedTileSet(gameId)`; implementation choice at build time.
  - Rationale: Strategy C's core shape — every player visible at once in a
    compact card.

- [ ] Task 10. Create `<MinionTileGrid>` component rendering
  `.minion-tiles` with one `<MinionTile>` per minion the player is allowed
  to buy (same source data as today's `MinionBuyPanel`).
  - Tile front contents:
    - Top: minion name (truncate, 2 lines max).
    - Bottom: state indicator — `Buy {price}` button (self + affordable +
      unbought), `Call` button (self + bought), `Bought` badge (other
      players + bought), or price-muted text (unaffordable).
  - Tile back: description (4-line clamp) + small accent text.
  - Click flips; click on a button stops propagation.
  - States map to the CSS classes from Task 3 (`state-bought`,
    `state-queued`, `state-unaffordable`).

- [ ] Task 11. Integrate the `[•••]` card menu for GMs:
  - On hover / on-click a popover shows: `[Edit Δ power]` `[Remove player]`
    (ready state) `[View ledger]`. All three trigger inline popovers reusing
    v2's primitives.
  - For non-GMs the `[•••]` is hidden (self: their actions live in the dock).
  - Rationale: removes inline GM-per-player UI clutter; replaced by a
    consolidated overlay (Phase 4) for heavy use.

- [ ] Task 12. Delete the inline GM tools inside the roster row from v2:
  - Remove `<GmPlayerTools>` rendering from inside `<RosterRow>`; the new
    `<RosterCard>` no longer expands GM tools inline.
  - `<GmPlayerTools>`, `<GmEditPowerForm>`, `<GmPlayerLedger>` component
    definitions remain — they are now called from the GM overlay (Phase 4).

### Phase 4 — Left call-queue rail + right standings rail

- [ ] Task 13. Replace the v2 right-rail queue with a **left-rail** version:
  - The body switches from `<div className="game-grid">` to
    `<div className="game-grid-3">` when `game.state === "playing"`.
  - Left pane: `<aside className="game-queue-rail">` — compact queue pills
    from `api.calls.activeCalls`. Each pill has a numbered badge, short
    player name, and short minion name; data-color is derived from the
    syndicate name hash. Empty state: a muted `Queue empty.`
  - Remove per-pill Notes / remove buttons for space; clicking a pill opens
    a small popover with `[Notes]` and `[Remove ✕]` (GM only).
  - Rationale: the queue becomes the gameplay heartbeat on the left edge,
    always in peripheral view.

- [ ] Task 14. Add the **right standings rail**:
  - `<aside className="game-standings-rail">` on ≥1280px, with the existing
    `<PowerStandingsRail>` bar-chart list.
  - Hidden below 1280px (media query in Task 1). On 900–1279px the
    standings still show their numbers in the roster card headers
    (already the case).

### Phase 5 — Unified notes drawer

- [ ] Task 15. New `<NotesDrawer>` component in
  `src/components/NotesDrawer.tsx` (or co-located inside
  `GameDetailPage.tsx` if no reuse outside). Contents:
  - Header: target label (`Game: {name}` / `Syndicate: {name}` /
    `Minion: {name}`) + close `✕`.
  - Body: the existing `Notes` list and compose form currently inside the
    `NoteIcon` popover (extract the shared pieces into a
    `<NotesSurface target={…} />` helper so both the drawer and — for
    now — the Syndicate Editor's existing popover can reuse it).
  - Footer: close button.
- [ ] Task 16. Replace `<NoteIcon>` **inside the game screen only** with a
  thin `<NotesOpener>` button that opens `<NotesDrawer>` pre-targeted to
  the same `target` prop shape. Other callers (Syndicate Editor) keep the
  existing popover.
- [ ] Task 17. Delete `<BottomStrip>` from v2 (its role subsumed by the
  action dock) and remove `.game-bottom-strip` CSS added in v2.

### Phase 6 — GM slide-over overlay

- [ ] Task 18. Add a `[GM]` button to the HUD (visible when
  `viewer.isGm && game.state !== "ready"`). Clicking opens a
  `<GmOverlay>` that is a `<Drawer>` with `wide` modifier.
  - Contents:
    - `.drawer-section` header: `GM Tools`.
    - `.drawer-section` per player (same order as roster), each showing
      inline `<GmEditPowerForm>` + a `<details>` with
      `<GmPlayerLedger>`.
    - Bottom `.drawer-section`: Archive button (mirroring the HUD's
      archive — kept also in the HUD per assumption #6).
  - Rationale: removes the last remnant of GM-per-player UI from the
    baseline layout (Strategy C step 5).

- [ ] Task 19. Wire the overlay state through URL query `?gm=1` (optional
  polish; if scope-squeezed, keep state in React only). Rationale: easier
  deep-linking for GM work during a live game.

### Phase 7 — Health checks + manual verification

- [ ] Task 20. Run `npm run typecheck`; resolve any regressions.
- [ ] Task 21. Run `npm run lint`; address new issues.
- [ ] Task 22. Run `npm test`; ensure existing tests (`convex/notes.test.ts`)
  pass. No new tests mandated — same rationale as v2 Task 23.
- [ ] Task 23. Run `npm run build`; verify production bundle is clean.
- [ ] Task 24. Manual visual verification matrix:
  - **Playing, self, 3 players × 8 minions, 2 calls.** Left queue rail
    shows 2 colored pills; center roster shows 3 cards with 4×2 tile grids;
    right standings rail visible on ≥1280px; action dock at bottom with
    `[Buy {nextPrice} ▾] [Call ▾] [Transfer] [Notes]`. Clicking `[Buy …]`
    always opens the unbought-minion picker (never a one-click buy).
  - **Tile flip.** Clicking a tile's face toggles to description back;
    clicking the button on the back does not flip again (stops
    propagation). Escape on the back flips to front.
  - **Bought + queued states.** A bought minion tile shows green;
    adding it to the queue applies the glow animation.
  - **Unaffordable.** When POWER < price, tile is 45% opaque and
    non-clickable; Buy button hidden.
  - **GM overlay.** `[GM]` opens the slide-over; editing Δ power updates
    the player's standings rail number in real time; close via backdrop
    and Escape.
  - **Notes drawer.** Clicking any `NotesOpener` (tile notes, roster-card
    notes, HUD notes, queue-pill notes, action-dock `[Notes]`) opens the
    same drawer with the correct target.
  - **Narrow viewport (<900px).** Queue rail stacks above roster;
    standings rail hidden; action dock at bottom with `[Buy] [Call] [•••]`;
    `[•••]` opens a bottom sheet with Transfer + Notes.
  - **Medium viewport (900–1279px).** Queue rail left, roster center,
    standings hidden (numbers remain in roster card headers).
  - **Ready state.** Falls back to v2's layout (no queue rail, no
    standings rail, no action dock, no tile grid — uses existing
    `AddPlayerForm` / `SyndicateSelector`).
  - **Archived state.** HUD shows `Game is archived`; tiles show `Bought`
    badges but no Buy/Call buttons; action dock is hidden; GM overlay hides
    Δ power form fields; standings rail visible.

  *Execution note:* as in v2, manual visual verification requires a live
  dev server and Convex state. The `typecheck` / `lint` / `test` / `build`
  gates remain the autonomous pass criteria; the matrix above is the human
  sign-off checklist.

## Verification Criteria

- At ≥1280px viewport during a `playing` game with 3 players × 8 minions,
  the above-the-fold content of a 1080p screen shows: HUD, left queue rail
  with all active calls, all 3 roster cards with full tile grids, right
  standings rail, and the sticky action dock. No scrolling needed to see
  any of these.
- Each roster card renders all 8 of its player's minions as square tiles
  in a 4×2 grid. Tiles flip on click to reveal descriptions.
- The inline GM-per-player tools present in v2 (`GmEditPowerForm`,
  `GmPlayerLedger`) no longer appear inside roster cards; they render only
  inside the GM overlay.
- The `.game-bottom-strip` class is removed from `src/index.css` and no
  `.tsx` file references `<BottomStrip>`.
- The `api.calls.activeCalls` queue is rendered as colored pills in a
  left sticky rail whose width is `--queue-rail-width`.
- POWER standings render as a slim right rail at ≥1280px only; below
  1280px the rail is hidden and each player's POWER remains visible in
  their roster card header.
- Clicking any `NotesOpener` in the game screen opens the new
  `<NotesDrawer>`, not the popover. The Syndicate Editor's `NoteIcon`
  popover is unchanged.
- Clicking the HUD `[GM]` button opens the GM overlay; all per-player Δ
  power forms and ledgers are reachable from inside it.
- The action dock `[Buy {nextPrice} ▾]` button disables when all 8
  minions are bought (`nextPrice === null`) and when viewer POWER <
  `nextPrice`; clicking it (when enabled) always opens the unbought-minion
  picker popover. No one-click-buy path exists.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` all
  pass.

## Potential Risks and Mitigations

1. **Tile grid becomes illegible at the 900px breakpoint (2 roster
   columns × 4 tile columns = 8 tiles across half the viewport).**
   Mitigation: `min-height: 4.25rem` ensures tiles stay tappable; if real
   usage shows them too cramped, drop to 2×4 tiles at that breakpoint via
   a media query on `.minion-tiles`. Flag during Task 24 manual review.

2. **3-pane layout feels claustrophobic at 1280px (rails eat ~22rem of
   the viewport).** Mitigation: the left rail is deliberately narrow
   (`--queue-rail-width: 8rem`) and the right rail hides <1280px. If still
   tight, drop the right-standings rail up to ≥1400px instead.

3. **Tile flip animation causes jank on large grids (24 tiles × 3
   players = 72 transforms).** Mitigation: `will-change: transform` on
   `.minion-tile.flipped` only; transforms are GPU-accelerated. Fall back
   to an instant toggle (`transition: none`) if Chrome DevTools Performance
   shows jank.

4. **Deleting the inline GM tools breaks a GM's muscle memory from v2.**
   Mitigation: add a one-time toast ("GM tools moved — tap `[GM]` in the
   HUD") on first render when the user is GM and `localStorage`
   `gm-moved-toast-seen` is falsy.

5. **Queue pills' derived syndicate colors may clash with theme accents.**
   Mitigation: the 8 preset hues are spread evenly around the color wheel
   and use `hsl(H 50% 45%)` borders so they stay desaturated. If color
   clashes with the dark theme, bump lightness in a separate PR.

6. **`NotesDrawer` extraction causes regressions in note composition.**
   Mitigation: move the current popover body (`<Notes>` + form) into a
   `<NotesSurface>` helper and keep the popover rendering that helper
   inside the drawer AND inside the existing popover (outside the game
   screen). One implementation, two containers.

7. **Action dock covers critical content on short viewports (e.g., a
   laptop at 720p).** Mitigation: `.main-content` already has
   `padding-bottom` scaled with `--bottom-strip-height`. Verify the
   ready-state (no dock) still renders without the excess padding by
   only applying the padding rule when `<ActionDock>` is mounted — can be
   driven by a `.has-dock` class on the `<body>` or `.main-content`.

8. **`GmOverlay` duplicates data between the overlay and the live
   standings rail.** Mitigation: both read from the same Convex queries —
   standings update in real time regardless of which surface drove the
   edit.

9. **Roster cards with long syndicate names overflow.** Mitigation: the
   card header uses `white-space: nowrap; overflow: hidden;
   text-overflow: ellipsis;` on the syndicate name span; hover shows full
   text via `title` attribute.

10. **Mobile action dock `[•••]` overflow sheet collides with the queue
    sheet from v2.** Mitigation: v2's queue sheet is removed (Task 17); on
    mobile the queue rail stacks above the roster, so there is no
    dedicated queue sheet. The `[•••]` sheet is the only bottom sheet.

## Rollout

Strategy C is a **bigger lift than v2**: estimated ~2–3× the surface-area
change of v2. Recommended staged approach:

1. Ship Phase 1 (CSS) + Phase 2 (action dock) behind a feature flag / a
   `?c=1` query param. Existing v2 UI remains for non-flagged users.
2. Ship Phase 3 (tile grid) once Phase 2 is validated.
3. Ship Phases 4–6 together (rails + drawers + GM overlay).
4. Flip the flag on once the manual matrix (Task 24) passes.
5. Delete the v2-only code paths (the `<YouStrip>`, `<BottomStrip>`,
   inline GM-per-player tools) in a follow-up cleanup commit.

If you'd rather land Strategy C in one big-bang commit, skip the flag and
treat Phase 7 as the release gate. Either is acceptable; the phase
ordering is intentionally structured to work under both rollout
strategies.
