# Game Screen Radical Redesign

## Objective

Radically redesign the Game Detail page (`src/pages/GameDetailPage.tsx`) to be
significantly denser and more purpose-built for live play, saving screen space
above the fold and reducing vertical scroll on every game state. Removing the
current masonry layout is explicitly in scope.

This document is a **design proposal**, not an implementation plan. It catalogs
today's space problems, lays out three incremental design strategies (A → C),
and recommends a combined approach (A + B) as the target design.

## Background — Where screen space currently bleeds

| Area                                            | File:lines                                 | Problem                                                                           |
| ----------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| Page header                                     | `src/pages/GameDetailPage.tsx:27-56`       | Back link, title, GM line each on their own row                                   |
| Elapsed timer                                   | `src/pages/GameDetailPage.tsx:129-141`     | Full-width card, 1.1rem strong text, dedicated row                                |
| GM controls                                     | `src/pages/GameDetailPage.tsx:164-206`     | Separate card, even when only one button is relevant                              |
| Masonry sections                                | `src/index.css:190-221`                    | Column-first order, large 1.5rem gaps, short sections waste space next to long   |
| Roster cards                                    | `src/pages/GameDetailPage.tsx:313-371`     | Every player is an elevated card with `1rem 1.25rem` padding + nested minion list |
| Minion rows                                     | `src/pages/GameDetailPage.tsx:850-921`     | Each minion is its own card with description, skills, and actions stacked         |
| Call queue                                      | `src/pages/GameDetailPage.tsx:950-992`     | Each call is a card with 3 lines (player/minion/time/remove)                      |
| POWER + ledger + transfer + GM ledger           | `src/pages/GameDetailPage.tsx:467-511`     | Four stacked cards, always visible when you're the GM                             |
| GM Tools                                        | `src/pages/GameDetailPage.tsx:530-656`     | Duplicates roster — a second list of every player with expand toggles             |
| Global card padding                             | `src/index.css:156-162`                    | `1rem 1.25rem` + `1rem` margin on every card, including tiny ones                 |

## Strategy A — Compaction pass (low risk, ~35% shorter)

Keeps today's structure, tightens every element.

1. **Header collapses to one sticky bar.** A single row at the top, sticky
   under the nav:
   `← Games   Game Name  [state pill]  GM: Jane · you   00:12:34   [Start] [Archive]   [Notes 3]`
   Kill `ElapsedDisplay`'s card (`src/pages/GameDetailPage.tsx:129-141`), fold
   into the title row, and merge `GmControls` (`src/pages/GameDetailPage.tsx:164-206`)
   inline. Saves ~160–200px vertically.

2. **Replace minion cards with list rows.** One line per minion:
   `Dr. Null — charming · [lockpick] [sneak] [charm]              [Notes] [Buy 3]`
   Description goes in a `title=` tooltip or an on-demand expand caret. Kill
   the per-minion card padding entirely; use a `.row-divider` pattern (1px
   border-bottom + 0.35rem padding). Typical roster with 8 minions × 3 players
   drops from ~1400px to ~700px.

3. **Call queue → numbered list rows.** Collapse
   `src/pages/GameDetailPage.tsx:955-991` into:
   `1. Alice → Dr. Null  · 12:34  ✕`
   No cards. 3 lines becomes 1.

4. **Fold GM per-player tools into roster rows.** Delete `GmLedgerPanel` /
   `GmPlayerRow` (`src/pages/GameDetailPage.tsx:530-581`) and reuse the roster
   row — when a GM expands a player they see the ledger + `GmEditPowerForm`
   inline. The second copy of every player disappears.

5. **Kill card-in-card.** Anywhere a `.card` is nested inside another `.card`
   (ledger table, minion list inside roster), use a borderless variant or just
   a divider. Introduce `.card.tight { padding: 0.5rem 0.75rem; margin-bottom:
   0.5rem }` and use it for list-row cards.

6. **Inline labels for tiny inputs.** `GmEditPowerForm`
   (`src/pages/GameDetailPage.tsx:616-644`) and `TransferForm`
   (`src/pages/GameDetailPage.tsx:757-799`) waste a row per `<label>`. Use
   placeholder + `aria-label`, or a prefix span (`Δ ± int`). Saves 40–80px per
   form.

## Strategy B — Purpose-built 2-pane layout (removes masonry)

Replace `.section-masonry` (`src/index.css:190-221`) with a layout that
matches what people *do* on a game screen.

```
┌──────────────────────────────── sticky HUD ────────────────────────────────┐
│ ← Games  Game Name [playing]  GM Jane  00:12:34  [Start] [Archive]  [Notes]│
├─────────────────────────── your-context strip ─────────────────────────────┤
│ You: Alice · Syndicate Crimson (Leader Vex) · POWER 12  [Transfer] [Ledger]│
├────────────────────────────── main 2-pane ─────────────────────────────────┤
│                                              │                             │
│   ROSTER (primary, ~65% width)               │  RIGHT RAIL (~35%, sticky)  │
│   ──────────                                 │  ───────────                │
│   ▸ Alice · Crimson · 12⟡   [•••]            │  CALL QUEUE                 │
│     (expanded: minion grid w/ Buy/Call)      │   1. Alice→Null · 12:34 ✕   │
│   ▸ Bob   · Azure   ·  8⟡   [•••]            │   2. Bob  →Rook · 12:40 ✕   │
│   ▸ Carla · Verde   ·  5⟡   [•••]            │                             │
│                                              │  POWER STANDINGS            │
│                                              │   Alice ████████ 12         │
│                                              │   Bob   █████    8          │
│                                              │   Carla ███      5          │
│                                              │                             │
│                                              │  [+ recent transfers]       │
└──────────────────────────────────────────────┴─────────────────────────────┘
```

Concretely:

- **New top HUD** (sticky, single row): absorbs title + state + GM + elapsed +
  GM controls + game-level notes icon. Replaces
  `src/pages/GameDetailPage.tsx:25-68`.
- **"You" strip** (only when `viewer.playerId`): shows your syndicate, your
  POWER, quick [Transfer] button opening a popover (kills the inline
  `TransferForm` card), and [Ledger] toggle. Power and transfer no longer need
  a dedicated column.
- **Left: Roster** becomes the main scroller. Each row is a single line; click
  expands inline `MinionBuyPanel`. Your own row is expanded by default.
- **Right rail** (sticky, `position: sticky; top: HUD_height`): Call queue up
  top (where you glance most often) + Power standings as a compact horizontal
  bar-chart list (already have the numbers — just a `<div>` with a width %).
  Ledger moves into an on-demand drawer.
- **Layout change in CSS**: replace `.section-masonry` with
  `.game-grid { display: grid; grid-template-columns: minmax(0,1fr) 22rem;
  gap: 1.25rem }` and stack on narrow screens.
- **Ready-state** reuses the same grid but swaps right rail for
  `AddPlayerForm` (GM) or `SyndicateSelector` (player).

Net effect: above-the-fold now shows HUD + your context + 3–4 roster rows +
queue + standings. Today you scroll past the GM-controls card and the elapsed
card before seeing anything actionable.

## Strategy C — "Command deck" (most radical)

Go full HUD / dashboard. Treat the game screen like a live game UI, not a
page of sections.

1. **Sticky HUD (top)** as above.
2. **Sticky action dock (bottom)** for the current player:
   `[Buy next minion — 5⟡]   [Call ▾]   [Transfer ▾]   [Notes]`
   All of `MinionBuyPanel`'s "Buy" CTA and `TransferForm` become one-click
   dock actions; forms open as popovers. Saves the entire right column on
   mobile.
3. **Center: Roster grid.** 2–4 players per row at wide viewports, laid out
   as compact cards with a portrait-style header (name, syndicate, POWER) and
   a **dense 4×2 minion grid** of square tiles (icon + name + price/Buy).
   Tiles turn green when bought, glow when in the queue. ~60% more info per
   screen than the current vertical roster.
4. **Left: Call queue rail** (narrow, sticky). Queue is the heartbeat of
   gameplay — it deserves a permanent slot. Numbered pills, colored by player
   syndicate.
5. **GM overlay, not a panel.** Put a single `[GM]` button in the HUD that
   opens a slide-over with: per-player Δ power, per-player ledger, archive.
   Nothing GM-only occupies baseline screen space.
6. **Notes become a slide-out drawer** instead of a popover, so the same UI
   serves game/syndicate/minion notes without re-positioning.

This is a bigger rewrite but is the one that actually treats the game screen
as the product's hero UI.

## CSS changes this enables

- Delete `.section-masonry` block (`src/index.css:190-221`) — no longer
  needed.
- Add `.card.tight`, `.card.flush` (no margin-bottom), `.row-divider` for
  list-row patterns.
- Introduce `--hud-height`, `--rail-width` vars so sticky offsets compose.
- Tighten default `.card` padding (`src/index.css:156-162`) to `0.75rem 1rem`
  and `0.75rem` margin — a single-file change that visibly compresses the
  whole app.

## Recommended target design

Do **Strategy A + B** together in one pass:

1. Rip out `.section-masonry`.
2. Build the sticky HUD + "You" context strip.
3. Split the body into `roster | right-rail (queue + standings)` grid.
4. Rewrite roster rows and minion rows as single-line list items with inline
   expand.
5. Fold GM-per-player tools into the roster expand.
6. Collapse transfer into a popover launched from the HUD / context strip.

That's a cohesive redesign, meaningfully denser (estimated 40–55% shorter for
a 3-player game at `playing` state), and doesn't depend on new assets or
libraries. Strategy C is a natural follow-up once the 2-pane is in place.

## Open questions to resolve before implementation

1. Should roster rows default to collapsed (show only name/syndicate/POWER)
   or expanded (show minions) when the viewer is **not** the player in that
   row? Collapsed is more compact; expanded is more information-dense for GMs
   who need to see everyone's minions.
2. Is the right rail a true sticky sidebar (desktop-only) with full collapse
   to a stacked layout under 900px, or does it become a bottom-anchored
   "summary strip" on mobile?
3. Where does the "recently removed calls" history live under the new
   design? Suggested: a small toggle at the bottom of the Call Queue rail.
4. Do we keep the per-game notes icon in the HUD, or fold it into the "You"
   strip alongside player-specific notes?
5. Does the Syndicate Editor (`src/pages/SyndicateEditorPage.tsx`) adopt the
   same compaction pass (Strategy A only) for consistency, or stay on the
   existing layout?
