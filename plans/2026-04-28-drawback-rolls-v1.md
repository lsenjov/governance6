# Drawback rolls — v1

## Objective

Extend the dice-rolls system (`plans/2026-04-28-2026-04-28-dice-rolls-v3.md`)
so that whenever a Minion call reaches the head of the FIFO queue, every
"is-rolled" Drawback on that Minion's Syndicate produces an additional die,
rendered alongside the existing Skill and Chaos cells. Drawback dice follow
the same universal natural-1 failure rule and the same GM-only visibility
contract.

In addition, mirror the existing preset-skill admin catalogue
(`convex/presetSkills.ts`, `src/pages/AdminPage.tsx`) with a new preset
**Drawback** catalogue. Site admins manage a list of named drawback
templates (name, description, optional abbreviation, `isRolled` boolean).

**Syndicates are not required to use the preset catalogue.** The Syndicate
editor's drawback form merely _autocompletes_ on the preset list — typing
a preset name will offer it as a suggestion and (on selection) prefill
the **name and description only**, but free-form drawback names that are
not in the catalogue remain fully supported, exactly the same way the
skills field at `src/pages/SyndicateEditorPage.tsx:564-627` permits
typed-but-not-listed values. The catalogue is a convenience layer, not
a constraint.

**Visibility of `abbreviation` and `isRolled` is asymmetric by design.**
Site admins set them when authoring presets; non-admin Syndicate owners
never see them in the editor. The two fields ride along invisibly when
the editor matches a preset by name and then live frozen on the
per-Syndicate row. From a Syndicate owner's vantage point, drawbacks
are still just `(name, description)` pairs. The abbreviation only ever
surfaces to a **GM**, and only as the caption on the rolled die in
`RollSetDisplay`; it is never rendered as a badge in the Current Call
drawback list, the Syndicate editor, or any Player-visible payload.
This means free-form drawbacks (typed names not in the catalogue) carry
`abbreviation: undefined` and `isRolled: false` by default and produce
no extra die — to make a drawback roll, the Syndicate owner must pick
a preset whose admin marked it `isRolled === true`.

The two surfaces are:

1. **Per-Syndicate Drawback rows** (`drawbacks` table — already exists,
   Rule 3): gain two new fields, `abbreviation` (optional) and `isRolled`
   (boolean). The Syndicate editor does not expose them; they are
   populated only by the preset-prefill pipeline at row-creation time
   (or directly via the Convex dashboard for admin overrides). Used to
   drive the new die-roll behaviour.
2. **Preset Drawback catalogue** (new `presetDrawbacks` table): admin-only
   CRUD; reused as autocomplete templates in the Syndicate editor. Each
   row carries the same four fields so picking a preset can prefill all of
   them onto the per-syndicate row at insert time (the user sees only
   name and description; abbreviation and `isRolled` ride along
   invisibly).

## Project structure summary

- **Schema** lives in `convex/schema.ts`. Existing per-Syndicate drawbacks
  table at `convex/schema.ts:54-59`; existing preset-skill table at
  `convex/schema.ts:35-39`.
- **Per-Syndicate Drawback CRUD** at `convex/drawbacks.ts:1-94`. CRUD is
  gated by `assertSyndicateEditable` (`convex/lib/auth.ts:144-155`).
- **Preset Skill CRUD** at `convex/presetSkills.ts:1-87`; gated by
  `requireSiteAdmin` (`convex/lib/auth.ts:36-42`). Read by any
  authenticated user.
- **Roll generation helper** `generateRollSetForCall` in
  `convex/lib/rolls.ts:146-214` — already accepts an `extras` array of
  `{ kind, name, value, result? }` items with name validation and
  natural-1 coercion (`convex/lib/rolls.ts:80-106`,
  `convex/lib/rolls.ts:66`). The trigger sites in `convex/calls.ts` are
  the only callers today and pass `extras: []`.
- **Roll trigger sites**: `addOrReplaceCall` (`convex/calls.ts:42-94`) and
  `removeCall` (`convex/calls.ts:149-191`) — both call
  `generateRollSetForCall` whenever a minion call becomes the head.
- **GM-only Current Call deep-dive** `getCurrentCallDetails` at
  `convex/calls.ts:390-469` already loads the syndicate's drawbacks for
  display (`convex/calls.ts:437-441,460-464`) — we'll widen the projected
  shape but the read pattern is unchanged.
- **Roll display** in `src/components/RollSetDisplay.tsx:124-139` — already
  iterates `rolls.extras` and renders one cell per item using
  `extra.name.toUpperCase()`. No structural change required.
- **Syndicate editor** `DrawbacksEditor` and `DrawbackRow` at
  `src/pages/SyndicateEditorPage.tsx:188-322`. The skills field
  (`SkillsField` at `:564-627`) shows the existing pattern for a
  `<datalist>`-driven autocomplete that we will mirror for drawback names.
- **Admin console** at `src/pages/AdminPage.tsx:1-156` — single-section page
  for preset skills; will gain a second section for preset drawbacks.

## Key findings & rationale

1. **Drawback rolls are extras, not new top-level fields.** The existing
   `callRollSets.extras` array (`convex/schema.ts:208-217`) was built
   precisely for this — `kind: "drawback"`, a per-die `name` caption, a
   d6 `value`, and the optional `result` that the helper coerces to
   `"failure"` whenever the value is `1`. No schema change to
   `callRollSets` is required, and the existing GM-only wire-format
   guarantees apply unchanged.

2. **Each becoming-the-head event re-rolls every is-rolled drawback.**
   The helper writes one immutable `callRollSets` row per
   "becoming-the-head" event. All drawback dice for that event must live
   on the same row so a Note attached to the head freezes the full
   bundle, and so a later replace-in-place re-rolls every die together
   (skill + chaos + drawbacks). This matches the v3 plan's atomic-bundle
   stance (`plans/2026-04-28-2026-04-28-dice-rolls-v3.md` Key finding 4).

3. **The drawback-roll list is computed from the _Syndicate's_ drawbacks
   at roll time.** Per-Syndicate drawbacks live on `syndicates`
   (`convex/schema.ts:54-59`); the called minion belongs to a syndicate
   via `minions.syndicateId` (`convex/schema.ts:64-71`). The trigger site
   loads the minion → syndicate → drawbacks chain (the same chain
   `getCurrentCallDetails` already walks at `convex/calls.ts:431-441`)
   and emits one extras item per drawback with `isRolled === true`.

4. **`isRolled` and `abbreviation` are optional at the schema level.** No
   backfill is required — existing rows project `undefined` as `false`
   and "no abbreviation" respectively, matching the existing
   `kind === undefined` → `"minion"` projection pattern at
   `convex/calls.ts:292`. Owners can opt in by editing the drawback row.

5. **Abbreviation drives the die caption; name is the fallback.** The
   helper's name validator (`convex/lib/rolls.ts:80-106`) enforces
   1–24 chars after trim and rejects empty values. The drawback
   trigger site is **stricter** than the helper: it caps the abbreviation
   at 6 characters at the input boundary (Tasks 1, 3, 6) and truncates
   the name fallback to 6 characters as well (Task 7 step 5). Six is
   the brutalist square-cell budget — short enough to fit between
   Skill and Chaos at the right-rail size without wrapping or shrinking
   the cell. The 24-char cap in `convex/lib/rolls.ts:66` stays as the
   helper's defensive ceiling so other future extras kinds (which may
   want longer captions) are not constrained by the drawback-specific
   choice.

6. **Preset drawbacks are templates, not foreign keys.** Mirroring the
   preset-skill model (`convex/presetSkills.ts:1-87`), preset rows are
   _picked_ in the editor, _copied_ into the per-syndicate row, and then
   freely edited. There is no FK from `drawbacks` to `presetDrawbacks`.
   This:
   - keeps Played syndicates immutable even if the catalogue is later
     edited (Rule 7);
   - matches the user's free-form-allowed expectation (the skill field
     already permits typed-but-not-listed values);
   - avoids cross-table cascades when an admin removes a preset.

7. **Admin-only writes, authenticated reads.** Same access pattern as
   preset skills — `requireSiteAdmin` for create/update/delete,
   `requireUserId` for `list` so the editor's autocomplete works for any
   authenticated user (`convex/presetSkills.ts:30-37`).

8. **Brutalist cell labelling fits unchanged.** `RollSetDisplay` already
   rendering `extra.name.toUpperCase()` (`src/components/RollSetDisplay.tsx:133`)
   means a 6-char abbreviation like `"GLSJAW"` slots cleanly between
   Skill and Chaos with no styling work. The defence-in-depth natural-1
   re-derivation at `src/components/RollSetDisplay.tsx:124-126` already
   covers drawback dice.

## Implementation Plan

### Backend: schema

- [x] Task 1. In `convex/schema.ts`, extend the existing `drawbacks` table
      (`convex/schema.ts:54-59`) with two optional fields: - `abbreviation: v.optional(v.string())` — short caption (≤6
      chars after trim) used as the die-cell label when the drawback
      rolls. Optional so legacy rows remain valid. Set only via the
      preset-prefill pipeline (Task 14) at row creation; the
      Syndicate editor does not expose this field for direct editing. - `isRolled: v.optional(v.boolean())` — when `true`, this drawback
      contributes a d6 to every becoming-the-head roll set for any
      minion in this syndicate. `undefined` projects to `false`. Set
      only via the preset-prefill pipeline (Task 14) at row creation;
      the Syndicate editor does not expose this field. To grant a
      free-form drawback rolling behaviour, an admin must add it to
      the preset catalogue and the owner must re-pick it.
      No new index is required — drawbacks are already fetched per
      syndicate via `by_syndicate` at `convex/schema.ts:59`.

- [x] Task 2. In `convex/schema.ts`, add a new `presetDrawbacks` table
      mirroring the preset-skill shape (`convex/schema.ts:35-39`). Fields: - `name: v.string()` — required, trimmed, 1–120 chars, unique
      case-insensitively across the table (matching the preset-skill
      rule). - `description: v.string()` — required, may be empty, ≤2000 chars
      (matching `DRAWBACK_DESC_MAX` in `convex/drawbacks.ts:11`). - `abbreviation: v.optional(v.string())` — same constraints as
      Task 1. - `isRolled: v.optional(v.boolean())` — default template for the
      per-syndicate row. - `createdByUserId: v.id("users")`. - `createdAt: v.number()`.
      Add the `by_name` index on `["name"]` explicitly — it mirrors the
      `presetSkills` index at `convex/schema.ts:39` and exists so the
      catalogue's autocomplete `list` query returns rows in a stable
      sort-friendly order. Although the case-insensitive uniqueness
      check on insert/update is currently implemented via `.collect()`
      (matching `convex/presetSkills.ts:46-50`), the `by_name` index
      keeps the table's read pattern symmetric with preset skills and
      leaves room for a future indexed-prefix lookup.

### Backend: per-Syndicate drawback CRUD

- [x] Task 3. In `convex/drawbacks.ts`, extend the `create` mutation
      (`convex/drawbacks.ts:13-43`) to accept optional `abbreviation`
      and optional `isRolled` arguments. Validation: - `abbreviation`, when present, is trimmed; reject if empty after
      trim (treat empty input as "absent" — pass `undefined` through),
      reject if longer than 6 chars. - `isRolled` defaults to `false` when omitted; `true` is accepted
      as-is.
      Persist both fields via `ctx.db.insert("drawbacks", …)`. Note: in
      production these args are only ever populated by the editor's
      preset-prefill pipeline (Task 14); free-form rows pass
      `undefined` for both. The mutation accepts the args directly
      rather than performing a server-side preset lookup so a single
      admin-edit-then-database-script can patch existing rows without
      touching the editor.

- [x] Task 4. In `convex/drawbacks.ts`, extend the `update` mutation
      (`convex/drawbacks.ts:45-71`) symmetrically: - Accept optional `abbreviation` (same rules as Task 3; an
      explicitly empty string after trim should clear the field via an
      explicit `abbreviation: undefined` patch — same idiom as
      `convex/lib/calls.ts:105,111`). - Accept optional `isRolled` boolean.
      Both fields are independently patchable; omitting them leaves the
      stored value unchanged. The Syndicate editor does **not** call
      `update` with these fields (Task 14 limits the editor's update
      payload to `name` and `description`); the args exist for admin
      DB-shell scripts and any future tooling.

- [x] Task 5. `listForSyndicate` (`convex/drawbacks.ts:83-93`) requires
      no logic change — the new fields are returned automatically by the
      `.collect()`. Add a brief code comment noting that `isRolled ===
  undefined` projects to `false` for downstream consumers.

### Backend: preset Drawback catalogue (new module)

- [x] Task 6. Create `convex/presetDrawbacks.ts` mirroring
      `convex/presetSkills.ts:1-87`: - `list` query: `requireUserId`, `.collect()`, sort by `name`. - `add` mutation (`requireSiteAdmin`): accepts `name`,
      `description`, optional `abbreviation`, optional `isRolled`.
      Validates name (trimmed, 1–120 chars, case-insensitive unique
      across the table — same idiom as `convex/presetSkills.ts:46-50`),
      description (≤2000 chars), abbreviation (trimmed, ≤6 chars or
      absent). Defaults `isRolled` to `false`. - `update` mutation (`requireSiteAdmin`): patches any subset of
      the four fields with the same per-field validation; explicit
      `abbreviation: undefined` clears the field. - `remove` mutation (`requireSiteAdmin`): idempotent delete by id.
      No FK fan-out is needed — per-Syndicate rows do not reference
      preset rows (Key finding 6).

### Backend: drawback dice on every becoming-the-head event

- [x] Task 7. Add a private helper `getDrawbackExtrasForCall` to
      `convex/lib/rolls.ts` (or co-locate next to
      `generateRollSetForCall`). Signature conceptually:
      `(ctx: MutationCtx, call: Doc<"calls">) =>
  Promise<ExtraRollInput[]>`. Behaviour: 1. If `call.kind === "custom"` or `call.minionId` is missing,
      return `[]` (custom calls do not roll — see
      `convex/lib/rolls.ts:172-181`). 2. Load the minion via `call.minionId`. On miss, return `[]` (the
      outer helper already logs and skips on minion miss). 3. Load the syndicate's drawbacks via the existing
      `by_syndicate` index, sorted by `order` ascending so dice
      appear in the same order they show in the editor and the
      Current Call section (`convex/calls.ts:441`). 4. Filter to drawbacks with `isRolled === true` (`undefined`
      projects to `false`, defence-in-depth against legacy rows). 5. For each, build an `ExtraRollInput`: - `kind: "drawback"` — stable machine discriminator. - `name`: `(d.abbreviation ?? "").trim() || d.name`, then
      truncated to **6 characters** via `.slice(0, 6)` after trim.
      Six is the brutalist square-cell budget (Key finding 5);
      the helper's own 24-char ceiling at
      `convex/lib/rolls.ts:66` still applies as a defensive upper
      bound but the trigger site is intentionally stricter so all
      drawback dice render at a uniform width regardless of
      whether the abbreviation is set. Truncating _before_ the
      validator sees the string also guarantees a name like
      `"VERY-LONG-DRAWBACK-NAME"` (legal under
      `DRAWBACK_NAME_MAX = 120`) cannot trip the validator's
      length check. - `value`: `1 + Math.floor(Math.random() * 6)`. Rolling here
      rather than inside `generateRollSetForCall` keeps the
      helper's input shape intact and confines all drawback-aware
      logic to one place. - `result`: omitted; the existing
      `normaliseExtraRoll` (`convex/lib/rolls.ts:80-106`) will set
      it to `"failure"` whenever `value === 1`.

- [x] Task 8. Update each call site of `generateRollSetForCall` so the
      drawback extras are computed once and passed in: - `addOrReplaceCall` at `convex/calls.ts:88` (head insert /
      cross-kind upgrade / replace-in-place). - `removeCall` at `convex/calls.ts:183-186` (next-call promotion
      when the previous head was removed).
      Each site should: 1. Re-read the head call after the queue mutation (the helpers
      already do this). 2. Call `getDrawbackExtrasForCall(ctx, headCall)`. 3. Pass the result as `extras` to `generateRollSetForCall`.
      No new index is needed — `by_syndicate` already supports the read.

- [x] Task 9. Confirm the helper's own contract is unchanged: every
      caller-supplied extras item still passes through
      `normaliseExtraRoll` (`convex/lib/rolls.ts:80-106,197-198`), so
      the natural-1 coercion, the trimmed `kind`/`name` invariants, and
      the `[1,6]` value range guard are all enforced for drawback dice
      with no extra code.

### Backend: query exposure

- [x] Task 10. `activeCalls` (`convex/calls.ts:233-337`) requires no
      change — it already projects the full `extras` array via
      `projectRollSet` for GMs (`convex/calls.ts:328`,
      `convex/lib/rolls.ts:247-260`). Drawback dice flow through
      automatically.

- [x] Task 11. `getCurrentCallDetails` (`convex/calls.ts:390-469`)
      requires no change. The drawback list at
      `convex/calls.ts:460-464` continues to project just
      `{ _id, name, description }` — the GM's Current Call section
      does not render abbreviation badges or `isRolled` markers in the
      drawback list. The abbreviation surfaces only as the dice-cell
      caption inside `RollSetDisplay`, which reads it from the immutable
      `callRollSets.extras` snapshot (Task 7), not from the live
      drawback row. Keeping the projection narrow also preserves the
      symmetry with the Player-facing read paths and avoids leaking
      `isRolled` into a query whose only consumer wouldn't display it.

- [x] Task 12. `listNotesForTarget` and the rest of the notes pipeline
      (`convex/notes.ts`) require no change — the dice-rolls v3 freezing
      mechanism (`plans/2026-04-28-2026-04-28-dice-rolls-v3.md` Task 11)
      already snapshots the entire roll set including extras, and the
      GM-only filtering already covers drawback dice.

- [x] Task 13. Confirm `syndicates.getWithChildren`
      (`convex/syndicates.ts:204-235`) requires no change — the
      handler returns `{ ...syndicate, drawbacks, minions, isOwner,
  canEdit }` with `drawbacks` set to the raw `.collect()` result
      and no per-field projection, so the two new optional fields
      (`abbreviation`, `isRolled`) flow through to the editor
      automatically. The editor does not display them (Task 14) but
      passing them through is harmless and matches the
      no-projection-narrowing convention already used here.

### Frontend: Syndicate editor — drawback autocomplete (no new visible fields)

- [x] Task 14. In `src/pages/SyndicateEditorPage.tsx`, extend
      `DrawbacksEditor` (`src/pages/SyndicateEditorPage.tsx:188-259`)
      and `DrawbackRow` (`src/pages/SyndicateEditorPage.tsx:261-322`).
      The editor's user-visible surface stays exactly
      `(name, description)` for both creation and existing-row editing —
      no abbreviation input, no "Rolled when called" checkbox is
      rendered. The two new fields are populated invisibly when (and
      only when) the user picks a name that matches a preset. - Subscribe to `api.presetDrawbacks.list` (analogous to the
      existing `api.presetSkills.list` subscription at
      `src/pages/SyndicateEditorPage.tsx:338`). - In the "new drawback" form, attach a `<datalist>` to the name
      input so users see preset names as suggestions (mirror the
      `SkillsField` pattern at `src/pages/SyndicateEditorPage.tsx:577-587`). - When the typed name **exactly matches** (case-insensitive) a
      preset row, on the matching keystroke prefill the visible
      `description` field (only when the description input is empty
      or whitespace, to avoid clobbering user-entered prose) and
      snapshot the preset's `abbreviation` and `isRolled` into
      component state. On submit, pass all four fields
      (`name`, `description`, `abbreviation`, `isRolled`) to the
      `create` mutation; otherwise pass just `(name, description)`
      and let the schema's optionals default to absent / `false`.
      Document this in a code comment so a future contributor doesn't
      mistake the auto-prefill for a strict link to the preset row. - Existing-row editing: `DrawbackRow`'s save action calls
      `update` with **only** `(name, description)`. The persisted
      `abbreviation` and `isRolled` are intentionally not patchable
      from this UI — they remain at whatever value the row was
      created with (or `undefined` / `false` for free-form rows). To
      change the rolling behaviour of an existing row the owner
      must delete and re-create it. - The whole prefill machinery is gated on `canEdit === true`,
      consistent with the disabled-state pattern at
      `src/pages/SyndicateEditorPage.tsx:290,300`.

      Rationale: the user feedback (2026-04-28) explicitly scoped
      `abbreviation` and `isRolled` to the admin domain — site admins
      author them on presets, GMs see the abbreviation only on the
      rolled die. Surfacing the boolean in the syndicate-owner UI
      would invite mis-toggles and re-open the immutability
      expectation gap (Risk 6). This task therefore eliminates the
      tooltip-on-checkbox affordance entirely and preserves the
      existing two-field editor shape.

### Frontend: Admin console — preset drawback section

- [x] Task 15. In `src/pages/AdminPage.tsx`, add a second `<section>`
      below the existing preset-skills section, mirroring the structure
      of `src/pages/AdminPage.tsx:41-55`: - "Preset drawbacks ({drawbacks?.length ?? 0})" heading. - `AddPresetDrawbackForm` component (analogous to
      `AddPresetSkillForm` at `src/pages/AdminPage.tsx:60-95`) with
      inputs for name, description, abbreviation (optional), and a
      checkbox for `isRolled`. - `PresetDrawbackRow` component (analogous to `PresetSkillRow` at
      `src/pages/AdminPage.tsx:97-156`) with editable inputs for
      all four fields and Save/Delete buttons.
      No new visual primitives required — reuse `card`, `card stack`,
      `error-text`, `success-text`, `danger`, `secondary` classes.

### Frontend: Current Call section — no drawback-row indicators

- [x] Task 16. In `src/pages/GameDetailPage.tsx`'s `CurrentCallSection`,
      the drawback list at
      `src/pages/GameDetailPage.tsx:2410-2437` requires **no change**.
      The GM-facing drawback list keeps its existing
      `(name, description)` rendering — abbreviation and `isRolled`
      are intentionally never surfaced here per the visibility
      contract in the Objective. Add a one-line code comment at the
      top of that block explaining the omission so a future contributor
      doesn't "helpfully" add a badge. The abbreviation appears solely
      as the dice-cell caption rendered by `RollSetDisplay` (Task 17).

### Frontend: dice display — no changes required

- [x] Task 17. Confirm `RollSetDisplay`
      (`src/components/RollSetDisplay.tsx:1-142`) renders drawback dice
      correctly with no code change: extras with `kind: "drawback"`
      flow through the existing iteration at
      `src/components/RollSetDisplay.tsx:124-139`, the universal
      natural-1 rule applies via the existing `effective` helper at
      `src/components/RollSetDisplay.tsx:40-48`, and the caption comes
      from `extra.name.toUpperCase()` at
      `src/components/RollSetDisplay.tsx:133`. Add a code comment in
      the component noting that drawback dice are first-class extras to
      pre-empt future regressions that would special-case `kind`.

### Backend: tests

- [x] Task 18. Create `convex/drawbacks.test.ts` (no existing test
      file for this module — the existing backend test suite at
      `convex/calls.test.ts`, `convex/notes.test.ts`,
      `convex/treasonGrants.test.ts`, `convex/goals.test.ts`,
      `convex/publicBids.test.ts` provides the harness pattern). Use
      `convex/treasonGrants.test.ts` as the structural template (it
      exercises owner-gated CRUD with optional fields, which is the
      closest analog). Cases: - `create` accepts optional `abbreviation` and optional
      `isRolled`; persists them; rejects abbreviation longer than
      6 chars; treats empty-after-trim abbreviation as
      `undefined`. - `update` patches abbreviation and `isRolled` independently;
      explicit empty abbreviation clears the field. (Note: the
      editor will not exercise these update paths in production —
      Task 14 — but they exist for admin tooling and must be
      regression-tested.) - `listForSyndicate` returns the new fields.

- [x] Task 19. Create `convex/presetDrawbacks.test.ts` (no existing
      test file — `convex/presetSkills.ts` is also untested today, so
      there is no direct preset analog). Use
      `convex/treasonGrants.test.ts` as a structural template for
      admin-gated CRUD. Cases: - Site admin can create / update / delete; non-admin cannot
      (asserts `requireSiteAdmin` throws for a vanilla user). - Case-insensitive name uniqueness on insert and update. - All four fields round-trip; abbreviation length validation
      (≤6 chars) applied; `isRolled` defaults to `false` on
      omission.

- [x] Task 20. Extend `convex/calls.test.ts`'s "dice rolls" describe
      block (or add a new "drawback rolls" block) to cover: - Creating a syndicate with two `isRolled` drawbacks and one
      non-rolled drawback (seeded directly via `ctx.db.insert` or
      `t.run` so the editor gating in Task 14 doesn't apply), then
      issuing a head call: the resulting roll set has exactly two
      extras with `kind === "drawback"`, each with a value in
      `[1,6]`, and each with `name` equal to the drawback's
      abbreviation (or fallback name) truncated to 6 chars and
      uppercased post-validation. - A drawback whose abbreviation is empty after trim falls back
      to `name` and the helper still accepts the row. - A drawback whose name is longer than 6 chars and has no
      abbreviation is truncated to 6 chars at the trigger site
      (asserts the truncation invariant in Task 7 step 5). - When `chaosRoll === 1` AND a drawback rolls `1`, both cells
      are recorded as `result: "failure"` (regression guard against
      natural-1 drift across extras). - Replace-in-place on a head minion that lives in a syndicate
      with `isRolled` drawbacks emits a brand-new roll set whose
      extras are independently re-rolled (each row's drawback
      values can differ from the previous row's). - **Toggle-then-replace**: starting from a head call whose
      syndicate has a non-rolled drawback, flipping that drawback's
      `isRolled` to `true` directly via `ctx.db.patch` (the editor
      cannot do this in production — Task 14 — but the backend
      invariant must still hold) and then triggering a
      replace-in-place on the head minion produces a new roll set
      whose extras include the now-rolled drawback. This asserts
      the trigger-site re-read happens _after_ the queue mutation
      commits, so newly-rolled drawbacks are picked up immediately
      on the next eligible event without restarting the game. - **Free-form drawbacks do not roll**: a syndicate with a
      drawback that has `abbreviation: undefined` and
      `isRolled: undefined` (the default for any row created
      without preset prefill) emits zero drawback extras even
      though the drawback row exists. - Removing the head call promotes the next call and includes
      that next call's syndicate's `isRolled` drawbacks as extras
      on the new roll set. - Custom calls and minion calls without drawbacks emit no
      drawback extras (regression guard against the
      `call.kind === "custom"` early-return in Task 7 step 1). - Players continue to receive no `rolls` field on
      `activeCalls` even when drawback extras exist (defends the
      wire-format guarantee from `plans/2026-04-28-2026-04-28-dice-rolls-v3.md`
      Task 8).

- [x] Task 21. Extend `convex/notes.test.ts`'s "dice attachment" block
      (per `plans/2026-04-28-2026-04-28-dice-rolls-v3.md` Task 17) with
      one extra case: a Note frozen onto a head call with drawback
      extras still resolves them in the GM's
      `listNotesForTarget.attachedRolls.extras` payload after the head
      moves on, and the Player viewing the same Note still sees no
      `attachedRolls` field at all.

### Frontend: smoke checks

- [x] Task 22. Manually verify (or, if a UI test harness exists, add
      smoke coverage matching `plans/2026-04-28-2026-04-28-dice-rolls-v3.md`
      Task 20) that: - The Admin page shows two sections (skills and drawbacks) for
      a site admin and the same "no privileges" card for everyone
      else. - The Syndicate editor's drawback name input opens the preset
      list as a `<datalist>`; selecting a preset prefills only the
      description (and only when the description is empty), and
      does **not** add any abbreviation input or "Rolled when
      called" checkbox to the editor. - Free-form drawback names not in the catalogue still create
      successfully and are persisted with
      `abbreviation: undefined`, `isRolled: false`. - A GM playing a game whose head minion belongs to a syndicate
      with two preset-sourced `isRolled` drawbacks sees four cells
      (Skill, Chaos, and two drawback cells) in the right rail's
      head row and in the Current Call section, with each drawback
      cell captioned by the abbreviation (uppercased, ≤6 chars) or
      the drawback name truncated to 6 chars and uppercased when no
      abbreviation is set. - The GM's Current Call drawback list still shows just
      `name` + `description` per drawback — no badge, no "Rolled"
      marker. - A natural `1` on any drawback die shows the riot-red top
      rule + "FAIL" badge identical to the skill failure
      treatment.

## Verification Criteria

- A site admin can create, edit, and delete preset drawbacks via the
  Admin page; a non-admin sees a read-only message in that section.
- The Syndicate editor lists preset drawback names as autocomplete
  suggestions on the new-drawback name input. Picking a preset
  prefills the description (only when empty) and silently carries
  the preset's `abbreviation` and `isRolled` into the per-Syndicate
  row at create time. Free-form drawback names not in the catalogue
  still create successfully and are persisted with
  `abbreviation: undefined` and `isRolled: false`.
- The Syndicate editor's drawback rows expose only `name` and
  `description` controls — no abbreviation input and no "Rolled when
  called" checkbox is rendered for syndicate owners. Editing an
  existing drawback row patches `name` and `description` only;
  `abbreviation` and `isRolled` retain their creation-time values.
- When a Minion call reaches the head of the queue, the GM's
  Current Call section and right-rail head row display one extra
  die per `isRolled === true` drawback on that Minion's syndicate,
  in the same order the editor shows them. Each die's caption is
  the abbreviation (uppercased, ≤6 chars) or the drawback name
  truncated to 6 chars and uppercased when no abbreviation is set.
- The GM's Current Call drawback list continues to render only
  `(name, description)` per drawback — no abbreviation badge or
  "Rolled" marker is shown anywhere outside the dice-cell caption.
- Replacing the head minion with another (same syndicate or
  different syndicate) regenerates the entire roll set including
  fresh drawback rolls, and removing the head promotes the next
  call with its own syndicate's drawback rolls.
- A natural `1` on any drawback die renders with the failure
  treatment (riot-red top rule + "FAIL" badge), regardless of any
  caller-supplied result. A drawback rolling `2`–`6` is rendered
  neutrally just like the chaos cell.
- A Player or non-participant viewing the same game continues to
  see no dice anywhere — `activeCalls`, `getCurrentCallDetails`,
  and `listNotesForTarget` payloads carry no `rolls` /
  `attachedRolls` / `attachedRollSetId` fields, exactly as today.
- A Note authored against a head Minion with `isRolled` drawbacks
  freezes the full extras bundle (skill + chaos + drawbacks) onto
  the note. After the head moves on, the GM viewing the historical
  Note still sees the original drawback values.
- All new and existing backend tests pass under `npm test` /
  `vitest`, and `npx convex codegen` succeeds with the schema
  changes.
- `THEME.md:62-91,182-198` brutalist verification continues to pass —
  no new visual tokens; all new UI controls reuse existing
  utilities.

## Potential Risks and Mitigations

1. **Caption length collisions.** A drawback whose abbreviation is
   absent and whose name is longer than 6 chars would render an
   under-filled cell if the trigger site didn't truncate. Mitigation:
   Task 7 step 5 truncates to 6 characters before the helper sees the
   string, and the brutalist square cell renders any 1–6 char caption
   uniformly. Task 20 adds a regression test for the truncation
   branch and for the abbreviation-absent fallback path.

2. **Per-game read-budget growth.** Each becoming-the-head event now
   loads the syndicate's drawbacks (already loaded in
   `getCurrentCallDetails` for the same game). Mitigation: the
   `by_syndicate` index already supports this read; the per-event
   cost is one `.collect()` over ≤5 rows, well within Convex's
   per-mutation limit. No bulk-read pattern needed.

3. **Drift between schema-level optional and consumer-level boolean.**
   Treating `isRolled === undefined` as `false` in some sites and as
   `null` / `"unset"` in others would be confusing. Mitigation:
   Task 7 normalises to a strict boolean at the trigger site, Task 11
   widens the GM projection to a strict boolean, and Task 14 binds
   the editor checkbox to a strict boolean state (defaulting to
   `false` on load).

4. **Preset/per-Syndicate divergence.** Editing a preset row after a
   syndicate has copied it leaves the syndicate's row stale.
   Mitigation: this is the documented behaviour (Key finding 6); a
   short comment in `convex/presetDrawbacks.ts` and in the editor
   makes it explicit. Played syndicates remain frozen by Rule 7.

5. **Skill-field-style autocomplete UX divergence.** Users may expect
   the drawback datalist to behave like the skill one — same `useId`
   list, same submit-on-Enter — but the drawback form is a single
   row, not a multi-input field. Mitigation: Task 14 explicitly
   models the drawback datalist on `SkillsField`'s pattern at
   `src/pages/SyndicateEditorPage.tsx:564-627`, so the keyboard
   semantics match. The auto-prefill only writes into the visible
   `description` field when it is empty (avoiding the clobber-while-
   typing failure mode), and never writes into a field the user can
   see for `abbreviation` / `isRolled` (those fields aren't
   rendered).

6. **`isRolled` toggling mid-game changes future rolls but not past
   ones.** Players might expect a toggled drawback to retroactively
   change rolls. Mitigation: roll sets are immutable
   (`callRollSets` is append-only by design — see Key finding 3 in
   the dice-rolls v3 plan). The Syndicate editor cannot toggle
   `isRolled` at all (Task 14 deliberately removes the affordance),
   so the only mid-game toggles can come from an admin DB-shell
   patch. Document the expected behaviour as a code comment in
   `convex/drawbacks.ts` next to the new field so admins reading
   the schema know the semantics before they reach for `db.patch`.

7. **Naming of `isRolled`.** The user explicitly invited a better
   name. Mitigation: stay with `isRolled` for parity with the
   project's other `isXxx` booleans (`isShared`, `isSiteAdmin`,
   `isActive`, `isAnonymous`); a future plan can rename without
   schema disruption since Convex tolerates field renames via a
   read-time projection.

## Alternative Approaches

1. **Store drawback rolls in their own dedicated table linked to the
   roll set.** Trade-off: more rows per event, requires a new index
   and a join in every read, breaks the "one immutable bundle"
   invariant from `plans/2026-04-28-2026-04-28-dice-rolls-v3.md` Key
   finding 3, and complicates Note attachment. Rejected — `extras`
   was designed for exactly this.

2. **Compute drawback caption on the client.** Send `kind:
"drawback"` + the drawback id; have the UI look up the drawback
   for its abbreviation/name at render time. Trade-off: leaks the
   drawback id into the GM payload, requires a client-side fetch
   that doesn't currently exist for `activeCalls`, and breaks the
   roll-set's "freeze the live state" guarantee (the rendered
   caption would change if the drawback was later renamed).
   Rejected.

3. **Make `isRolled` a per-Game property rather than a per-Drawback
   property.** Trade-off: forces every owner to opt every drawback in
   or out at game-creation time, doesn't survive editor edits, and
   makes the preset catalogue useless. Rejected — per-drawback is
   the natural granularity.

4. **Promote `presetDrawbacks` to a generic `presetEntries` table
   keyed by a kind enum (skill | drawback | …).** Trade-off: smaller
   schema surface but every consumer needs a kind filter and the
   uniqueness rules diverge between kinds, complicating the unique
   index. Rejected — clarity beats DRY-ness here, matching the
   existing single-purpose preset-skill table.

5. **Roll the drawback dice inside `generateRollSetForCall` itself,
   reading drawbacks from the call's minion automatically.** Trade-off:
   concentrates the drawback-aware logic inside the otherwise-generic
   helper, blurs the helper's contract ("here are the extras to add"
   becomes "we'll figure out the extras"), and would force the helper
   to special-case drawbacks vs other future extras kinds. Rejected
   — Task 7's external helper preserves the clean boundary.

6. **Auto-roll _all_ drawbacks regardless of `isRolled`.** Trade-off:
   simpler schema, but the user explicitly asked for opt-in via the
   boolean and the syndicate may carry narrative-only drawbacks that
   shouldn't generate dice. Rejected — explicit opt-in matches the
   user's request.
