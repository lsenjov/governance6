# Game Screen "Command Deck" — Strategy C Implementation Plan (revised)

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
primitives, and drawer component already in place. See the v2 primitives
currently live at:

- `.game-hud` / `.game-you-strip` / `.game-grid` / `.game-rail` at `src/index.css:235-344`.
- `<Drawer>` primitive at `src/pages/GameDetailPage.tsx:559-605`.
- `<ActionPopover>` primitive at `src/pages/GameDetailPage.tsx:456-553`.
- `<MinionBuyPanel>` at `src/pages/GameDetailPage.tsx:867-1008`.
- `<RosterList>` / `<RosterRow>` at `src/pages/GameDetailPage.tsx:654-861`.
- `<BottomStrip>` at `src/pages/GameDetailPage.tsx:1551-1615`.

## Changelog vs v3

Applied review feedback from the v3 review. Concrete changes:

1. **Task 5 cross-reference fixed** — `.game-bottom-strip` deletion now
   correctly attributed to Task 17 (was "Task 15" in v3).
2. **`.main-content` padding promoted from risk to explicit task** — new
   Task 5b introduces a `.has-dock` class on `<body>` so the dock does not
   cover the last row at _any_ viewport width.
3. **Queue-pill syndicate color data-flow spelled out** — Task 13 now
   specifies the client-side join (`roster.find(…).selectedSyndicate.name`),
   grounded in `convex/games.ts:88-94` (syndicate is frozen during
   `playing`).
4. **`useRosterExpandedSet` repurposing dropped** — Task 9 unambiguously
   adds a new `useFlippedTileSet(gameId)` hook modelled on the existing
   `useRosterExpandedSet` (`src/hooks/useRosterExpandedSet.ts`), keyed by
   `MinionId`.
5. **Ready-state rendering branch made explicit** — Task 9 now spells out
   that `ready` state renders the v2 `<RosterList>` while `playing` /
   `archived` render the new `<RosterCardGrid>`.
6. **Tile-click vs Buy-button semantics clarified** — assumption #9 and
   Task 10 reworded: the Buy button on the front performs the buy; the
   bare face area flips.
7. **Rollout disambiguated** — chose the _big-bang_ path; Tasks 8 and 17
   delete v2 code in-phase; rollout step 5 removed.
8. **Syndicate-color hash function specified** — assumption #10 now
   defines the hash.
9. **HUD crowding mitigated** — Task 8 moves viewer POWER _out_ of the
   HUD (stays only in the dock `.summary`); HUD metadata limited to
   `{yourName} · {syndicate}`.
10. **GM overlay archived-state behaviour specified** — Task 18 notes
    that `<GmEditPowerForm>` is hidden in `archived`; ledger remains.
11. **Task 17 moved to Phase 2** — the bottom-strip deletion lives next
    to the dock that subsumes it, not in the notes-drawer phase.
12. **Queue pill `data-color` hues enumerated** — all 8 hues spelled out
    in Task 4 (no `…` ellipsis).
13. **Verification criteria tightened** — ≥1280px / 3-player expectation
    rewritten to require "≥2 roster cards visible above the fold"
    instead of "all 3" (3 cards at 2-col grid wrap the third to a
    second row).

## Assumptions (defaults baked in — confirm before execution)

Strategy C introduces several UX decisions that were deliberately deferred
from v2. Defaults are listed below; flag any you want to change before I
start implementation.

| #   | Decision                                                                   | Default                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Does the action dock replace v2's mobile bottom-summary strip, or coexist? | **Replace** — one unified `.action-dock` at the bottom that adapts (mobile: queue summary + `[Buy]` `[Call]` `[•••]`; desktop: full dock). v2's `<BottomStrip>` is deleted in Task 17.                                                                                                        |
| 2   | Does `[Buy]` in the dock one-click-buy, or open a picker?                  | **Always a picker.** All unbought minions cost the same `nextPrice` (the ladder in `convex/minionBuys.ts:14` is based on `boughtCount`, not per-minion), so there is no "cheapest" shortcut. The dock button is labelled `[Buy {nextPrice} ▾]` and opens the unbought-minion picker on click. |
| 3   | Tile grid breakpoints within each roster card                              | **Fixed 4×2** at all widths; tiles flex to match card width.                                                                                                                                                                                                                                  |
| 4   | Roster-card column count                                                   | **1** <900px, **2** 900–1399px, **3** 1400–1799px, **4** ≥1800px.                                                                                                                                                                                                                             |
| 5   | Where do POWER standings live once the left rail holds the queue?          | **New slim right rail** — 3-pane layout on ≥1280px (queue · roster · standings); right rail collapses into roster headers on 900–1279px; everything stacks <900px.                                                                                                                            |
| 6   | GM slide-over scope                                                        | Δ power form + per-player ledger only. Archive/start buttons **stay in the HUD**.                                                                                                                                                                                                             |
| 7   | Notes drawer replaces `NoteIcon` popover **only inside the game screen**   | Yes — other pages (Syndicate Editor, etc.) keep the existing popover.                                                                                                                                                                                                                         |
| 8   | Minion description visibility in tile grid                                 | **Tooltip (`title=`) + on-tap flip** — tap the bare face of a tile (not a button) to reveal description on the back; tap the back to flip forward. Buy/Call live on the front. (Fallback: hover reveal on desktop via the `title` attribute.)                                                 |
| 9   | Tile Buy-button behaviour when unbought + affordable + self                | **Buy immediately** (no confirm); error toast on failure. The Buy button lives on the front face; clicking the button fires `buyMinion` with `stopPropagation` so the flip does not also trigger.                                                                                             |
| 10  | Syndicate color mapping for queue pills                                    | Hash of syndicate name → one of 8 preset hues; deterministic across sessions. No schema changes. **Hash spec:** `Array.from(name).reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 0) % 8`.                                                                                               |

## Implementation Plan

### Phase 1 — Layout primitives (CSS)

- [ ] Task 1. Introduce 3-pane shell variables and classes in `src/index.css`:
  - Add `:root` vars: `--queue-rail-width: 8rem;` and
    `--standings-rail-width: 14rem;` (`--rail-width` from v2 stays for any
    external callers).
  - New class `.game-grid-3 { display: grid; grid-template-columns: var(--queue-rail-width) minmax(0, 1fr) var(--standings-rail-width); gap: 1rem; align-items: start; }`.
  - Media-query overrides:
    - `@media (max-width: 1279px) { .game-grid-3 { grid-template-columns: var(--queue-rail-width) minmax(0, 1fr); } .game-standings-rail { display: none; } }`
    - `@media (max-width: 899px) { .game-grid-3 { grid-template-columns: 1fr; } .game-queue-rail { position: static; } }`
  - Rationale: keeps v2's `.game-grid` (`src/index.css:279-319`) for the
    ready-state fallback while the "playing" state switches to the 3-pane
    shell.

- [ ] Task 2. Roster grid (inside the center pane) in `src/index.css`:
  - `.roster-cards { display: grid; grid-template-columns: 1fr; gap: 0.75rem; }`
  - `@media (min-width: 900px) { .roster-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }`
  - `@media (min-width: 1400px) { .roster-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); } }`
  - `@media (min-width: 1800px) { .roster-cards { grid-template-columns: repeat(4, minmax(0, 1fr)); } }`
  - `.roster-card { padding: 0.75rem; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-elevated); display: flex; flex-direction: column; gap: 0.5rem; }`
  - `.roster-card.self { border-color: var(--accent); }`
  - `.roster-card-header { display: flex; align-items: center; gap: 0.5rem; min-width: 0; }`
  - `.roster-card-header .syndicate { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }`
  - Rationale: implements assumption #4 and mitigates risk #9 (long syndicate names).

- [ ] Task 3. Minion tile grid in `src/index.css`:
  - `.minion-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0.35rem; perspective: 600px; }`
  - `.minion-tile { position: relative; aspect-ratio: 1 / 1; min-height: 4.25rem; transform-style: preserve-3d; transition: transform 180ms ease; cursor: pointer; }`
  - `.minion-tile.flipped { transform: rotateY(180deg); will-change: transform; }`
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
  - `.queue-pill { display: flex; align-items: center; gap: 0.35rem; padding: 0.35rem 0.4rem; border-radius: 999px; font-size: 0.72rem; line-height: 1; background: var(--bg-elevated); border: 1px solid var(--border); cursor: pointer; }`
  - `.queue-pill .num { font-weight: 700; font-size: 0.68rem; background: var(--accent); color: var(--bg); border-radius: 999px; padding: 0.1rem 0.35rem; min-width: 1.1rem; text-align: center; }`
  - Preset hues (8 slots, spaced around the wheel):
    - `.queue-pill[data-color="0"] { --pill-hue: 210; }` /_ blue _/
    - `.queue-pill[data-color="1"] { --pill-hue: 30; }` /_ orange _/
    - `.queue-pill[data-color="2"] { --pill-hue: 150; }` /_ green _/
    - `.queue-pill[data-color="3"] { --pill-hue: 270; }` /_ purple _/
    - `.queue-pill[data-color="4"] { --pill-hue: 90; }` /_ chartreuse _/
    - `.queue-pill[data-color="5"] { --pill-hue: 330; }` /_ magenta _/
    - `.queue-pill[data-color="6"] { --pill-hue: 60; }` /_ yellow _/
    - `.queue-pill[data-color="7"] { --pill-hue: 180; }` /_ teal _/
  - `.queue-pill { border-color: hsl(var(--pill-hue, 210) 50% 45%); }`
  - Rationale: implements assumption #10 with concrete, enumerated hues.

- [ ] Task 5. Bottom action dock in `src/index.css`:
  - `.action-dock { position: fixed; left: 0; right: 0; bottom: 0; z-index: 30; display: flex; gap: 0.5rem; padding: 0.5rem 0.75rem; background: var(--bg-elevated); border-top: 1px solid var(--border); min-height: var(--bottom-strip-height); align-items: center; }`
  - `.action-dock .summary { margin-right: auto; font-size: 0.85rem; }`
  - `.action-dock button { padding: 0.4rem 0.75rem; }`
  - `@media (max-width: 899px) { .action-dock .dock-desktop-only { display: none; } }`
  - Rationale: merges v2's `.game-bottom-strip` into a single dock
    (assumption #1). Deletion of `.game-bottom-strip` CSS and
    `<BottomStrip>` component is handled in **Task 17**.

- [ ] Task 5b. Promote dock bottom-padding from v2's narrow-screen rule to
      all widths, scoped behind a toggle class:
  - Move the `padding-bottom: calc(1.5rem + var(--bottom-strip-height))` rule
    currently nested inside `@media (max-width: 899px)` (`src/index.css:341-343`)
    out of that media query. Re-scope it to `body.has-dock .main-content`:
    ```
    body.has-dock .main-content {
      padding-bottom: calc(1.5rem + var(--bottom-strip-height));
    }
    ```
  - The existing narrow-only bottom-strip block (`src/index.css:321-344`) can
    be removed in Task 17 along with `.game-bottom-strip` itself.
  - In `GameDetailPage.tsx`, add/remove `has-dock` on `<body>` from a
    `useEffect` whenever `<ActionDock>` is mounted (i.e., whenever
    `showDock` is true — see Task 7 for the gating predicate). Cleanup on
    unmount.
  - Rationale: the v3 dock is visible on **all** widths (not just mobile
    like v2's `<BottomStrip>`), so the bottom padding must apply on all
    widths. Gating behind `body.has-dock` ensures ready-state and archived
    pages don't waste bottom padding.

- [ ] Task 6. Slide-over overlay class in `src/index.css`:
  - Add a wide variant of v2's `.drawer`: `.drawer.wide { width: min(40rem, 100vw); }`.
  - Add a `.drawer-section { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); }` helper for the GM overlay's player list and the notes drawer.
  - `.drawer-section:last-child { border-bottom: none; }`.
  - Rationale: the GM overlay and the notes drawer both benefit from a
    uniform section divider; reuses the existing drawer at
    `src/pages/GameDetailPage.tsx:559-605`.

### Phase 2 — Bottom action dock (replaces v2 `<YouStrip>` + `<BottomStrip>`)

- [ ] Task 7. Create `<ActionDock>` component in
      `src/pages/GameDetailPage.tsx`. Rendered at the root of the game shell
      (as the last child of `.game-shell`, after the grid).
  - **Gating predicate:** `showDock = viewer.playerId !== null && game.state === "playing"`.
  - `myPower` is threaded in from `GameDetailPage` (use the existing
    `indexBalances(balances, roster)` map at `src/pages/GameDetailPage.tsx:166-178`
    so the dock does not re-query).
  - Left (`.summary`): `POWER <strong>{myPower}</strong> · Queue <strong>{activeCount}</strong>`.
    This is the **single** surface for viewer POWER (not duplicated in the
    HUD — see Task 8).
  - Buttons (desktop order): `[Buy {nextPrice} ▾]` `[Call ▾]`
    `<span className="dock-desktop-only">[Transfer]</span>`
    `<span className="dock-desktop-only">[Notes]</span>`.
  - Mobile (<900px): Transfer + Notes hide via `.dock-desktop-only`; add a
    `[•••]` button that opens a bottom-sheet (reuse `<Drawer bottom>` at
    `src/pages/GameDetailPage.tsx:583`) containing Transfer + Notes triggers.
  - Wire `[Buy {nextPrice} ▾]` to open an `<ActionPopover>` listing the
    viewer's **unbought** minions, sourced from
    `api.minionBuys.listForPlayer({ gameId, playerId: viewer.playerId })`.
    Clicking one invokes `api.minionBuys.buyMinion`. Popover header shows
    the single global `nextPrice` once (since
    `MINION_PRICES[boughtCount]` at `convex/minionBuys.ts:14,58` is
    per-buy not per-minion). Button disabled when `nextPrice === null`
    (all 8 bought) OR when `myPower < nextPrice`.
  - Wire `[Call ▾]` to an `<ActionPopover>` listing the viewer's **bought**
    minions; clicking one invokes `api.calls.addOrReplaceCall`.
  - `[Transfer]` re-uses `<ActionPopover>` + the existing `<TransferForm>`
    (`src/pages/GameDetailPage.tsx:1258-1351`).
  - `[Notes]` opens `<NotesDrawer>` from Phase 5 pre-loaded with
    `target={{ kind: "game" }}` (the game-level target).

- [ ] Task 8. Collapse the v2 "You" strip into the HUD + action dock:
  - Delete the `<YouStrip>` component definition and its render site
    (`src/pages/GameDetailPage.tsx:86-94, 335-377`). Delete the associated
    `.game-you-strip` CSS (`src/index.css:264-277`) — it's only used by
    `YouStrip`.
  - Update `<GameHud>` (`src/pages/GameDetailPage.tsx:184-256`) to render
    viewer identity as inline metadata: `{yourName} · {syndicate or "No Syndicate"}`.
    **POWER is NOT in the HUD** — it lives only in the dock `.summary` to
    avoid triple-duplication (dock / HUD / standings rail).
  - Replace the `[Ledger]` button that previously lived in `<YouStrip>`
    with a HUD `[Ledger]` button (popover identical to v2's
    `<LedgerButton>` at `src/pages/GameDetailPage.tsx:416-450`).
  - Transfer moves to the action dock (Task 7).
  - Rationale: "You" strip was a transitional UI in v2; Strategy C
    obviates it by promoting dock + HUD. Keeping POWER single-sourced
    prevents the 3-surface redundancy flagged in review.

### Phase 3 — Roster-as-grid + minion tile grid

- [ ] Task 9. Conditional roster rendering based on game state:
  - In `<GameDetailPage>`, branch roster rendering:
    - `game.state === "ready"` → render the v2 `<RosterList>` as-is
      (`src/pages/GameDetailPage.tsx:654-698`). Ready state has no
      minions yet; the v2 row-divider layout remains correct.
    - `game.state === "playing" | "archived"` → render a new
      `<RosterCardGrid>` component.
  - `<RosterCardGrid>` renders `<div className="roster-cards">` with a
    `<RosterCard>` per player.
  - `<RosterCard>` replaces v2's `<RosterRow>` body for playing/archived:
    - `.roster-card.self` when `player._id === viewer.playerId`.
    - Header row (`.roster-card-header`): portrait dot (hue derived from
      syndicate name via the hash in assumption #10; muted gray if no
      syndicate), `{displayName}{you?}`, `{syndicate.name}` (truncated),
      right `<strong>{POWER}</strong>⟡`, GM-only `[•••]` menu.
    - Body: `<MinionTileGrid player={p} />` (always rendered when
      `player.selectedSyndicateId !== null` — which is guaranteed for
      playing/archived games because syndicate selection is locked to
      `ready` per `convex/games.ts:88-94`).
  - Add new hook `useFlippedTileSet(gameId)` in
    `src/hooks/useFlippedTileSet.ts`, modelled on
    `src/hooks/useRosterExpandedSet.ts`:
    - Keyed by `MinionId`.
    - `localStorage` key: `game:{gameId}:flippedTiles` → JSON array.
    - API: `{ isFlipped(minionId), toggle(minionId) }`.
    - Tolerates missing/invalid JSON; filters stale ids against the live
      minion set on render.
    - **Do not repurpose `useRosterExpandedSet`** — it stays keyed by
      `PlayerId` for its existing callers in the ready-state roster.
  - Rationale: Strategy C's core shape (every player visible at once in a
    compact card) applies only during play; ready-state retains its
    simpler list.

- [ ] Task 10. Create `<MinionTileGrid>` component rendering
      `.minion-tiles` with one `<MinionTile>` per minion of the player's
      selected syndicate (same source data as today's `MinionBuyPanel` —
      `api.minionBuys.listForPlayer` at `convex/minionBuys.ts:94-173`).
  - Tile front contents:
    - Top: minion name (2-line clamp, `title={m.description}`).
    - Bottom: one of:
      - `<button>Buy {price}</button>` when `gameState === "playing" && data.isSelf && !m.bought && nextPrice !== null && myPower >= nextPrice`. Button handler calls `api.minionBuys.buyMinion` with `stopPropagation` so the tile flip does not also fire (assumption #9).
      - `<button>Call</button>` when `gameState === "playing" && data.isSelf && m.bought`. Button handler calls `api.calls.addOrReplaceCall` with `stopPropagation`.
      - `<span className="badge">Bought</span>` when `m.bought && !data.isSelf` (other players, or archived state).
      - Muted `{price}` text when unaffordable (adds `state-unaffordable` class, `cursor: not-allowed`, button hidden).
  - Tile back: description (4-line clamp) + small accent text.
  - State classes wired from Task 3:
    - `.state-bought` when `m.bought`.
    - `.state-queued` when an active call exists for this `(playerId, minionId)` pair (read from `api.calls.activeCalls`, client-joined).
    - `.state-unaffordable` when self + unbought + `myPower < nextPrice`.
  - **Flip semantics (resolves v3 ambiguity):**
    - Clicking the **bare face** (not a button) toggles `useFlippedTileSet`.
    - Clicking the **Buy / Call button** performs the action and calls
      `event.stopPropagation()`; the flip does NOT fire.
    - Back face has a small `←` button that un-flips.
    - Tiles in `state-unaffordable` are fully non-interactive (no flip,
      no buy).

- [ ] Task 11. Integrate the `[•••]` card menu for GMs:
  - On the `<RosterCard>` header (GM viewer only, any game state that
    isn't `ready`), a `[•••]` button opens an `<ActionPopover>` with:
    `[Edit Δ power]` `[View ledger]` (playing), `[View ledger]` only
    (archived). These trigger inline popovers reusing v2's
    `<GmEditPowerForm>` and `<GmPlayerLedger>` primitives
    (`src/pages/GameDetailPage.tsx:1029-1104`).
  - For non-GMs the `[•••]` button is hidden (self: actions live in the dock).
  - Remove Player is GM + ready only — in ready state we render v2's
    `<RosterList>` (Task 9 branch), which already has the Remove button
    at `src/pages/GameDetailPage.tsx:824-833`. Do not duplicate it on the
    card.

- [ ] Task 12. Remove the v2 inline GM tools from the playing-state roster:
  - In the v2 `<RosterRow>`, `showGmTools` currently renders
    `<GmPlayerTools>` inline when expanded (`src/pages/GameDetailPage.tsx:738,847-858`).
    Since playing/archived states no longer use `<RosterRow>` (Task 9
    branch routes them to `<RosterCard>`), the inline GM tools are
    unreachable for those states — and that's correct: GM edits happen
    via the Phase 6 overlay or the `[•••]` popover.
  - Keep `<GmPlayerTools>`, `<GmEditPowerForm>`, `<GmPlayerLedger>`
    component definitions (`src/pages/GameDetailPage.tsx:1014-1104`) —
    they are now called from the `[•••]` popover (Task 11) and the GM
    overlay (Task 18).

### Phase 4 — Left call-queue rail + right standings rail

- [ ] Task 13. Replace the v2 right-rail queue with a **left-rail** version:
  - In `<GameDetailPage>`, when `game.state === "playing"`, swap the
    wrapper from `<div className="game-grid">` to
    `<div className="game-grid-3">`. Ready state continues to use
    `.game-grid single-column` (`src/index.css:279-288`, `src/pages/GameDetailPage.tsx:96`).
  - Left pane: `<aside className="game-queue-rail">` — compact queue
    pills from `api.calls.activeCalls`
    (`convex/calls.ts:97-138`).
  - **Syndicate color derivation (client-side join):** `activeCalls`
    currently returns only `playerId, minionId, createdAt, playerName,
minionName` (`convex/calls.ts:122-136`) — no syndicate. Derive the
    hue per pill as:
    `ts
    const syndicateName =
      roster.find((p) => p._id === call.playerId)?.selectedSyndicate?.name ??
      "";
    const colorSlot = syndicateName
      ? Array.from(syndicateName).reduce(
          (h, c) => (h * 31 + c.charCodeAt(0)) >>> 0,
          0,
        ) % 8
      : 0;
    `
    Apply as `data-color={colorSlot}`. This is safe because
    `selectSyndicate` only fires during `ready` (`convex/games.ts:88-94`,
    Rule 13) — so during `playing` the syndicate per player is frozen and
    the client join is stable. **No schema changes; no query changes.**
  - Each pill renders: numbered badge (`<span className="num">{idx + 1}</span>`),
    short player name, `→`, short minion name. Empty state: a muted
    `Queue empty.` message.
  - Clicking a pill opens a small `<ActionPopover>` with `[Notes]`
    (opens `<NotesDrawer>` for the minion target) and `[Remove ✕]`
    (GM only; calls `api.calls.removeCall`).
  - Rationale: queue becomes the gameplay heartbeat on the left edge.

- [ ] Task 14. Add the **right standings rail**:
  - `<aside className="game-standings-rail">` on ≥1280px, wrapping the
    existing `<PowerStandingsRail>`
    (`src/pages/GameDetailPage.tsx:1189-1252`).
  - Hidden below 1280px by the media query in Task 1. On 900–1279px the
    standings numbers remain visible in each roster card header (Task 9).
  - On <900px the rail is hidden and standings are still in card headers;
    users who want the bar chart can open the GM overlay (if GM) or —
    for non-GMs — we accept this as a mobile scope cut (standings numbers
    remain in card headers).

### Phase 5 — Unified notes drawer

- [ ] Task 15. Extract the existing notes body into a reusable
      `<NotesSurface target={…} gameId={…} label={…} />` helper:
  - Currently the form + list live inside `<NotesPopover>` at
    `src/components/NoteIcon.tsx:81-317`. Move the inner pieces (header
    - list + compose form, but not the popover positioning/backdrop
      logic) into a new `src/components/NotesSurface.tsx`.
  - `<NotesPopover>` continues to render `<NotesSurface>` inside its
    absolute-positioned popover (preserves Syndicate Editor behaviour
    per assumption #7).
  - `<NotesDrawer>` (new, same file or `src/components/NotesDrawer.tsx`)
    renders `<NotesSurface>` inside the existing `<Drawer>` primitive
    (`src/pages/GameDetailPage.tsx:559-605`).
  - Rationale: single implementation, two containers. Mitigates review
    risk of notes regressions.

- [ ] Task 16. Inside the game screen only, replace `<NoteIcon>` with a
      `<NotesOpener target={…} count={…} label={…} />` button that opens
      `<NotesDrawer>` pre-targeted to the same target shape. Call sites
      to update (all in `src/pages/GameDetailPage.tsx`):
  - HUD game-level notes (line ~237).
  - Roster card syndicate notes (Task 9 `<RosterCard>` header).
  - Minion tile notes (optional: expose a small notes icon on the tile
    back; or surface it via the `[•••]` card menu — pick one in
    implementation).
  - Queue pill popover `[Notes]` button (Task 13).
  - Action dock `[Notes]` button (Task 7).
  - **Do NOT replace `<NoteIcon>` in the Syndicate Editor** — it keeps
    the existing popover.

- [ ] Task 17. Delete the v2 `<BottomStrip>` component and CSS:
  - Remove `<BottomStrip>` definition and render site
    (`src/pages/GameDetailPage.tsx:154-161, 1551-1615`).
  - Remove `.game-bottom-strip` CSS and the
    `@media (max-width: 899px) { .main-content { padding-bottom: … } }`
    rule (`src/index.css:321-344`) — the dock padding now lives in the
    `body.has-dock .main-content` rule added in Task 5b.
  - The mobile `[•••]` sheet from Task 7 is now the only bottom-anchored
    sheet (mitigates risk #10 from v3).

### Phase 6 — GM slide-over overlay

- [ ] Task 18. Add a `[GM]` button to the HUD, visible when
      `viewer.isGm && game.state !== "ready"`. Clicking opens a
      `<GmOverlay>` — a `<Drawer>` with `wide` modifier (Task 6).
  - Contents:
    - `.drawer-section` header: `<h4>GM Tools</h4>`.
    - `.drawer-section` per player (same order as roster). For each:
      - Player header row: `{displayName} · {syndicate} · {POWER}⟡`.
      - When `game.state === "playing"`: inline `<GmEditPowerForm>`
        (`src/pages/GameDetailPage.tsx:1029-1092`).
      - When `game.state === "archived"`: **do not render
        `<GmEditPowerForm>`** (power edits are frozen once archived per
        the existing mutation-level checks). Show a muted `Game archived.`
        note instead.
      - `<details><summary>Ledger</summary><GmPlayerLedger .../></details>`
        (lazy-load via the `useQuery` already inside
        `<GmPlayerLedger>` at `src/pages/GameDetailPage.tsx:1094-1104`;
        `<details>` open state is enough to mount/unmount).
    - Bottom `.drawer-section`: Archive button (mirrors the HUD's
      archive per assumption #6).
  - Rationale: removes the last remnant of GM-per-player UI from the
    baseline layout.

- [ ] Task 19. (Optional polish; skip if scope-squeezed.) Wire the GM
      overlay open state through URL query `?gm=1`. Use `useSearchParams`
      from `react-router-dom`. Rationale: easier deep-linking for GM work
      during a live game.

### Phase 7 — Health checks + manual verification

- [ ] Task 20. Run `npm run typecheck`; resolve any regressions.
- [ ] Task 21. Run `npm run lint`; address new issues.
- [ ] Task 22. Run `npm test`; ensure existing tests
      (`convex/notes.test.ts`) pass. No new tests mandated — same rationale
      as v2 Task 23 (project has no React Testing Library / jsdom setup;
      adding one is out of scope).
- [ ] Task 23. Run `npm run build`; verify production bundle is clean.
- [ ] Task 24. Manual visual verification matrix:
  - **Playing, self, 3 players × 8 minions, 2 calls.** Left queue rail
    shows 2 colored pills (colors match syndicate hash); center roster
    shows 3 cards with 4×2 tile grids; right standings rail visible on
    ≥1280px; action dock at bottom with
    `[Buy {nextPrice} ▾] [Call ▾] [Transfer] [Notes]`. Clicking
    `[Buy …]` opens the unbought-minion picker (never a one-click buy).
  - **Tile flip.** Clicking a tile's bare face toggles to description
    back; clicking a Buy/Call button does NOT flip. Back's `←` button
    flips to front.
  - **Bought + queued states.** A bought minion tile shows green;
    adding it to the queue applies the pulse animation.
  - **Unaffordable.** When POWER < price, tile is 45% opaque,
    `cursor: not-allowed`; Buy button hidden and the bare face is
    non-interactive.
  - **GM overlay.** `[GM]` opens the slide-over; editing Δ power updates
    the player's standings rail number in real time; close via backdrop
    and Escape. In `archived`, the Δ power form is absent per Task 18.
  - **Notes drawer.** Clicking any `<NotesOpener>` (HUD, roster-card
    header, queue-pill popover, action-dock `[Notes]`) opens the same
    drawer with the correct target; the Syndicate Editor's `<NoteIcon>`
    popover is unchanged.
  - **Narrow viewport (<900px).** Queue rail stacks above roster;
    standings rail hidden; action dock at bottom with `[Buy] [Call] [•••]`;
    `[•••]` opens a bottom sheet with Transfer + Notes.
  - **Medium viewport (900–1279px).** Queue rail left, roster center (2
    columns), standings hidden (numbers remain in roster card headers).
  - **Wide viewport (≥1400px).** 3-pane layout visible; roster is 3
    columns (1400–1799px) or 4 columns (≥1800px). Dock padding
    (`body.has-dock`) keeps last card row visible above the dock.
  - **Ready state.** Falls back to v2's layout (v2 `<RosterList>`, no
    queue rail, no standings rail, no action dock, no tile grid — uses
    existing `AddPlayerForm` / `SyndicateSelector`). `body.has-dock`
    class is NOT applied (dock is unmounted, effect removes it).
  - **Archived state.** HUD shows archived state; tiles show `Bought`
    badges but no Buy/Call buttons; action dock is hidden (dock gated on
    `playing` per Task 7); GM overlay Δ-power section hidden per Task 18;
    standings rail visible at ≥1280px.

  _Execution note:_ as in v2, manual visual verification requires a live
  dev server and Convex state. The `typecheck` / `lint` / `test` /
  `build` gates remain the autonomous pass criteria; the matrix above is
  the human sign-off checklist.

## Verification Criteria

- At ≥1280px viewport during a `playing` game with 3 players × 8 minions,
  the above-the-fold content of a 1080p screen shows: HUD, left queue rail
  with all active calls, **at least 2 roster cards** with full tile grids
  (3 cards at 2-column = third wraps to second row — not a single-fold
  row), right standings rail, and the sticky action dock. No scrolling
  needed to see any of these.
- Each roster card renders all 8 of its player's minions as square tiles
  in a 4×2 grid. Tiles flip on bare-face click to reveal descriptions.
- The Buy button on a tile fires `buyMinion` **without** also flipping
  the tile.
- The inline GM-per-player tools present in v2 (`<GmEditPowerForm>`,
  `<GmPlayerLedger>`) do not appear inside roster cards during
  playing/archived; they render only inside the GM overlay (Task 18) or
  the `[•••]` card popover (Task 11).
- `<BottomStrip>` component and `.game-bottom-strip` CSS are removed; no
  `.tsx` file references `<BottomStrip>`.
- `<YouStrip>` component and `.game-you-strip` CSS are removed.
- Viewer POWER is visible only in the action dock `.summary` — not in the
  HUD and not duplicated elsewhere for the current viewer.
- The `api.calls.activeCalls` queue is rendered as colored pills in a
  left sticky rail whose width is `--queue-rail-width`, with colors
  derived from the client-side syndicate-name hash specified in
  assumption #10.
- POWER standings render as a slim right rail at ≥1280px only; below
  1280px the rail is hidden and each player's POWER remains visible in
  their roster card header.
- Clicking any `<NotesOpener>` in the game screen opens `<NotesDrawer>`,
  not the popover. The Syndicate Editor's `<NoteIcon>` popover is
  unchanged.
- Clicking the HUD `[GM]` button opens the GM overlay; all per-player Δ
  power forms (playing only) and ledgers are reachable from inside it.
- The action dock `[Buy {nextPrice} ▾]` button disables when all 8
  minions are bought (`nextPrice === null`) and when viewer POWER <
  `nextPrice`; clicking it (when enabled) always opens the
  unbought-minion picker popover. No one-click-buy path exists.
- `body.has-dock` class is present on `<body>` exactly when
  `<ActionDock>` is mounted; `.main-content` bottom padding applies at
  all widths when the dock is visible.
- `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` all
  pass.

## Potential Risks and Mitigations

1. **Tile grid becomes illegible at the 900px breakpoint (2 roster
   columns × 4 tile columns = 8 tiles across half the viewport).**
   Mitigation: `min-height: 4.25rem` keeps tiles tappable; if real usage
   shows them too cramped, drop to 2×4 tiles at that breakpoint via a
   media query on `.minion-tiles`. Flag during Task 24 manual review.

2. **3-pane layout feels claustrophobic at 1280px (rails eat ~22rem of
   the viewport).** Mitigation: the left rail is deliberately narrow
   (`--queue-rail-width: 8rem`) and the right rail hides <1280px. If
   still tight, bump the right-rail threshold to ≥1400px in a follow-up.

3. **Tile flip animation causes jank on large grids (24 tiles × 3
   players = 72 transforms).** Mitigation: `will-change: transform` only
   on `.minion-tile.flipped` (Task 3) so GPU allocation is per-flipped
   tile, not global. Fall back to `transition: none` if Chrome DevTools
   Performance shows jank.

4. **Deleting the inline GM tools breaks a GM's muscle memory from v2.**
   Mitigation: add a one-time toast ("GM tools moved — tap `[GM]` in the
   HUD") on first render when the user is GM and `localStorage`
   `gm-moved-toast-seen` is falsy.

5. **Queue pills' derived syndicate colors may clash with theme accents.**
   Mitigation: the 8 preset hues (Task 4) are spread evenly around the
   color wheel and use `hsl(H 50% 45%)` borders so they stay desaturated.
   If clashes arise with the dark theme, bump lightness in a separate PR.

6. **`<NotesSurface>` extraction causes regressions in note composition.**
   Mitigation: Task 15 preserves the popover render path by leaving
   `<NotesPopover>` calling `<NotesSurface>`; same component, two
   containers. Covered by Task 22 (`convex/notes.test.ts` already
   exercises the mutations).

7. **Action dock covers critical content on short viewports (e.g., a
   laptop at 720p).** Mitigation: Task 5b's `body.has-dock` class scopes
   `padding-bottom: calc(1.5rem + var(--bottom-strip-height))` to pages
   where the dock is mounted (replaces v2's mobile-only rule).

8. **`<GmOverlay>` duplicates data between the overlay and the live
   standings rail.** Mitigation: both read from the same Convex queries —
   standings update in real time regardless of which surface drove the
   edit.

9. **Roster cards with long syndicate names overflow.** Mitigation: Task
   2 adds `white-space: nowrap; overflow: hidden; text-overflow: ellipsis`
   to `.roster-card-header .syndicate`; hover shows full text via `title`
   attribute.

10. **`activeCalls` does not include syndicate data, so the client-side
    join for queue-pill color could mismatch.** Mitigation: client-side
    join is safe because `selectSyndicate` is a ready-state-only mutation
    (`convex/games.ts:88-94`, Rule 13), so per-player syndicate is
    frozen during `playing`. If a player is removed mid-game (GM action
    in `ready` — not possible in `playing`), their calls no longer
    exist. No race condition.

11. **HUD overflow on narrow viewports with long game / GM / viewer
    names.** Mitigation: `.game-hud` already uses `flex-wrap: wrap`
    (`src/index.css:247-253`). Task 8 drops POWER from the HUD, freeing
    horizontal space vs. v3's original design. If still tight, truncate
    the syndicate span with `ellipsis`.

12. **`useFlippedTileSet` unbounded storage growth (minion ids
    accumulate across games).** Mitigation: the hook (modelled on
    `useRosterExpandedSet`) filters stale ids against the live minion
    set on every render and writes the cleaned set back — same pattern
    as `src/hooks/useRosterExpandedSet.ts:44-54`.

## Rollout

**Single big-bang commit, gated by Phase 7.** No feature flag — Strategy
C replaces v2 UI surfaces in-phase:

1. Phases 1–6 land on one branch.
2. Phase 7 (typecheck / lint / test / build + manual matrix) is the
   release gate.
3. v2 `<YouStrip>` and `<BottomStrip>` deletions happen in Tasks 8 and
   17 respectively — **not** a follow-up cleanup commit.

Rationale (per review): straddling flagged + in-phase deletion in v3 was
ambiguous. Picking one path (in-phase deletion) keeps the diff
self-contained.

If the scope turns out too large for one branch, a safe split is:
Phases 1–2 first (primitives + dock; old roster/rail intact), then
Phases 3–6 (roster + rails + drawers + GM overlay). Each split still
passes Phase 7 gates at the time of merge.
