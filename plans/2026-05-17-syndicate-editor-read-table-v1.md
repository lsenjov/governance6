# Syndicate Editor — Read-Mode Tables + Colspan Inline Editor

## Objective

Replace the current two-column `section-grid` layout of
`src/pages/SyndicateEditorPage.tsx` (Drawbacks left, Minions right —
`SyndicateEditorPage.tsx:81-99`) with a single-column page that renders
Drawbacks and Minions as two dense `<table>`s.

By default every drawback and every minion is fully visible — name,
accent, full description, all 1–5 skills, all rendered as static text
or chips. No expand-to-see-details. The user can scan the entire
syndicate at a glance.

When the user clicks `[EDIT]` on a row, that one `<tr>` is replaced
in place by a single `<tr><td colspan=N>` cell hosting the existing
edit-form body (name input, accent input, description textarea,
`SkillsField`, Save/Cancel/Delete, error/saved messages). The other
rows stay in read mode and remain fully visible.

The local-state pattern of `MinionRow` / `DrawbackRow` (each row owns
its own draft state via `useState` — see
`SyndicateEditorPage.tsx:582-587` and `:368-370`) is preserved. No
state lifting. No drawer, no modal, no focus trap infrastructure.

A long-description fallback (Design 2 trick): minions whose
description exceeds a threshold render a _second_ read-mode `<tr>`
with a `colspan=4` description cell beneath the row, so prose never
crowds the chip column. Same table, conditional row shape.

## Initial Assessment

### Project Structure Summary

- Single React component file:
  `src/pages/SyndicateEditorPage.tsx` (723 lines).
- The page is reached from `src/App.tsx` at `/syndicates/:syndicateId`
  and `/admin/syndicates/:syndicateId`. No other consumers.
- No `SyndicateEditorPage.test.*` exists; the component is exercised
  indirectly through `convex/syndicates.test.ts`, `convex/minions.test.ts`,
  and `convex/drawbacks.test.ts`. Those are backend tests and are
  unaffected by this change.
- Backend mutations are not touched: `api.syndicates.update`,
  `api.drawbacks.create/update/remove`, `api.minions.create/update/remove`,
  `api.syndicates.setIsShared` stay as-is.

### Relevant Files Examination

- `src/pages/SyndicateEditorPage.tsx:37-101` — page shell, back link,
  title, status banners, `SyndicateCore` form, and the two-column
  `section-grid` that hosts `DrawbacksEditor` + `MinionsEditor`. The
  `section-grid` div at line 81 is the single layout element to
  remove.
- `src/pages/SyndicateEditorPage.tsx:228-355` — `DrawbacksEditor`. List
  of `DrawbackRow` cards + new-drawback `<form>` with preset
  autocomplete via `<datalist>` (`:319-352`). All preset-prefill logic
  at `:264-275` MUST be preserved verbatim.
- `src/pages/SyndicateEditorPage.tsx:357-418` — `DrawbackRow`. Local
  `useState` for `name`, `description`, `err` at `:368-370`. Edit-form
  inputs always rendered; save/delete row at `:402-415`.
- `src/pages/SyndicateEditorPage.tsx:422-483` — `MinionsEditor`. Unique-
  skill counter at `:443-449` (reads from `minions` prop, not draft
  state — important for Task 6). New-minion form is the existing
  `NewMinionForm` (`:485-562`) toggled via a `showForm` boolean at
  `:435` and shown/hidden at `:463-480`.
- `src/pages/SyndicateEditorPage.tsx:564-657` — `MinionRow`. Local
  `useState` for `name`, `accent`, `description`, `skills`, `err`,
  `saved` at `:582-587`. `handleSave` at `:589-603`. Inputs at
  `:606-639`. Save/Delete row at `:642-655`.
- `src/pages/SyndicateEditorPage.tsx:660-722` — `SkillsField`. Datalist
  scoped via `useId()` at `:673`. Reused for both new-minion and
  existing-minion editing. Must keep working unchanged inside the
  colspan editor.
- `src/index.css:339-355` — `.section-grid` definitions; lines `:346-350`
  define the `@media (min-width: 900px)` two-column behaviour. After
  this change `.section-grid` has zero consumers and should be
  searched for via `grep -r section-grid src/` before removal (Task 12).
- `src/index.css:611-646` — global `<table>`, `th`, `td`, `tbody`
  zebra-striping rules. Reused as-is.
- `src/index.css:292-302` — `.card`, `.card.tight` definitions. The
  inline editor's outer wrapper stays a `.card.tight` so its 2px
  border, padding, and visual identity are inherited; the `<td>`
  that hosts it gets `padding: 0` to avoid border-compounding.
- `src/index.css:528-543` — `.stack`, `.row`, `.row-wrap` utilities.
  Reused for the inline editor body.
- `src/index.css:549-585` — `.badge` family. The new skill-chip
  visual is a `.badge` (or a new `.skill-chip` if Task 8 finds the
  default `.badge` size too large).
- `src/index.css:676-696` — `.read-only-banner` mint background.
  Note: this is the only place mint signals "frozen / read-only".
  Do **not** use mint to indicate the currently-editing row.
- `THEME.md:67-72` — geometry rules (zero radius, hard 2px borders,
  hard offset shadows). `THEME.md:222-223` — no Lucide icons, no
  emoji. All controls remain Archivo-Black uppercase text buttons.
- `THEME.md:129-133` — table styling expectations; the design
  inherits these for free.
- `convex/schema.ts` — `minions.skills` is `v.array(v.string())`;
  `minions.description` is `v.optional(v.string())`. `drawbacks.name`
  required, `drawbacks.description` required (unlike minions).
- `convex/minions.ts` — `MAX_UNIQUE_SYNDICATE_SKILLS = 13` (mirrored
  client-side at `SyndicateEditorPage.tsx:12`).
- No existing component in the codebase renders skills as visual
  chips outside an input; we introduce one in Task 8 and reuse it
  in both read-mode rows and the long-description-fallback row.

### Prioritised Challenges and Risks

1. **Highest — Inline editor card visually nesting inside a `<td>`.**
   The global `td { padding: 0.5rem 0.75rem; border-bottom: 2px
solid var(--border) }` rule (`src/index.css:619-623`) plus the
   `.card.tight` editor's own 2px border will produce a 4px doubled
   black perimeter if not addressed. Mitigation: a single targeted
   class on the editor `<td>` zeroing its padding and dropping its
   bottom border for the editor row. The editor's `.card.tight`
   inside it provides the visual frame. See Task 4.

2. **High — Zebra-striping interacts with the long-description
   second row (Design 2 fallback).** `tbody tr:nth-child(even/odd) td`
   at `src/index.css:636-642` strips by `<tr>` ordinal, so a
   two-row minion gets split across mint-muted and elevated
   backgrounds. Mitigation: render each minion inside its own
   `<tbody>` and rewrite the zebra rule (scoped via a new
   `.minion-table` class, **not** by overriding the global rule)
   so it alternates by `tbody`. See Task 8.

3. **High — `NewMinionForm` placement after the section-grid
   removal.** Today the form is a card toggled by `showForm`
   (`:463-480`) rendered after the list. In the new layout it
   should live in a `<tfoot>` row of the minions table, expanded
   via the same `colspan` mechanism as inline editing. Mitigation:
   reuse the `NewMinionForm` body unchanged; only its host
   container changes. Same applies to the new-drawback form
   (`:319-352`) which lives in the drawbacks table `<tfoot>`.

4. **Medium — Read-mode rendering of optional/empty fields.**
   - `minions.accent` is optional; render `<span class="muted">—</span>`
     in the Accent cell when absent.
   - `minions.description` is optional; when absent, omit the
     long-description second row entirely (do not render an empty
     `<tr>`).
   - `minions.skills` is required by the array validator but the
     server-side mutation strips empty strings; the read row
     renders 0 chips with a `muted` "no skills" caption. This case
     is rare because `convex/minions.ts` validates `1 <= length <= 5`
     on create/update.

5. **Medium — Per-row error / saved messages
   (`SyndicateEditorPage.tsx:640-641`, `:401`).** They live
   _inside_ the editor card today; in the new layout they remain
   inside the colspan editor and disappear naturally when the row
   reverts to read mode. The transient "Saved." text is acceptable
   to lose on exit because the underlying data is now visibly the
   new data. No toast needed.

6. **Medium — Counter visibility while editing
   (`SyndicateEditorPage.tsx:443-449`).** Today the counter is a
   `<div>` above the list and reads from saved `minions`. During
   editing of a single row the counter will not reflect the in-
   draft `skills`. Two options: (a) lift draft skills (rejected —
   contradicts the "no state lifting" win), (b) keep counter
   reading from saved data and accept the user only sees the
   updated count after Save. Decision: (b), but promote the
   counter into a `<caption>` element of the table so it stays
   visually anchored to the data it describes. Documented in
   Task 6.

7. **Medium — `canEdit === false` (read-only / frozen).** The
   Actions column and `<tfoot>` Add row must both disappear. The
   read rows themselves continue to render. The existing mint
   `.read-only-banner` (`SyndicateEditorPage.tsx:68-74`,
   `src/index.css:676-696`) already explains the state.

8. **Medium — Editing two rows at once.** Today nothing prevents
   editing all minions simultaneously (they're all always in
   "edit form" view). In the new design only one row at a time
   is in edit mode by virtue of the colspan swap. Policy: clicking
   `[EDIT]` on a second row while one is already being edited
   silently cancels the first (discarding unsaved drafts). This
   is acceptable because (a) there's no current cross-row context
   that would lose value, (b) `MinionRow` already has no Reset
   button so the cancel-equivalent is well-precedented, and (c)
   adding an "unsaved changes" prompt would inflate scope. See
   Task 5 for state ownership.

9. **Low — Mobile `<640px` degradation of a 5-column table.**
   The minions table is Name · Accent · Description-chips · Skills ·
   Actions = 5 columns. At narrow viewports horizontal scroll is
   acceptable for the table itself, and the colspan editor is
   already full-bleed during edit. Wrap each table in a
   `.table-scroll` container with `overflow-x: auto` so the
   horizontal scrollbar is contained to the table region, not the
   whole page. See Task 11.

10. **Low — Datalist `useId()` scoping
    (`SyndicateEditorPage.tsx:673`, `:243`).** `SkillsField` and the
    drawback-name preset list both use `useId()` for scoping. Both
    mount/unmount with their containing form (edit vs. read), so
    `useId` issues a fresh id per mount. No conflict between the
    new-minion form's datalist and an actively-edited minion's
    datalist because both are scoped instances.

## Assumptions

- **No backend changes.** All mutations, queries, schema, and Convex
  files are untouched. The plan modifies `src/pages/SyndicateEditorPage.tsx`
  and `src/index.css` only.
- **No state lifting.** The existing per-row `useState` pattern in
  `MinionRow` and `DrawbackRow` stays. The parent `MinionsEditor` /
  `DrawbacksEditor` gains one extra state `editingId: Id | null` so
  that clicking `[EDIT]` on row B while row A is open closes row A.
  The closing row's local draft state is destroyed by unmount; this
  is the documented policy.
- **Long-description threshold = 80 characters.** Minions with
  `description.length > 80` render the Design 2 two-row fallback
  (compact summary row + `colspan=4` description row). At ≤80
  characters the description fits inline in the table cell. The
  threshold is a single named constant
  (`LONG_DESCRIPTION_THRESHOLD = 80`) at the top of the file.
- **`.section-grid` is removed from CSS only if it has no other
  consumers.** Verify by grep (Task 12). If another page uses it,
  leave the CSS definition and only stop using the class in the
  syndicate editor.
- **Skill chips visual = a small `.badge`-like element with mono
  type and 2px border.** Reuses the existing palette tokens; new
  CSS class `.skill-chip` introduced in Task 8 if `.badge` proves
  too large or too dark at chip density.
- **No new dependencies.** No drag-and-drop, no chip-input library,
  no modal library. Pure React + CSS.
- **No new translation strings.** All UI text is English literals
  as today.
- **No accessibility regressions.** Editing is a DOM swap of one
  `<tr>` for another; tab order stays natural; no focus trap is
  needed. The first input of the new editor receives `autoFocus`
  on entry (small a11y win over today's "edit form is always
  there, no focus management" baseline).
- **Tests.** No existing tests cover `SyndicateEditorPage`. This
  change does not introduce backend tests because no backend logic
  changes. A new file `src/pages/SyndicateEditorPage.test.tsx` is
  **out of scope** in v1 to keep blast radius small — the component
  has no test infrastructure today and adding one would need a
  React Testing Library bring-up. Verification is via `typecheck`,
  `lint`, and a manual smoke test. Documented as the single
  acknowledged test debt.
- **Drawback-row symmetry.** Drawbacks have only `name` +
  `description`. Drawbacks table columns are Name · Description ·
  Actions = 3 columns. Long-description fallback applies the same
  way: descriptions over 80 chars get a second `colspan=2` row.
- **Status text on the syndicate core save** (`SyndicateEditorPage.tsx:187-190`)
  is unchanged. The `SyndicateCore` form at `:104-207` remains
  exactly as today, full-width above the two tables.

## Implementation Plan

### Layout

- [x] **Task 1. Replace the `section-grid` shell.** In
      `src/pages/SyndicateEditorPage.tsx:81-99`, replace the
      `<div className="section-grid">…</div>` block with a single-
      column `<div className="stack">` containing two `<section>`s in
      order: Drawbacks first, Minions second. The existing `<h3>`
      headings stay (`Drawbacks ({n}/5)` and `Minions ({n}/8)`).

  Rationale: stacks vertically with the existing `.stack`
  utility (`src/index.css:528-530`); no new layout CSS needed.

### Read-mode table — drawbacks

- [x] **Task 2. Convert `DrawbacksEditor` to a `<table>`.** Replace
      the list rendering at `SyndicateEditorPage.tsx:302-353` with a
      `<div className="table-scroll"><table className="drawback-table">`
      containing:
  - A `<caption>` showing the count badge (e.g. `2/5 drawbacks`)
    in `.muted` mono type.
  - `<thead><tr><th>Name</th><th>Description</th><th></th></tr></thead>`
    where the third (actions) `<th>` is empty-labelled but present
    for layout; if `!canEdit`, omit the actions column entirely
    (header included).
  - One `<tbody>` per drawback (NOT a single tbody containing all
    rows — needed for the long-description fallback in Task 7 and
    for `.minion-table`-style zebra stripping). Each `<tbody>` is
    keyed by `drawback._id`.
  - Inside each `<tbody>`, conditional rendering:
    - When `editingId !== d._id`: one or two read-mode `<tr>`s
      (Task 7 specifies the long-description fallback).
    - When `editingId === d._id`: a single edit `<tr>` with a
      `<td colSpan={canEdit ? 3 : 2}>` hosting the existing
      `DrawbackRow` edit form body. See Task 5 for state
      ownership; see Task 4 for the `<td>` styling.
  - A `<tfoot>` row hosting the new-drawback form (Task 3) when
    `canEdit && drawbacks.length < 5`.

  **Empty list state.** When `drawbacks.length === 0`, render a
  single placeholder `<tbody><tr><td colSpan={canEdit ? 3 : 2}
className="muted">No drawbacks yet.</td></tr></tbody>` in lieu of
  mapping. Do **not** omit the `<table>` entirely — the `<tfoot>`
  Add row still needs the table skeleton when `canEdit &&
drawbacks.length < 5`. Replaces today's `<div className="muted">
No drawbacks yet.</div>` at `SyndicateEditorPage.tsx:304-306`.

  Note on JSX casing: HTML's `colspan` attribute becomes `colSpan`
  in JSX (camelCase). All JSX code samples in this plan use
  `colSpan` with a number expression, never the lowercase string
  form, to avoid TypeScript / React warnings.

  Rationale: the existing read-mode display columns (Name,
  Description) match the existing form fields exactly, so the
  read row is a one-line mapping of `drawback.name` to a `<td>`
  with bold weight and `drawback.description` to a `<td>` with
  `white-space: pre-wrap`. Per-tbody structure prepares the
  ground for both the long-description fallback and the editor
  swap without DOM reshaping.

- [x] **Task 3. Convert the new-drawback form to a `<tfoot>` row.**
      The form currently at `SyndicateEditorPage.tsx:319-352` becomes
      the content of a `<tfoot><tr><td colSpan={canEdit ? 3 : 2}>`
      cell. The cell uses the same `editor-cell` class as Task 4
      (zero padding, no bottom border). The form's `<datalist>`
      autocomplete via `useId()` (`:243`) is preserved.

  Introduce a `showForm` boolean in `DrawbacksEditor` (mirroring
  the existing one in `MinionsEditor` at
  `SyndicateEditorPage.tsx:435`). The `<tfoot>` toggles between an
  `[Add Drawback]` button when `!showForm` and the form body when
  `showForm`. Today's drawback form is always rendered (no toggle);
  introducing `showForm` keeps the `<tfoot>` compact by default.

  The preset-prefill logic at `:264-275` is preserved verbatim
  (this is the user-facing "type a preset name, get its
  description filled in" behaviour and is unrelated to layout).

### Inline editor styling

- [x] **Task 4. Add a `.editor-cell` class for the colspan
      edit/footer cells.** In `src/index.css` (near the existing
      `<table>` block at `:611-646`):

  ```css
  td.editor-cell {
    padding: 0;
    vertical-align: top;
    background: var(--bg-elevated);
    border-bottom: 2px solid var(--border);
  }
  ```

  The cell hosts a `.card.tight` body (the existing edit form),
  which provides its own 2px border, padding, and visual frame.
  Zeroing the cell padding prevents 2px-compounding against the
  card's outer border. The `vertical-align: top` defends against
  `<td>`'s default `vertical-align: middle` if the editor cell
  ever ends up shorter than its siblings during a re-render.

  Inside the editor cell, wrap the form body in
  `<div className="card tight" style={{ margin: 0 }}>` so the
  default `.card.tight` `margin-bottom: 0.75rem` does not leave
  a visible gap inside the cell. (Or add `.card.flush` if
  preferred — `src/index.css:304-306`.)

  Rationale: minimum new CSS; uses the existing card vocabulary
  for the editor identity.

### State ownership of the editor

- [x] **Task 5. Lift `editingId` to `DrawbacksEditor` and
      `MinionsEditor`.** Each editor component gains
      `const [editingId, setEditingId] = useState<Id<"drawbacks"> | null>(null)`
      (and the equivalent `Id<"minions">` for minions).
  - A read-mode `[EDIT]` button calls `setEditingId(row._id)`.
  - The edit row's `[CANCEL]` button calls `setEditingId(null)`.
  - The edit row's `[SAVE]` handler awaits the existing
    `update(...)` mutation; on success it calls `setEditingId(null)`.
    On failure it leaves `editingId` set and surfaces the error
    via the row's local `err` state (unchanged from today).
  - The new-row form's submit handler is unchanged from today.
    The `<tfoot>` toggles between an `[Add Drawback]` /
    `[Add Minion]` button (when `!showForm`) and the form body
    (when `showForm`). Clicking `[Edit]` on a row sets `editingId`
    but does not touch `showForm`; the two surfaces (existing-row
    edit, new-row create) are orthogonal in state and only one of
    each can be open at a time. If the user has the new-row form
    open and clicks `[Edit]` on an existing row, both are visible
    (one in the `<tfoot>`, one in `<tbody>`). That is acceptable.
    `MinionsEditor` already owns `showForm` at
    `SyndicateEditorPage.tsx:435`. `DrawbacksEditor` does **not**
    today; Task 3 adds it.

  The existing `DrawbackRow` and `MinionRow` components are
  refactored in Task 10: the edit-form body is extracted into
  `DrawbackEditForm` and `MinionEditForm` sub-components which own
  their local draft `useState`. The parent table mounts the
  sub-component only when `editingId === row._id`, and supplies
  `key={row._id}` so React unmounts/remounts cleanly when
  `editingId` changes. No `useEffect` is required to reset draft
  state — fresh mount means fresh `useState` initialisers from
  the latest server props.

  Rationale: zero state lifting of the draft fields themselves;
  only the _which-row-is-editing_ identity is lifted. This keeps
  the diff small.

### Read-mode table — minions

- [x] **Task 6. Convert `MinionsEditor` to a `<table>` and promote
      the unique-skill counter into the table's `<caption>`.** Mirror
      Task 2 for minions: wrap in `<div className="table-scroll">
    <table className="minion-table">`, with these columns when
    `canEdit`: **Name · Accent · Description · Skills · Actions** (5
    cols); omit Actions when `!canEdit` (4 cols).

  Structure:
  - A `<caption>` containing the unique-skill counter (replaces the
    `<div>` at `SyndicateEditorPage.tsx:443-449`). Update the JSX:
    drop the inline `style={{ color: overCap ? "var(--danger)" :
undefined }}` at `:445` and instead apply `className={overCap ?
"over-cap" : undefined}` on the `<strong>`. The CSS below
    handles the danger colour, keeping theme decisions in CSS.
  - `<thead>` with the five (or four) column headers.
  - One `<tbody>` per minion, keyed by `minion._id`. Empty-list
    state: when `minions.length === 0`, render a single placeholder
    `<tbody><tr><td colSpan={canEdit ? 5 : 4} className="muted">No
Minions yet.</td></tr></tbody>` in lieu of mapping. Replaces
    today's `<div className="muted">No Minions yet.</div>` at
    `SyndicateEditorPage.tsx:450-452`.
  - Inside each `<tbody>`, conditional rendering identical to Task
    2's drawback structure: read-mode rows when `editingId !==
m._id`, a single edit `<tr>` with `<td className="editor-cell"
colSpan={canEdit ? 5 : 4}>` when `editingId === m._id`.
  - A `<tfoot>` row hosting the existing `NewMinionForm`
    (`SyndicateEditorPage.tsx:485-562`) via the existing
    `showForm` toggle at `:435`. Uses the same `editor-cell`
    class.

  Caption styling:

  ```css
  .minion-table caption,
  .drawback-table caption {
    text-align: left;
    padding: 0.5rem 0.75rem;
    background: var(--bg);
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border: 2px solid var(--border);
    border-bottom: none;
    caption-side: top;
  }
  .minion-table caption strong,
  .drawback-table caption strong {
    font-family: var(--font-mono);
    color: var(--fg);
  }
  .minion-table caption strong.over-cap {
    color: var(--danger);
  }
  ```

  (The drawback table's caption shows just the `N/5 drawbacks` count
  per Task 2; the `.over-cap` rule only applies to minions.)

  The counter continues to read from saved `minions` data
  (`minions.map(m => m.skills)`), not from drafts. While editing
  one minion, the counter will not reflect the unsaved skills
  delta — that is documented in Risk 6 above and is acceptable
  because the user sees the updated count immediately after
  Save and the cap is enforced server-side anyway.

### Long-description fallback

- [x] **Task 7. Two-row layout for long descriptions.** Define a
      module-level constant
      `const LONG_DESCRIPTION_THRESHOLD = 80` near the top of the
      file. Inside the read-mode rendering of each minion `<tbody>`:

  ```tsx
  const longDesc =
    (m.description ?? "").trim().length > LONG_DESCRIPTION_THRESHOLD;
  if (!longDesc) {
    // single-row render: Name · Accent · DescriptionInline ·
    // SkillChips · Actions
  } else {
    // two-row render:
    //   <tr> Name · Accent · <td/> (empty; description renders below) ·
    //        SkillChips · Actions </tr>
    //   <tr className="description-row">
    //     <td colSpan={canEdit ? 5 : 4}>{description}</td>
    //   </tr>
  }
  ```

  Both rows are always rendered together — there is no expansion
  affordance. The empty description cell in row A is intentional;
  the user reads the description from row B below, which is
  visible at all times.

  The same pattern applies to drawbacks (single row when
  `description.trim().length <= 80`, two rows otherwise;
  `colSpan` is `canEdit ? 3 : 2`).

  CSS additions:

  ```css
  tr.description-row td {
    /* Wraps long prose without competing with the chip column. */
    padding: 0.25rem 0.75rem 0.75rem;
    color: var(--fg);
    white-space: pre-wrap;
  }
  ```

  Rationale: keeps the single-row table the default visual but
  gives long descriptions room to breathe without breaking the
  chip column's compactness. No expansion affordance — both
  rows are always present and visible together.

### Skill chips

- [x] **Task 8. Skill chip read-mode rendering.** Add a small
      `.skill-chip` CSS class (mono, 2px border, tight padding):

  ```css
  .skill-chip {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
    padding: 0.0625rem 0.375rem;
    background: var(--bg-elevated);
    color: var(--fg);
    border: 2px solid var(--border);
  }
  .skill-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  ```

  Using `gap` on a `.skill-chip-list` container (instead of margins
  on each chip) avoids the first-vs-subsequent margin asymmetry
  that adjacent-sibling margin selectors produce after wrap. In
  React: render each `m.skills[i]` (after `.trim()` and
  empty-filter) as `<span className="skill-chip" key={i}>{s}</span>`
  inside `<div className="skill-chip-list">…</div>`. If a minion
  has zero skills (rare — `convex/minions.ts` enforces `1 ≤ length
≤ 5` at the schema level; this defence-in-depth handles rows
  predating the validator or in-flight reads), render `<span
className="muted">no skills</span>` instead of the chip list.

  Per-minion `<tbody>` zebra rule (replaces global zebra inside
  the new tables):

  ```css
  table.minion-table > tbody:nth-child(odd) > tr > td {
    background: var(--bg-elevated);
  }
  table.minion-table > tbody:nth-child(even) > tr > td {
    background: var(--bg-muted);
  }
  table.minion-table > tbody.editing > tr > td {
    background: var(--bg-elevated);
  }
  ```

  Same pattern for `table.drawback-table`. The `editing` class
  is applied to the `<tbody>` whose row is currently being
  edited so the editor area visually pops above the banded
  reads.

  Note on `<thead>`/`<tfoot>` indexing: `:nth-child(odd|even)`
  on `<tbody>` elements counts among siblings of the `<table>`,
  which include `<caption>`, `<thead>`, `<tfoot>`. Mitigation:
  scope via `:nth-of-type(odd|even)` instead of `:nth-child` so
  the index is among `<tbody>` siblings specifically. Concretely:

  ```css
  table.minion-table > tbody:nth-of-type(odd) > tr > td {
    background: var(--bg-elevated);
  }
  table.minion-table > tbody:nth-of-type(even) > tr > td {
    background: var(--bg-muted);
  }
  ```

  **Critical: restore inter-tbody separators.** The global rule at
  `src/index.css:644-646` (`tbody tr:last-child td { border-bottom:
none }`) strips the bottom border from the final row of **every**
  `<tbody>`. Under the per-minion-`<tbody>` structure this removes
  the 2px row divider between adjacent minions — the table's most
  distinctive brutalist feature. Override:

  ```css
  table.minion-table > tbody:not(:last-of-type) > tr:last-child > td,
  table.drawback-table > tbody:not(:last-of-type) > tr:last-child > td {
    border-bottom: 2px solid var(--border);
  }
  ```

  This leaves the final tbody's bottom border stripped (so the
  table's outer 2px border is the only bottom edge), matching the
  existing brutalist table look. Without this override, adjacent
  minions are visually fused into one blob.

  Verify visually that zebra alternation and inter-tbody separators
  both work in the manual smoke test (Task 13).

### Action buttons

- [x] **Task 9. Read-row Actions cell.** Each read-mode row
      renders its Actions cell as:

  ```tsx
  <td className="actions">
    <div className="row-wrap" style={{ gap: "0.5rem" }}>
      <button type="button" onClick={() => setEditingId(d._id)}>
        Edit
      </button>
      <button
        type="button"
        className="danger"
        onClick={() => void remove({ ... })}
      >
        Delete
      </button>
    </div>
  </td>
  ```

  When `!canEdit`, the entire Actions column is omitted (both
  `<th>` and `<td>`), and the table's `colspan` math (Task 7)
  shifts by one. Wrap the actions in a `<div className="row-wrap">`
  if the buttons risk wrapping ugly inside the cell at narrow
  widths. All buttons remain text-only per `THEME.md:222-223`.

  The existing `Delete` semantics are preserved (no confirm
  dialog; today's `MinionRow` and `DrawbackRow` also have none).
  If a confirm is desired it can be added in a follow-up.

### Edit-row contents

- [x] **Task 10. Edit-row body.** Refactor `DrawbackRow` and
      `MinionRow` so the _edit form body_ (everything currently
      inside their `<div className="card tight stack">` return — see
      `:381-417` and `:605-657`) becomes a sub-component:
  - `DrawbackEditForm({ drawback, onCancel, onSave, onDelete })`
  - `MinionEditForm({ minion, presetSkillNames, onCancel, onSave, onDelete })`

  Each sub-component owns its local draft state via `useState`,
  exactly as today. The Save button label is unchanged (`Save`).
  A new `Cancel` button calls `onCancel()`. The Delete button
  retains its `className="danger"` and existing behaviour.

  **Try/catch preserved.** Both sub-components keep the existing
  pattern (today at `SyndicateEditorPage.tsx:589-603` for
  `MinionRow.handleSave` and `:372-379` for
  `DrawbackRow.handleSave`): a `try { await onSave(...) ... }
catch (e) { setErr(...) }` wrapping the parent-supplied
  `onSave`. This is what populates the row's local `err` state
  when a mutation rejects. The `Saved.` indicator is shown via
  local `saved` state and disappears naturally when the editor
  unmounts on Save success.

  **`autoFocus` on first input.** The Name `<input>` inside each
  sub-component receives `autoFocus`. This fulfils the Assumption
  about focus management and gives screen-reader users an audible
  signal ("Name, edit text, [current value]") when edit mode
  opens.

  In the parent table, the colspan editor `<tr>` renders:

  ```tsx
  <tr aria-label={`Edit minion: ${m.name}`}>
    <td className="editor-cell" colSpan={canEdit ? 5 : 4}>
      <MinionEditForm
        key={m._id}
        minion={m}
        presetSkillNames={presetNames}
        onCancel={() => setEditingId(null)}
        onSave={async (patch) => {
          await update({ minionId: m._id, ...patch });
          setEditingId(null);
        }}
        onDelete={async () => {
          await remove({ minionId: m._id });
          setEditingId(null);
        }}
      />
    </td>
  </tr>
  ```

  The drawback equivalent uses `aria-label={`Edit drawback:
  ${d.name}`}` and `colSpan={canEdit ? 3 : 2}`.

  The `key={m._id}` is belt-and-braces (the editor only mounts
  when `editingId === m._id`, so a different minion's edit
  naturally unmounts the prior instance), but harmless and makes
  the remount-on-selection-change pattern explicit.

  Delete-while-editing behaviour: after `await remove({ minionId:
m._id })`, the next `useQuery` tick removes `m` from
  `data.minions`, so the entire `<tbody>` (including the editor)
  unmounts naturally on the next render. `setEditingId(null)` is
  belt-and-braces. If `remove` throws, `setEditingId(null)`
  doesn't run, the editor stays open, and the row's `err` state
  surfaces the error. No stale-id render observed.

  Rationale: the existing inputs, labels, validation, error
  rendering, and Saved indicator stay verbatim; only the
  surrounding `<div className="card tight stack">` becomes a
  reused sub-component instead of a per-row return value.

### Mobile / overflow

- [x] **Task 11. Wrap each table in a `.table-scroll` container.**

  ```css
  .table-scroll {
    overflow-x: auto;
    /* Hard-edged scroll boundary, no rounding. */
    border: 0;
  }
  .table-scroll > table {
    /* Ensure the table doesn't collapse below the sum of column
       minima at narrow viewports. */
    min-width: 640px;
  }
  ```

  This contains horizontal scroll to the table region instead of
  the whole page. The colspan editor inside the table is still
  full-bleed (`width: 100%` is intrinsic to `<td colspan>`) and
  scrolls horizontally with the rest if the viewport is below
  the min-width.

### CSS cleanup

- [x] **Task 12. Audit and remove `.section-grid` if unused.**
      Run `grep -r "section-grid" src/` (use `fs_search` with
      `pattern: section-grid` and `output_mode: files_with_matches`).
      If `src/pages/SyndicateEditorPage.tsx` is the only consumer
      after Task 1, delete the rule block at `src/index.css:333-360`
      (the comment, the base rule, the media query, and the two
      child-targeting rules). If any other file uses it, leave the
      CSS intact and merely stop using it in this page.

### Verification

- [ ] **Task 13. Manual smoke test.** (DEFERRED — manual browser step; user's responsibility) From a fresh `npm run dev:all`:
  1. Create a syndicate with 8 minions (some with short
     descriptions, some with descriptions >80 chars, some with
     5 skills, some with 1 skill, one with no description, one
     with no accent). Verify all 8 are visible without
     scrolling on a 1080p browser.
  2. Click `[EDIT]` on minion #3. Verify only its row swaps to
     the editor form; other rows stay read-only and visible.
  3. While #3 is in edit, click `[EDIT]` on minion #5. Verify
     #3 closes (draft discarded) and #5 enters edit.
  4. Click `[CANCEL]` on #5. Verify the read row returns with
     the original values.
  5. Edit minion #1 and Save. Verify the row returns to read
     mode showing the new values and the counter caption
     updates.
  6. Click `[ADD MINION]` in the `<tfoot>`. Verify the new-row
     form expands inline and another row's `[EDIT]` is still
     clickable (orthogonal state per Task 5).
  7. Repeat steps 1–6 for drawbacks.
  8. View the same syndicate as a non-owner (or as the owner
     after the syndicate is played/frozen). Verify the Actions
     column disappears, the `<tfoot>` Add row disappears, and
     the mint read-only banner still shows at the top of the
     page.
  9. View on a 360px-wide viewport. Verify the table scrolls
     horizontally inside its `.table-scroll` container and the
     page itself does not scroll horizontally.
  10. Click into the second skill input of a minion in edit
      mode; verify the `<datalist>` autocomplete still shows
      preset skill names.
  11. Tab through a row in edit mode; verify focus order is
      Name input → Accent input → Description textarea → skill
      1 input → Remove (if shown) → skill 2 input → … → Add
      Skill (if `skills.length < 5`) → Save → Cancel → Delete.
      The `SkillsField` Remove and Add Skill buttons must appear
      in the natural tab flow.
  12. Open the editor on minion #2 and click `[Delete]` from
      inside the editor. Verify the row vanishes, the table
      re-renders without errors, and no React console warning
      fires about a stale id.
  13. View the syndicate with zero minions and zero drawbacks.
      Verify each table renders a single "No X yet" placeholder
      row spanning all columns, the `<thead>` is still visible,
      and the `<tfoot>` Add affordance is still reachable.
  14. With 4 minions and no editor open, verify zebra
      alternation: 1st and 3rd tbodies use `--bg-elevated`, 2nd
      and 4th use `--bg-muted`. With a long-description minion
      in slot 2, both rows of that tbody share the same band.
      Verify a 2px black row divider is visible between every
      pair of adjacent minions (no "fused blob" effect from the
      `tbody tr:last-child` border-strip rule).

- [x] **Task 14. Run `npm run typecheck`** and confirm zero TS
      errors. Common slip points: the new `editingId` state type
      (`Id<"minions"> | null` vs `string | null`), the new prop
      types on `DrawbackRow` and `MinionRow`, and the `colSpan`
      attribute (camelCase in JSX, accepts a `number`, not a
      string).

- [x] **Task 15. Run `npm run lint`** and confirm zero ESLint
      errors. Confirm the existing `eslint-plugin-react-hooks`
      rules pass with the new component split (no `useState`
      inside conditionals, no `useEffect` dependency-array gaps).

- [x] **Task 16. Run `npm test`** and confirm the existing
      vitest suite still passes. No new tests are added in v1
      (acknowledged debt in Assumptions).

- [x] **Task 17. Run `npm run format`** to apply Prettier to any
      changed files. No new format rules are introduced.

## Verification Criteria

- The page no longer uses `.section-grid` for its body layout.
- Drawbacks and Minions each render as a single `<table>` with
  the brutalist styling inherited from `src/index.css:611-646`.
- Every drawback's name + description and every minion's name +
  accent + description + all skills are visible at once in the
  default read view, without any expand/select action required.
- Minions with `description.length > 80` render as two `<tr>`s
  (compact summary + `colspan` description row); minions at or
  below the threshold render as a single `<tr>`.
- Clicking `[EDIT]` on a row replaces that one `<tr>` with a
  single `<tr><td colspan>` containing the full edit form
  (name, accent, description textarea, `SkillsField`, Save,
  Cancel, Delete, error / saved indicators). All other rows
  remain in read mode and visible.
- Clicking `[CANCEL]` on the active editor returns the row to
  read mode with its original (pre-edit) values; clicking
  `[EDIT]` on another row also returns the first row to read
  mode without saving.
- Clicking `[SAVE]` on the active editor commits via the
  existing mutation, returns the row to read mode, and reflects
  the new values immediately.
- The unique-skill counter lives in a `<caption>` element on the
  minions table and remains visible while editing.
- The `<tfoot>` of each table hosts the new-row creation form
  via the existing `NewMinionForm` / new-drawback `<form>`,
  toggled by the existing `showForm` state (drawbacks) / its
  equivalent (minions).
- When `canEdit === false`: the Actions column is fully omitted
  (header and cells), the `<tfoot>` Add row is omitted, and the
  mint `.read-only-banner` continues to render at the page
  level.
- The colspan editor `<td>` has zero padding and hosts a
  `.card.tight` wrapper, so no 4px-doubled border is visible at
  the editor cell perimeter.
- Skill values render as `.skill-chip` elements in the read row;
  long chip lists wrap naturally within the cell.
- All preset autocomplete behaviour from the current code is
  preserved: drawback-name `<datalist>` and `SkillsField`
  datalist both keep working when their hosting form is mounted
  (i.e., during edit or new-row creation).
- The preset-prefill description behaviour from
  `SyndicateEditorPage.tsx:264-275` is preserved verbatim.
- All buttons are Archivo-Black uppercase text — no Lucide
  icons, no emoji, no glyphs.
- Mint (`--accent`) is not used as a "currently editing" row
  highlight; the editing row is identified solely by the
  presence of the editor card in the colspan cell.
- At ≤ 640px viewport widths, each table scrolls horizontally
  inside a `.table-scroll` wrapper; the page itself does not
  develop a horizontal scrollbar from the tables.
- `npm run typecheck`, `npm run lint`, and `npm test` all pass
  unchanged from before this work (plus or minus the test debt
  noted in Assumptions).

## Potential Risks and Mitigations

1. **`<td colspan>` editor body styling regressions.**
   The existing `MinionRow` / `DrawbackRow` edit-form body is
   battle-tested as a top-level `.card.tight` inside a regular
   page flow; placing it inside a `<td>` may interact with
   `td`'s default `vertical-align: middle` and the global
   `td { padding }` rule. Mitigation: explicit `.editor-cell`
   class (Task 4) zeros padding and sets `vertical-align: top`
   if needed. Confirm visually in the smoke test that the form
   does not vertically center its content inside an over-tall
   cell.

2. **Zebra-stripe scoping with `<caption>` / `<thead>` / `<tfoot>`
   siblings.** `:nth-child` would miscount; `:nth-of-type` on
   `<tbody>` is the correct selector (Task 8). Mitigation: use
   `:nth-of-type(odd|even)` and verify in the smoke test that
   the first minion `<tbody>` is `--bg-elevated` and the
   second is `--bg-muted` etc.

3. **CRITICAL: Inter-tbody separator stripped by global
   `tbody tr:last-child td { border-bottom: none }` rule
   (`src/index.css:644-646`).** Without an override, the
   per-minion-`<tbody>` structure loses its visual row dividers
   between minions — adjacent rows fuse into one blob. Mitigation:
   a scoped `:not(:last-of-type) > tr:last-child > td` rule on
   `.minion-table` and `.drawback-table` restoring the 2px bottom
   border. See Task 8 (the "Critical: restore inter-tbody
   separators" block).

4. **`useId()` datalist collisions when both new-row form AND
   inline editor are open simultaneously.** With the orthogonal-
   state policy in Task 5 this can happen for both drawbacks and
   minions. Mitigation: `useId()` issues a per-instance id; each
   form has its own scope. Verified by inspection at
   `SyndicateEditorPage.tsx:673` (`SkillsField`) and `:243`
   (drawback preset list).

5. **Counter shows stale skill count during edit.** Documented
   in Risk 6 of Initial Assessment. Mitigation: the counter
   caption explicitly reads from saved data; the cap is enforced
   server-side at save time anyway, so the worst case is a Save
   attempt that throws with the cap-error message from
   `convex/minions.ts` — which the existing `err` state already
   surfaces.

6. **Closing an editor mid-typing loses the draft.** This is the
   stated policy (Risk / Challenge 8 in Initial Assessment).
   Mitigation: documented. If users complain, a v2 can add a
   confirm-on-close prompt or persist drafts in a `Map<Id,
DraftMinion>` at the editor parent.

7. **Description in a single read cell wraps onto many lines for
   long prose.** Mitigated by the long-description fallback at
   80 characters (Task 7) — anything over 80 gets its own
   colspan row with full prose width.

8. **Horizontal scroll inside `.table-scroll` at narrow
   viewports.** Acceptable but worth verifying that scrollbar
   styling matches the brutalist theme (i.e., the default
   browser scrollbar is OK; no rounded scrollbar custom CSS
   is introduced). Mitigation: smoke test step 9.

9. **`section-grid` removed from CSS but referenced by another
   page.** Mitigated by Task 12 (grep first). If found, the
   CSS block is preserved.

10. **A user with very long skill names produces a wrapping chip
    pile that pushes row height unpredictably.** Acceptable —
    chips wrap inside their cell via `.skill-chip-list` flex-wrap.
    No truncation, no hover-to-expand (would violate the "all
    info visible by default" constraint).

11. **Mint `.read-only-banner` (`src/index.css:676-696`) collides
    with mint button fill at the editor's Save button.** No
    collision in practice because the banner is page-scoped and
    the editor is row-scoped; visually they don't overlap. Worth
    confirming during smoke test that they don't visually fight
    when both are on screen.

## Alternative Approaches

1. **Design 2 — pure two-row-per-minion table.** Every minion
   always renders Row A + Row B regardless of description
   length. Trade-offs: more uniform DOM (no conditional row
   shape), but minions with short or no description render
   either an empty second row or a placeholder. Rejected: the
   hybrid Design 4 + Design 2-fallback is the better default
   because the single-row case is more compact for short
   descriptions (a common case) and the two-row case is
   reserved for content that actually needs the space.

2. **Design 3 — side-drawer editor instead of in-row colspan
   swap.** Trade-offs: stronger edit-mode focus identity, reuses
   the existing `.drawer` class at `src/index.css:737-830`,
   but requires lifting all draft state to the page level (the
   drawer is page-scoped, not row-scoped), introduces a focus
   trap and Escape-to-close behaviour, and needs return-focus-
   to-trigger plumbing. Rejected: too much new product surface
   for 8 rows, and contradicts the user's table-style
   preference for the read surface itself.

3. **Design 5 — CSS Grid rows + modal editor.** Trade-offs:
   most flexible column sizing for skill chips, but loses
   native `<table>` semantics and `<table>` styling reuse,
   plus the codebase has no `.modal` class today (only
   `.drawer`). Rejected: gratuitous reinvention.

4. **Keep two-column layout but tighten the right (minions)
   column.** Trade-offs: smallest diff, but doesn't solve the
   density problem — drawbacks still get half the width when
   they need a fraction of it. Rejected: the user explicitly
   asked to remove the two-column layout.

5. **Add a "chip-input" component for editing skills (replace
   the 5 stacked text inputs in `SkillsField` with a chip
   cluster).** Trade-offs: more compact edit form, fewer
   visible inputs, but new keyboard semantics (Enter to add,
   Backspace to remove last, focus management) and a new
   component to maintain. Rejected for v1: out of scope; the
   `SkillsField` stays as is. A future v2 can revisit if users
   find the 5-input stack noisy.

6. **Auto-save on input blur (no Save button).** Trade-offs:
   removes one click per edit, but introduces network-chatter
   semantics, makes Cancel undefined ("cancel what — there's
   no draft"), and conflicts with the existing
   `update(...)`-on-Save mutation contract. Rejected.

7. **Confirmation modal before Delete.** Trade-offs: prevents
   accidental destructive clicks, but the current code has no
   delete confirmation and this plan is meant to be a layout
   refactor only. Documented as a follow-up.

8. **Render the new-row form as an always-visible final
   `<tbody>` rather than a `<tfoot>`-gated toggle.** Trade-offs:
   one fewer click to add a row, but the table always shows a
   half-empty form row even when the user is just browsing.
   Rejected: violates the "minimal whitespace by default"
   spirit even though it's strictly within the constraint.
