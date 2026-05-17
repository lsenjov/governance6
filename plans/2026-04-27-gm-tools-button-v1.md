# GM Tools Button & Drawer

## Objective

Introduce a dedicated "GM Tools" entry point in the game HUD that is only visible to the GM. It opens a panel housing rarely‑used GM controls so the top bar stays uncluttered. As a first step, the existing game state transition controls (ready → playing, playing → archived) move from the inline HUD into this panel. The panel must be structured so additional GM utilities can be added later with minimal churn.

## Current State (for reference)

- `src/pages/GameDetailPage.tsx:236-285` – `GameHud` renders the top header. It already conditionally renders `GmControlsInline` when `viewer.isGm` is true (`src/pages/GameDetailPage.tsx:260-266`).
- `src/pages/GameDetailPage.tsx:300-359` – `GmControlsInline` renders the Start game / Archive buttons and the "Game is archived." text. It owns the `transitionState` mutation call and a local `err` state.
- `src/pages/GameDetailPage.tsx:589-635` – Existing `Drawer` primitive is already used for the Game Log (`GameLogDrawer`, `src/pages/GameDetailPage.tsx:646-688`); reusing it keeps styling and a11y consistent.
- The state badge (`src/pages/GameDetailPage.tsx:241-251`) and `ElapsedInline` (`src/pages/GameDetailPage.tsx:288-298`) already communicate game state to the GM, so moving the transition buttons off the HUD does not lose at‑a‑glance status.

## Assumptions

- "Top" means the existing `game-hud` header rendered in `GameHud`, not a new global app shell. The repo only navigates within game/games pages and there is no global top bar to extend.
- "GM only" means gated by `viewer.isGm` (the same gate already used by `GmControlsInline`).
- The Start/Archive transition buttons should move _entirely_ into the panel; no duplicate control remains in the HUD. This honours "Move … into it".
- The "Game is archived." muted notice currently shown by `GmControlsInline` is informational; the state badge already conveys this, so it can be dropped from the HUD when the inline controls leave. It is acceptable to surface it inside the drawer instead so the GM still sees it when they open the panel.
- Reuse the existing right‑side `Drawer` primitive (used by Game Log) rather than introducing a new modal/popover variant. A drawer scales naturally for "more tools will be added there".
- No new Convex mutations or schema changes are needed; only `api.games.transitionState` is reused.
- No new CSS is required; existing `.drawer`, `.stack`, `.row`, `.error-text`, button classes are sufficient. (Optional polish noted under risks.)
- Button label: "GM Tools" (with space) for readability; the title attribute / aria‑label can use the same.
- Placement of the new button in the HUD: between the existing GM controls slot and the `NoteIcon`/`Log` cluster, so all GM/utility actions sit together on the right of the HUD.

## Implementation Plan

- [ ] Task 1. Add a new `GmToolsButton` (or inline state) inside `GameHud` (`src/pages/GameDetailPage.tsx:214-286`) that:
  - Renders only when `viewerIsGm` is true.
  - Toggles a boolean `gmToolsOpen` piece of state colocated with the existing `logOpen` state in `GameHud` (`src/pages/GameDetailPage.tsx:233`).
  - Uses the same secondary button styling as the existing `Log` button (`src/pages/GameDetailPage.tsx:273-279`) so the HUD reads consistently.
  - Sits between the (now empty/simplified) GM slot and the `NoteIcon`, so GM utilities cluster on the right.
  - Rationale: a single boolean + reuse of `Drawer` mirrors the `GameLogDrawer` pattern already proven in this file, keeping the change minimal and the architecture uniform.

- [ ] Task 2. Create a new `GmToolsDrawer` component, defined alongside `GameLogDrawer` (around `src/pages/GameDetailPage.tsx:637-688`), that:
  - Accepts `gameId`, `gameState`, `rosterSize`, and `onClose` props (mirroring the inputs `GmControlsInline` currently consumes plus `onClose`).
  - Renders a `Drawer` with title "GM Tools" using the existing `Drawer` primitive.
  - Contains a sectioned layout (e.g. `<section>` blocks with `<h4>` headings) so future tools can each occupy their own section without restructuring. Seed it with one section titled "Game state" that holds the state‑transition controls.
  - Rationale: Sectioned drawer mirrors the structure already used by `GameLogDrawer` (`src/pages/GameDetailPage.tsx:657-687`); makes future additions purely additive.

- [ ] Task 3. Move the state‑transition logic out of `GmControlsInline` (`src/pages/GameDetailPage.tsx:300-359`) into a new presentational component (e.g. `GameStateTransitionControls`) rendered inside the "Game state" section of `GmToolsDrawer`. This component:
  - Owns the `useMutation(api.games.transitionState)` call and the local `err` state.
  - Reproduces the existing branching: `ready` → Start game (disabled when `rosterSize === 0`, with the same title hint) + Archive; `playing` → Archive; `archived` → "Game is archived." muted text.
  - Optionally wraps the Archive action in a `window.confirm` (Archive is currently a no‑confirm destructive action; flagged as optional since the original behaviour is no‑confirm and the task says "move", not "change").
  - Rationale: Preserves all existing semantics so behaviour is unchanged; only the _location_ of the controls moves.

- [ ] Task 4. Remove the inline `GmControlsInline` invocation from `GameHud` (`src/pages/GameDetailPage.tsx:260-266`) and delete (or fully replace) the `GmControlsInline` function at `src/pages/GameDetailPage.tsx:300-359` if it has no remaining callers. Verify no other files import it (it is not exported, so this is local cleanup).

- [ ] Task 5. Wire `GmToolsDrawer` into `GameHud`'s render output, mirroring the existing `logOpen` / `GameLogDrawer` pattern (`src/pages/GameDetailPage.tsx:281-283`):
  - Render `<GmToolsDrawer … />` when `viewerIsGm && gmToolsOpen` is true.
  - Pass `gameId`, `gameState`, `rosterSize`, and `onClose={() => setGmToolsOpen(false)}`.
  - Ensure escape‑to‑close and backdrop click already handled by `Drawer` continue to work (no extra wiring needed).

- [ ] Task 6. Manual smoke walkthrough (no code change):
  - As a non‑GM viewer, confirm the new button is hidden.
  - As a GM in `ready` state with 0 players, confirm Start game is disabled in the drawer with the existing tooltip; Archive remains enabled.
  - As a GM in `ready` state with ≥1 player, confirm Start game transitions to `playing` and the drawer reflects the new state branch on next open.
  - As a GM in `playing` state, confirm only Archive is shown.
  - As a GM in `archived` state, confirm the muted "Game is archived." text appears inside the drawer.
  - Confirm the HUD still shows state badge, elapsed timer, GM name, NoteIcon, and Log button.

- [ ] Task 7. (Optional, only if existing styling looks awkward.) Add a thin spacing rule for stacked sections in `src/index.css` near the existing drawer styles (`src/index.css:803-838`). Skip if the existing `.stack` / `<section>` defaults look correct.

## Verification Criteria

- A "GM Tools" button is rendered in the game HUD only when `viewer.isGm` is true; it is absent for players and observers.
- Clicking "GM Tools" opens the existing drawer primitive with the title "GM Tools" and a "Game state" section.
- The Start game / Archive controls (and their disabled/tooltip behaviour, error reporting, and archived‑state text) appear inside the drawer and behave identically to the previous inline behaviour.
- No state transition controls remain in the top HUD; the HUD still shows the state badge, GM name, elapsed time (when applicable), NoteIcon, and Log button.
- Closing the drawer via the ✕ button, backdrop click, or Escape key returns to the previous state without errors.
- TypeScript compiles (`tsc --noEmit`/build) and lint passes; no unused imports or dead code remain (e.g. the deleted `GmControlsInline`).
- The `Drawer`, `transitionState`, and viewer/role contracts are unchanged; no Convex schema edits.

## Potential Risks and Mitigations

1. **Loss of fast access to "Start game" during setup.**
   Mitigation: The button is one click away in the HUD and the drawer is keyboard‑dismissible. If product feedback surfaces friction, consider hoisting _only_ the `ready → playing` action back to the HUD as a primary CTA while keeping Archive in the drawer; this is a follow‑up change, not part of v1.

2. **Accidental archive becomes easier to click in a dedicated panel.**
   Mitigation: Optionally guard Archive with `window.confirm("Archive this game?")` inside `GameStateTransitionControls`. Out of scope for the literal "move" but recommended.

3. **Drawer height/overflow as more GM tools are added later.**
   Mitigation: The existing `.drawer` already scrolls; sectioning with `<section><h4>` will compose cleanly. No work needed now, but document the section pattern in the new component's leading comment to guide future additions.

4. **Stale prop captures if the drawer stays open across game state changes.**
   Mitigation: Pass `gameState` and `rosterSize` as props from `GameHud`, which already re‑renders on `view` query updates from `api.games.getGameView` (`src/pages/GameDetailPage.tsx:55`). The drawer body will re‑render with each new value, so branch logic stays correct.

5. **Visual regression in the HUD layout after removing inline controls.**
   Mitigation: Leave the existing `<span className="spacer" />` (`src/pages/GameDetailPage.tsx:259`) in place so the right‑aligned cluster keeps its position; verify visually on desktop and the narrow‑viewport bottom strip layout (which does not include these controls).

## Alternative Approaches

1. **`ActionPopover` instead of `Drawer`.** Trade‑off: popovers are great for one or two quick actions (already used for Transfer/Ledger, `src/pages/GameDetailPage.tsx:486-583`) but cramp quickly as more sections are added. Rejected because the task explicitly anticipates more tools later.

2. **Dedicated `/games/:id/admin` route.** Trade‑off: maximally extensible and bookmarkable, but heavyweight for a single section today and forces a context switch away from the live game view. Worth reconsidering only when GM tools grow large enough to warrant a full page.

3. **Inline collapsible "GM Tools" section in the main column.** Trade‑off: keeps everything on one screen but clutters the main game column for the GM and competes with Roster/PublicBids/Goals. Rejected because the task asks for a top‑bar entry point.

4. **Reuse the existing `Log` drawer with a tab strip.** Trade‑off: minimises new components but conflates audit/log content with active GM controls; muddies the mental model. Rejected.
