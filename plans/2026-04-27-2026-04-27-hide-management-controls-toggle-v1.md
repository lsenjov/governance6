# GM Tools — "Hide management controls" toggle

## Objective

Add a GM-only toggle in the **GM Tools** drawer that, when enabled, hides the per-row destructive/edit affordances on the **Treason Grants** and **Goals** sections of the Game Detail page. Specifically, when the toggle is on:

- **Treason Grant rows** (`src/pages/GameDetailPage.tsx:2229-2307`): hide the **Edit**, **Clear owner**, and **Delete** buttons.
- **Goal rows** (`src/pages/GameDetailPage.tsx:3293-3391`): hide the **Edit** and **Delete** buttons.

All other affordances — Take (player-facing), Assign from… / Assign to… (GM-facing assignment), `+ New Grant`, `+ New Goal`, the editor/assigner forms themselves — remain unaffected.

## Naming Decision

- Toggle label: **"Hide management controls"**.
- Internal identifier: `hideManagementControls`.
- Rationale: "Hide owner" / "Hide edit" each describe only one of the three buttons; the affected buttons are uniformly GM management actions on existing rows, so a collective name is clearer. See alternatives in the response that produced this plan.

## Current State (for reference)

- `src/pages/GameDetailPage.tsx:233-296` — `GameHud` owns `gmToolsOpen` state and renders `GmToolsDrawer` for the GM.
- `src/pages/GameDetailPage.tsx:319-342` — `GmToolsDrawer` is sectioned (`<section>` per tool); currently has only a "Game state" section, comment notes additions are purely additive.
- `src/pages/GameDetailPage.tsx:2156-2333` — `TreasonGrantRow` renders Edit / Clear owner / Delete inside a `writable && (<>…</>)` block at `src/pages/GameDetailPage.tsx:2273-2305`. The `editing` form is rendered separately at `src/pages/GameDetailPage.tsx:2309-2317`.
- `src/pages/GameDetailPage.tsx:3250-3432` — `GoalRowView` renders Assign-from / Assign-to / Edit / Delete in the same right-hand action cluster at `src/pages/GameDetailPage.tsx:3347-3391`. Edit and Delete are individually gated by `goal.canEdit` / `goal.canDelete` (server-derived).
- `src/hooks/useRosterExpandedSet.ts:1-102` — Established pattern for per-game UI prefs persisted to `localStorage` under a `game:{gameId}:…` key, with safe parse and write.
- No existing global app-state context for GM UI preferences; state lives where it's used (e.g. `gmToolsOpen` in `GameHud`).

## Assumptions

- **Scope of "hide" is exactly the three buttons named** in the user's request: `Edit`, `Clear owner`, `Delete` on Treason Grants; `Edit`, `Delete` on Goals. The `Assign from…` / `Assign to…` buttons on Goals (`src/pages/GameDetailPage.tsx:3348-3367`) are *not* hidden — they are not destructive and were not named.
- **Create forms stay visible** — `+ New Grant` (`src/pages/GameDetailPage.tsx:2093-2100`) and `+ New Goal` (`src/pages/GameDetailPage.tsx:3117-3125`) are left unaffected; the toggle only hides per-row management actions, not authoring entry points. Rationale: the user described the toggle as hiding row-level buttons, and authoring is conceptually different.
- **In-progress editors stay visible** — if a GM has clicked Edit and is mid-edit when they enable the toggle, the editor form (`GrantEditor` / `GoalEditor`) continues rendering until the GM saves or cancels. Hiding the row's "Edit/Cancel" toggle button while a form is open would orphan the form. Rationale: graceful, non-destructive UX; no data loss; matches "least surprise".
- **Toggle is GM-only** — the toggle UI lives inside the existing `GmToolsDrawer`, which itself is only rendered when `viewer.isGm`. Non-GMs never see the affected buttons in the first place (`writable` / `goal.canEdit` / `goal.canDelete` are all server-gated to GMs).
- **Persistence per-game in `localStorage`** under key `game:{gameId}:hideManagementControls`, mirroring `useRosterExpandedSet` (`src/hooks/useRosterExpandedSet.ts:24`). Default is **off** (controls visible). A GM who wants the safer "hidden" mode opts in once per game; the choice survives reload but does not leak across games. Storage failures (private mode, quota) silently degrade to "off" for that session.
- **No Convex schema changes, no new mutations.** This is a purely client-side display preference.
- **Section placement in drawer**: a new section titled "Display" sits below the existing "Game state" section, so future display preferences (e.g. show/hide other panels, tighten density, etc.) accumulate there. The section comment in `GmToolsDrawer` already notes additions are purely additive (`src/pages/GameDetailPage.tsx:311-317`).
- **Toggle control**: a checkbox + label inside the "Display" section, matching the lightweight visual language already used in forms across the file. No new CSS.
- **Drawer state ephemerality**: the drawer's `gmToolsOpen` boolean stays ephemeral as today; only the toggle's *value* persists. Closing the drawer does not change the toggle.

## Implementation Plan

- [ ] Task 1. Add a new hook `useHideManagementControls(gameId)` in a new file `src/hooks/useHideManagementControls.ts` that:
  - Reads/writes `localStorage` under `game:{gameId}:hideManagementControls` (boolean, JSON-encoded).
  - Returns `[hideManagementControls, setHideManagementControls]` (or `{ value, setValue }`), defaulting to `false` when storage is empty/invalid/unavailable.
  - Mirrors the safe-parse / try-catch / SSR-guard pattern from `useRosterExpandedSet` (`src/hooks/useRosterExpandedSet.ts:84-101`).
  - Resyncs when `gameId` changes (effect on `storageKey`), again mirroring `useRosterExpandedSet` (`src/hooks/useRosterExpandedSet.ts:33-39`).
  - Rationale: keeps presentation prefs local and discoverable; reuses an established storage convention so cleanup, debugging, and future migration are uniform.

- [ ] Task 2. Thread the preference into `GameDetailPage` so the relevant sections can read it:
  - In `GameDetailPage` (`src/pages/GameDetailPage.tsx:52-194`), call `useHideManagementControls(gid)` once for the GM viewer (and unconditionally when `gid` is defined; the value is harmless for non-GMs because they never render the gated buttons). Default `false`.
  - Pass the `hideManagementControls` boolean down to `TreasonGrantsSection` and `GoalsSection` as a new prop. Pass the *setter* down to `GameHud` so `GmToolsDrawer` can flip it.
  - Rationale: a single source of truth at the page level avoids duplicate hook calls (and duplicate storage writes) inside two sibling sections, and matches how `viewer`/`gameState` are already threaded.

- [ ] Task 3. Surface the toggle inside `GmToolsDrawer` (`src/pages/GameDetailPage.tsx:319-342`):
  - Add a second `<section>` titled "Display" (heading `<h4>` matching the existing "Game state" heading style at `src/pages/GameDetailPage.tsx:333`).
  - Inside it, render a labelled checkbox: `Hide management controls`.
  - Help text underneath in the existing `.muted` style: "Hides Edit, Clear owner, and Delete on Treason Grants and Goals. The toggle is remembered for this game."
  - Wire `checked` and `onChange` to the `hideManagementControls` value/setter passed in via props.
  - Rationale: sectioned drawer was specifically designed to grow this way (`src/pages/GameDetailPage.tsx:312-317`); no structural churn.

- [ ] Task 4. Update `TreasonGrantsSection` (`src/pages/GameDetailPage.tsx:1995-2050`) to accept and forward `hideManagementControls` to each `TreasonGrantRow`. In `TreasonGrantRow` (`src/pages/GameDetailPage.tsx:2156-2333`):
  - Compute `showRowManagement = writable && !hideManagementControls`.
  - Wrap the `<>` containing the **Edit**, **Clear owner**, and **Delete** buttons (`src/pages/GameDetailPage.tsx:2274-2304`) in `showRowManagement && (<>…</>)` instead of the current `writable && (<>…</>)`.
  - Leave the `editing && writable && <GrantEditor … />` block (`src/pages/GameDetailPage.tsx:2309-2317`) ungated by the new flag — see Assumption "in-progress editors stay visible".
  - The **Take** button (`src/pages/GameDetailPage.tsx:2263-2272`) is *not* affected.
  - Rationale: minimum-surface change; `writable` already gates exactly the right cluster, so the new flag composes cleanly.

- [ ] Task 5. Update `GoalsSection` (`src/pages/GameDetailPage.tsx:2978-3037`) to accept and forward `hideManagementControls` to each `GoalRowView`. In `GoalRowView` (`src/pages/GameDetailPage.tsx:3250-3432`):
  - Wrap the **Edit** button (`src/pages/GameDetailPage.tsx:3368-3378`) so it renders only when `goal.canEdit && !hideManagementControls`.
  - Wrap the **Delete** button (`src/pages/GameDetailPage.tsx:3379-3389`) so it renders only when `goal.canDelete && !hideManagementControls`.
  - Leave **Assign from…** / **Assign to…** buttons (`src/pages/GameDetailPage.tsx:3348-3367`) and any open `GoalEditor` / `AssignFromPlayerForm` / `AssignToPlayerForm` blocks untouched (see Assumptions).
  - Rationale: gates only the two named buttons; non-destructive assignment workflow continues to function while the GM is "presenting".

- [ ] Task 6. Audit the rest of the Treason Grants and Goals row UI to ensure no orphaned trailing whitespace, separators, or layout artefacts when the buttons disappear:
  - The action cluster is wrapped in `<span className="row-wrap" style={{ gap: "0.4rem" }}>` (Treason: `src/pages/GameDetailPage.tsx:2262-2306`; Goals: `src/pages/GameDetailPage.tsx:3347-3390`). With `gap` based layout, removing children leaves no stray separators. Verify visually that an *empty* action cluster (e.g. a Goal row where the only management buttons were Edit/Delete and both are now hidden) does not introduce odd spacing on the right edge.
  - If an empty cluster is visually awkward, conditionally avoid rendering the `<span>` when it would have no children. Treat this as a polish step, not a blocker.

- [ ] Task 7. Type and lint hygiene:
  - Add the new prop to the prop type of every component touched (`TreasonGrantsSection`, `TreasonGrantRow`, `GoalsSection`, `GoalRowView`, `GmToolsDrawer`, `GameHud`).
  - Ensure no TypeScript "unused" or "missing" prop warnings; all props are explicitly typed in this file.
  - Run `tsc` / `eslint` parity with the existing CI (`eslint.config.js`, `tsconfig.json`).

- [ ] Task 8. Manual smoke walkthrough (no code change):
  - As a non-GM, verify nothing about the page changes; the toggle is invisible (drawer is GM-only) and the affected rows still render only player-visible affordances.
  - As a GM in `playing` state with at least one owned grant, an unowned grant, and a goal whose row has Edit + Delete:
    - Open GM Tools → "Display" section is visible with the new toggle, default unchecked.
    - All three buttons appear on the owned grant row; Edit + Delete appear on the unowned grant row; Edit + Delete appear on the goal row. (Baseline.)
    - Tick the toggle → the rows immediately re-render without **Edit / Clear owner / Delete** on grants and without **Edit / Delete** on goals. **Take** still appears on takeable grants; **Assign from… / Assign to…** still appear on goals; `+ New Grant` / `+ New Goal` still appear above the lists.
    - Reload the page → toggle remains ticked; rows remain stripped.
    - Untick → controls return.
  - Edge case: open Edit on a grant or goal, *then* tick the toggle → the existing editor form remains; the row's "Cancel" affordance (rendered as the Edit button switching label) is hidden; saving via the editor's own Save/Cancel still works.
  - Edge case: open in two browser tabs of the same game; verify the toggle in one does not leak into the other instantly (acceptable: `localStorage` is per-tab read on mount; explicit re-syncing across tabs is out of scope).
  - Switch to a different game → toggle starts unticked (per-game key) regardless of the other game's value.

## Verification Criteria

- A "Display" section is rendered inside the GM Tools drawer for the GM viewer with a labelled checkbox titled "Hide management controls" and a brief muted help line.
- When the toggle is **off** (default), the Treason Grants and Goals sections behave exactly as today.
- When the toggle is **on**:
  - In Treason Grant rows, the **Edit**, **Clear owner**, and **Delete** buttons are not rendered.
  - In Goal rows, the **Edit** and **Delete** buttons are not rendered.
  - All other buttons (Take; Assign from…; Assign to…; `+ New Grant`; `+ New Goal`; closing controls inside any open editor) continue to render and function.
  - In-progress editor / assigner forms that were already open continue to render.
- The toggle's state persists per-game across reload via `localStorage` under `game:{gameId}:hideManagementControls`. Two distinct games maintain independent values. Storage failures degrade silently to "off" for that session.
- No Convex schema, query, or mutation changes; no new server logic.
- TypeScript compiles, ESLint passes, no unused imports, no console warnings.
- Non-GM viewers see no behavioural change: their UI does not depend on the toggle and the toggle UI itself is unreachable for them.

## Potential Risks and Mitigations

1. **Empty action cluster spacing.**
   When all management buttons are hidden, a row's right-hand `<span className="row-wrap">` may render empty and produce subtle spacing/alignment glitches.
   Mitigation: conditionally elide the empty cluster when it would have no children, or rely on `gap` semantics where empty flex containers contribute no gap. Verify visually (Task 6).

2. **GM accidentally hides controls and forgets how to restore them.**
   Mitigation: the toggle lives in the GM Tools drawer the GM already uses for state transitions; help text under the checkbox names exactly which sections are affected so the GM can find and revert it.

3. **Mid-edit confusion when toggling.**
   If the GM is editing a row and toggles the flag on, the row's Edit button (now labelled Cancel) disappears — but the form's own Save/Cancel still works. There is no data loss.
   Mitigation: explicitly leave open editors visible (Task 4 / Task 5) and document this in the toggle's help text only if user testing surfaces confusion; otherwise the in-form Save/Cancel is sufficient.

4. **Storage drift / orphan keys.**
   `localStorage` keys for archived/deleted games persist forever.
   Mitigation: matches the existing convention for `useRosterExpandedSet` keys (`src/hooks/useRosterExpandedSet.ts:24`); accept the small footprint. A future "clear stale game prefs" sweep can address both at once.

5. **Two-tab divergence.**
   Same game open in two tabs: toggling in one does not propagate to the other until reload.
   Mitigation: out of scope for this change; document as accepted limitation. If needed later, add a `storage` event listener inside the hook.

6. **Future buttons added to grants/goals are not gated.**
   Future contributors may add a new destructive button without consulting this toggle.
   Mitigation: name the gating constant clearly (`showRowManagement` / `hideManagementControls`) and add a brief inline comment near each gated cluster pointing future maintainers at the toggle. Centralise the predicate via a single derived boolean per row.

7. **Hook collision with GameDetail re-renders.**
   The `useQuery` re-renders on every Convex push; ensure the hook's effect dependencies do not cause spurious storage writes.
   Mitigation: only write to storage in the setter (event-driven), not in render-derived effects — same shape as `useRosterExpandedSet.toggle` (`src/hooks/useRosterExpandedSet.ts:64-79`).

## Alternative Approaches

1. **Per-section toggles (one for grants, one for goals).** Trade-off: more granular but doubles the UI surface and the storage keys. Rejected: the user described one combined behaviour and the two sections share the same intent (presentation safety / declutter).

2. **Server-side / per-user setting on the `users` table.** Trade-off: would sync across devices but requires a schema migration and a new mutation, and the preference is inherently per-game per-display anyway. Rejected: too heavyweight for a presentation flag.

3. **Ephemeral state (no persistence).** Trade-off: simplest possible implementation. Rejected: a GM who reloads mid-game would re-encounter the controls they explicitly chose to hide; persistence-by-default is the established norm for similar GM UI prefs (`useRosterExpandedSet`).

4. **CSS-only "presentation mode" that visually mutes destructive buttons rather than hiding them.** Trade-off: keeps muscle-memory click targets but defeats the safety-against-fat-finger rationale. Rejected as primary; could be a future v2 tweak.

5. **Move the toggle into the section headers (e.g. a small icon next to "Treason Grants").** Trade-off: more discoverable in-context but clutters the section headers and duplicates the affordance. Rejected: GM Tools drawer is the canonical home for GM-only utilities, per the `2026-04-27-gm-tools-button-v2` plan.

6. **Hide "+ New Grant" / "+ New Goal" too.** Trade-off: a stricter "presentation mode". Rejected because the user enumerated specific buttons and creating is a distinct action from editing/deleting; revisit if user feedback wants a fuller "presentation" toggle.
