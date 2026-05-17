# GM Tools Button & Drawer

## Objective

Introduce a dedicated "GM Tools" entry point in the game HUD that is only visible to the GM. It opens a panel housing rarely‑used GM controls so the top bar stays uncluttered. As a first step, the existing game state transition controls (ready → playing, playing → archived) move from the inline HUD into this panel and gain confirmation prompts. The panel must be structured so additional GM utilities can be added later with minimal churn.

## Current State (for reference)

- `src/pages/GameDetailPage.tsx:236-285` – `GameHud` renders the top header. It already conditionally renders `GmControlsInline` when `viewer.isGm` is true (`src/pages/GameDetailPage.tsx:260-266`).
- `src/pages/GameDetailPage.tsx:300-359` – `GmControlsInline` renders the Start game / Archive buttons and the "Game is archived." text. It owns the `transitionState` mutation call and a local `err` state. **Neither transition currently has a confirmation prompt.**
- `src/pages/GameDetailPage.tsx:589-635` – Existing `Drawer` primitive is already used for the Game Log (`GameLogDrawer`, `src/pages/GameDetailPage.tsx:646-688`); reusing it keeps styling and a11y consistent.
- The state badge (`src/pages/GameDetailPage.tsx:241-251`) and `ElapsedInline` (`src/pages/GameDetailPage.tsx:288-298`) already communicate game state to the GM, so moving the transition buttons off the HUD does not lose at‑a‑glance status.
- Existing precedent for `window.confirm` on destructive actions: `RosterRow.handleRemove` (`src/pages/GameDetailPage.tsx:894-904`).

## Assumptions

- "Top" means the existing `game-hud` header rendered in `GameHud`, not a new global app shell. The repo only navigates within game/games pages and there is no global top bar to extend.
- "GM only" means gated by `viewer.isGm` (the same gate already used by `GmControlsInline`).
- The Start/Archive transition buttons should move _entirely_ into the panel; no duplicate control remains in the HUD.
- The "Game is archived." muted notice currently shown by `GmControlsInline` is informational; the state badge already conveys this in the HUD, so it can move into the drawer where the GM still sees it on opening the panel.
- Reuse the existing right‑side `Drawer` primitive (used by Game Log) rather than introducing a new modal/popover variant. A drawer scales naturally for "more tools will be added there".
- No new Convex mutations or schema changes are needed; only `api.games.transitionState` is reused.
- No new CSS is required; existing `.drawer`, `.stack`, `.row`, `.error-text`, button classes are sufficient.
- Button label: "GM Tools".
- HUD placement of the new button: between the existing GM controls slot and the `NoteIcon`/`Log` cluster, so all GM/utility actions sit together on the right of the HUD.
- **Confirmation copy** (browser `window.confirm` is fine; matches existing `removePlayer` pattern):
  - ready → playing: `"Start the game now? Players will no longer be able to change their Syndicate selection."`
  - playing → archived: `"Archive this game? It will become read-only."`
  - ready → archived: `"Archive this game?"` (still applies because Archive is also exposed from the `ready` state).
- A cancelled confirm dialog must be a true no‑op: no mutation call, no error state set, no toast.

## Implementation Plan

- [ ] Task 1. Add a new `GmToolsButton` (or inline state) inside `GameHud` (`src/pages/GameDetailPage.tsx:214-286`) that:
  - Renders only when `viewerIsGm` is true.
  - Toggles a boolean `gmToolsOpen` piece of state colocated with the existing `logOpen` state in `GameHud` (`src/pages/GameDetailPage.tsx:233`).
  - Uses the same secondary button styling as the existing `Log` button (`src/pages/GameDetailPage.tsx:273-279`) so the HUD reads consistently.
  - Sits between the (now empty) GM slot and the `NoteIcon`, so GM utilities cluster on the right.
  - Rationale: a single boolean + reuse of `Drawer` mirrors the `GameLogDrawer` pattern already proven in this file.

- [ ] Task 2. Create a new `GmToolsDrawer` component, defined alongside `GameLogDrawer` (around `src/pages/GameDetailPage.tsx:637-688`), that:
  - Accepts `gameId`, `gameState`, `rosterSize`, and `onClose` props.
  - Renders a `Drawer` with title "GM Tools" using the existing `Drawer` primitive.
  - Contains a sectioned layout (`<section>` blocks with `<h4>` headings) so future tools each occupy their own section without restructuring. Seed it with one section titled "Game state" that holds the state‑transition controls.
  - Rationale: Sectioned drawer mirrors `GameLogDrawer` (`src/pages/GameDetailPage.tsx:657-687`); future additions are purely additive.

- [ ] Task 3. Move the state‑transition logic out of `GmControlsInline` (`src/pages/GameDetailPage.tsx:300-359`) into a new presentational component (e.g. `GameStateTransitionControls`) rendered inside the "Game state" section of `GmToolsDrawer`. This component:
  - Owns the `useMutation(api.games.transitionState)` call and the local `err` state.
  - Reproduces the existing branching: `ready` → Start game (disabled when `rosterSize === 0`, with the same title hint) + Archive; `playing` → Archive; `archived` → "Game is archived." muted text.
  - **Adds `window.confirm` gating to every transition** before invoking the mutation, with copy per the Assumptions section. Cancelled confirms must early‑return without touching `err`. The pattern mirrors `RosterRow.handleRemove` (`src/pages/GameDetailPage.tsx:894-904`).
  - Disables the triggering button while the mutation is in flight (track a small `busy` boolean) so a user cannot double‑confirm or stack transitions.
  - Rationale: Preserves existing semantics (with one explicit, requested behavioural change — confirmations) so the move is otherwise transparent.

- [ ] Task 4. Remove the inline `GmControlsInline` invocation from `GameHud` (`src/pages/GameDetailPage.tsx:260-266`) and delete the `GmControlsInline` function at `src/pages/GameDetailPage.tsx:300-359`. Verify no other files import it (it is not exported, so this is local cleanup).

- [ ] Task 5. Wire `GmToolsDrawer` into `GameHud`'s render output, mirroring the existing `logOpen` / `GameLogDrawer` pattern (`src/pages/GameDetailPage.tsx:281-283`):
  - Render `<GmToolsDrawer … />` when `viewerIsGm && gmToolsOpen` is true.
  - Pass `gameId`, `gameState`, `rosterSize`, and `onClose={() => setGmToolsOpen(false)}`.
  - Escape‑to‑close and backdrop click are inherited from `Drawer` and require no extra wiring.

- [ ] Task 6. Manual smoke walkthrough (no code change):
  - As a non‑GM viewer, confirm the "GM Tools" button is hidden.
  - As a GM in `ready` state with 0 players, confirm Start game is disabled in the drawer with the existing tooltip; Archive is enabled.
  - As a GM in `ready` with ≥1 player, click Start game → confirm dialog appears; Cancel → no transition, no error; OK → game transitions to `playing` and on next open the drawer shows the `playing` branch.
  - As a GM in `playing`, click Archive → confirm dialog appears; Cancel → no transition; OK → game transitions to `archived`.
  - As a GM in `archived`, confirm only the muted "Game is archived." text appears in the drawer.
  - Confirm the HUD still shows state badge, elapsed timer, GM name, NoteIcon, and Log button.
  - Confirm the in‑flight `busy` state disables the button so a rapid second click cannot fire a second confirm.

## Verification Criteria

- A "GM Tools" button is rendered in the game HUD only when `viewer.isGm` is true; it is absent for players and observers.
- Clicking "GM Tools" opens the drawer with title "GM Tools" and a "Game state" section.
- The Start game / Archive controls (and their disabled/tooltip behaviour, error reporting, and archived‑state text) appear inside the drawer; behaviour matches the previous inline behaviour **except** that every transition now requires the GM to accept a `window.confirm` dialog.
- Cancelling a confirm dialog leaves the game state unchanged, leaves `err` untouched, and does not call `api.games.transitionState`.
- No state‑transition controls remain in the top HUD; the HUD still shows the state badge, GM name, elapsed time (when applicable), NoteIcon, and Log button.
- Closing the drawer via the ✕ button, backdrop click, or Escape key returns to the previous state without errors.
- TypeScript compiles and lint passes; no unused imports or dead code remain (e.g. the deleted `GmControlsInline`).
- The `Drawer`, `transitionState`, and viewer/role contracts are unchanged; no Convex schema edits.

## Potential Risks and Mitigations

1. **Loss of fast access to "Start game" during setup.**
   Mitigation: The button is one click away in the HUD and the drawer is keyboard‑dismissible. If product feedback surfaces friction, consider hoisting _only_ the `ready → playing` action back to the HUD as a primary CTA while keeping Archive in the drawer; follow‑up change.

2. **`window.confirm` is platform‑native and not themable.**
   Mitigation: Acceptable for now — it matches the existing pattern in `RosterRow.handleRemove` (`src/pages/GameDetailPage.tsx:894-904`). If/when the app introduces a custom modal primitive, swap both sites at the same time.

3. **Confirmation fatigue.**
   Mitigation: Confirmations only appear inside the GM Tools drawer, which itself takes one extra click to open, so the GM has already signalled intent. Keep prompts terse and informative (one sentence each).

4. **Drawer height/overflow as more GM tools are added later.**
   Mitigation: The existing `.drawer` already scrolls; sectioning with `<section><h4>` will compose cleanly. Document the section pattern in the new component's leading comment to guide future additions.

5. **Stale prop captures if the drawer stays open across game state changes.**
   Mitigation: Pass `gameState` and `rosterSize` as props from `GameHud`, which re‑renders on `view` query updates from `api.games.getGameView` (`src/pages/GameDetailPage.tsx:55`). Drawer body re‑renders with each new value.

6. **Double‑click race: GM clicks Archive twice while the first transition is in flight.**
   Mitigation: Track a `busy` boolean in `GameStateTransitionControls` and disable the buttons while the mutation runs; the existing `TransferForm` (`src/pages/GameDetailPage.tsx:1428-1521`) follows the same pattern.

7. **Visual regression in the HUD layout after removing inline controls.**
   Mitigation: Keep the existing `<span className="spacer" />` (`src/pages/GameDetailPage.tsx:259`) so the right‑aligned cluster keeps its position; verify visually on desktop and narrow viewports.

## Alternative Approaches

1. **`ActionPopover` instead of `Drawer`.** Trade‑off: popovers fit one or two quick actions (already used for Transfer/Ledger, `src/pages/GameDetailPage.tsx:486-583`) but cramp quickly as more sections are added. Rejected because the task explicitly anticipates more tools later.

2. **Dedicated `/games/:id/admin` route.** Trade‑off: maximally extensible and bookmarkable, but heavyweight for a single section today and forces a context switch away from the live game view. Worth reconsidering only when GM tools grow large enough to warrant a full page.

3. **Inline collapsible "GM Tools" section in the main column.** Trade‑off: keeps everything on one screen but clutters the main column for the GM and competes with Roster/PublicBids/Goals. Rejected because the task asks for a top‑bar entry point.

4. **Custom themed confirmation modal.** Trade‑off: better UX consistency than `window.confirm`, but introduces a new shared primitive and styling work outside the scope of this task. Rejected for v1; revisit when other parts of the app need it.

5. **Reuse the existing `Log` drawer with a tab strip.** Trade‑off: minimises new components but conflates audit/log content with active GM controls; muddies the mental model. Rejected.
