# Notes on Grants and Goals

## Objective

Extend the existing **notes** feature so any authenticated game
participant (GM or Player) can also attach textual notes to:

- a specific **Treason Grant** (`treasonGrants` row) in the game, and
- a specific **Goal** (`goals` row) in the game.

All existing semantics from
`plans/2026-04-20-notes-feature-v3.md:1-151` (game-scoped, immutable
once posted, GM-only delete, `private`/`public` visibility, newest-
first ordering, popover UI, single shared counts subscription) apply
verbatim to the two new targets. The change is strictly additive: the
`game` / `syndicate` / `minion` targets keep their current wire format
and UI placement.

The note body itself is independent of the grant/goal description
redaction model — a Player may see a `public` note on a grant whose
description is redacted for them. This is intentional: the note is the
author's own annotation, not a re-publication of the entity body.

## Project Structure Summary

- Convex backend: `convex/schema.ts:265-324` (`notes` table) plus the
  two referenced tables `convex/schema.ts:326-347` (`treasonGrants`)
  and `convex/schema.ts:380-422` (`goals`). All note logic lives in
  `convex/notes.ts:1-826`; grants in `convex/treasonGrants.ts:1-397`;
  goals in `convex/goals.ts:1-620`.
- React client: `src/components/NoteIcon.tsx:1-586` defines the
  shared `NoteTarget` union, the `<NoteIcon>` button, the
  `<NotesPopover>`, the layout-agnostic `<NoteList>` /
  `<NoteCreateForm>`, and the `buildListArgs` helper. The badge-count
  hook lives in `src/hooks/useNotesCountMap.ts:1-41`. Page integration
  is in `src/pages/GameDetailPage.tsx:1-4283` — the relevant
  rows are `TreasonGrantRow` at `src/pages/GameDetailPage.tsx:2644-2823`
  and `GoalRowView` (rendered from `GoalsSection` at
  `src/pages/GameDetailPage.tsx:3464-3526`). The GM Todo drawer that
  consumes timer-bearing notes is at
  `src/components/GmTodoDrawer.tsx:1-203`.
- Authoritative rules live in `plans/2026-04-20-init-v4.md`. The
  visibility rule for notes (Rule 24 / Rule 23) is unchanged. Rule 26
  (Treason Grants) and Rule 28 (Goals) constrain how the parent rows
  may be edited but say nothing about annotations — notes are
  additive.

## Relevant Files Examination

- `convex/schema.ts:290-324` — `notes` table. New optional id columns
  + extended `targetKind` union + two new compound indexes here.
- `convex/notes.ts:94-241` — `createNote` mutation. Target-consistency
  and target-existence branches extend with `grant` / `goal`.
- `convex/notes.ts:619-740` — `listNotesForTarget` query. New
  `grant` / `goal` branches reading the two new compound indexes.
- `convex/notes.ts:747-784` — `getNoteCountsForGameView`. Returns two
  more dictionaries (`byGrant`, `byGoal`) for the badge counts.
- `convex/notes.ts:301-331` — `getTimerCreateContext`. Argument shape
  extends with the new target kinds; `timerEligible` is always
  `false` for them (timers stay tied to head-call minions in v1 UI).
- `convex/notes.ts:438-617` — `listGameNotesWithTimers` (GM Todo). Add
  grant / goal projection: `grantKeyword` and `goalKeyword`, plus the
  matching `targetGrantId` / `targetGoalId` fields on `GmTodoNoteRow`.
- `convex/notes.ts:786-826` — `assertSyndicateVisibleInGame`. Reused
  pattern for the new `assertGrantVisibleInGame` /
  `assertGoalVisibleInGame` helpers (or inlined trivially: any
  participant can author on any grant/goal in their game; we only
  need to assert the entity belongs to this game).
- `convex/treasonGrants.ts:200-208` — `deleteGrant`. Add note cascade
  before deleting the grant row. Mirrors
  `convex/minions.ts:194-199`.
- `convex/goals.ts:458-466` — `deleteGoal`. Add note cascade. Same
  pattern.
- `src/components/NoteIcon.tsx:14-17` — `NoteTarget` union. Extends
  with two new shapes.
- `src/components/NoteIcon.tsx:135-156` and `:148-156` (popover query
  + `getTimerCreateContext` invocation) — query argument shape needs
  to thread the new target ids.
- `src/components/NoteIcon.tsx:468-494` — `NoteCreateForm.submit`
  must pass the right id key (`targetGrantId` / `targetGoalId`).
- `src/components/NoteIcon.tsx:570-586` — `buildListArgs` extends
  with two new branches.
- `src/hooks/useNotesCountMap.ts:22-41` — `resolveNoteCount` extends
  with two new branches.
- `src/pages/GameDetailPage.tsx:2720-2752` — header span inside
  `TreasonGrantRow`. New `<NoteIcon target={{kind: "grant", …}} />`
  drops in next to the keyword strong tag.
- `src/pages/GameDetailPage.tsx:3772-3825` — header span inside
  `GoalRowView`. New `<NoteIcon target={{kind: "goal", …}} />` drops
  in next to the keyword strong tag.
- `src/pages/GameDetailPage.tsx:2477-2496` and `:3464-3481` — the
  section-level `useQuery(api.{treasonGrants,goals}.list*ForGame)`
  results already deliver `_id` for every row, so the icon can be
  attached without any extra subscription. The shared count map
  (`useNotesCountMap`) is already plumbed through `GameDetailPage`
  via the `noteCounts` prop; we propagate it into both sections.
- `src/components/GmTodoDrawer.tsx:170-203` — `formatGmTodoTarget`
  extends with two new branches that render the joined keyword.

## Design Decisions & Assumptions

1. **Discriminator extension, not a parallel table.** Add `"grant"`
   and `"goal"` to the existing `targetKind` union and two optional
   id columns (`targetGrantId`, `targetGoalId`). Reuses every
   visibility / immutability / cascade rule already proven in
   `convex/notes.ts:85-92` and the existing test fixtures. Rejected
   alternative: dedicated `grantNotes` / `goalNotes` tables — see
   Alternative #1.
2. **Indexed listings.** Add two compound indexes parallel to
   `by_game_syndicate_created` / `by_game_minion_created`:
   - `by_game_grant_created` on `(gameId, targetGrantId, createdAt)`
   - `by_game_goal_created` on `(gameId, targetGoalId, createdAt)`
     so `listNotesForTarget` keeps the same shape — index walk +
     `.order("desc")`, no `filter()` (Convex guideline).
3. **Cascade indexes.** Add single-column `by_grant` on
   `(targetGrantId)` and `by_goal` on `(targetGoalId)` to mirror the
   existing `by_syndicate` / `by_minion` indexes used by the cascade
   passes in `convex/minions.ts:194-199` and the syndicate cascade
   (see `convex/syndicates.ts` for the pattern).
4. **Authoring eligibility.** Any GM or Player participant of the
   game may author a note on any grant or goal that belongs to the
   game. We do NOT gate authoring on grant ownership or goal from/to
   assignment — a Player can post a note on a grant they cannot take,
   or on a goal addressed to someone else, in exactly the same way
   they can post a note on another Player's selected syndicate today.
   Cross-game ids are rejected by an explicit `gameId` equality check
   (the parent row's `gameId` must equal `args.gameId`).
5. **Visibility independence.** The note body is independent of the
   parent row's redaction rules. A `public` note on a grant whose
   description is redacted for the viewer is still fully readable.
   Rationale: the note is the author's own annotation, not a
   re-publication of the entity body. The redaction-on-description
   rule in `convex/treasonGrants.ts:329` and
   `convex/goals.ts:547-589` is unchanged.
6. **Timers (v1 UI gating).** The server already accepts a timer on
   any GM-authored note (see `convex/notes.ts:200-226` and the GM
   Todo drawer plan
   `plans/2026-04-28-gm-todo-drawer-v1.md`). For grant/goal targets
   we keep the existing UX rule: `getTimerCreateContext` returns
   `timerEligible: false`, so the popover never renders duration
   buttons for them. The GM Todo drawer DOES render any
   grant/goal-target timer-bearing notes if they appear (server side
   doesn't reject them); v1 simply doesn't surface a UI to create
   such notes. This keeps the wire format stable and leaves room for
   a future opt-in.
7. **Cascade on grant/goal delete.** Mirrors the existing minion
   cascade (`convex/minions.ts:194-199`). When the GM deletes a
   grant or a goal, every note targeting it is deleted in the same
   mutation. There is no soft-delete: the parent row is already
   destroyed by the time the cascade runs, so dangling notes would
   refer to nothing.
8. **No cascade on `clearGrantOwner` / `clearToPlayer`.** Clearing
   ownership doesn't delete the parent row, so the notes survive.
   This matches the rule-26 design where POWER already paid out is
   not refunded (`convex/treasonGrants.ts:32-35`).
9. **Counts payload extension.** `getNoteCountsForGameView` gains
   two more dictionaries: `byGrant: Record<Id<"treasonGrants">, number>`
   and `byGoal: Record<Id<"goals">, number>`. Existing callers ignore
   them; new callers read them via `resolveNoteCount`.
10. **`buildListArgs` and the popover.** The popover's `targetKind`
    is the single dispatcher for both the list query and the timer-
    context query. We extend both call-sites uniformly so the
    popover code stays target-kind-agnostic.
11. **`listGameNotesWithTimers` projection.** Add `targetGrantId?` /
    `targetGoalId?` and `grantKeyword?` / `goalKeyword?` to the
    `GmTodoNoteRow` shape. Resolve in bulk via the same dedup
    pattern used for minions / syndicates. Players never see this
    payload (GM-only).
12. **`formatGmTodoTarget` branches.** Add `"grant"` →
    `<keyword> • <player? unassigned>` (grants carry an owner) and
    `"goal"` → `<keyword> • <fromName? unassigned>` (goals carry a
    from-player; we surface the from-player as the "owner-ish"
    handle for context, since the description redaction in goals is
    governed by from + to). Empty/unset slots render as
    `(unassigned)` (muted) just like minion-target rows.
13. **No new permissions.** `requireGameParticipant` already covers
    every authoring path. Cascade runs through the existing
    `deleteGrant` / `deleteGoal` GM-only gates.
14. **Icon placement.** One `<NoteIcon>` per grant row and per goal
    row, sized identically to the existing icons in the roster and
    minion-buy panel. Placed inline next to the keyword inside the
    existing left-side `row-wrap` span so they participate in the
    same wrap behaviour on narrow viewports.

## Implementation Plan

### Phase 1 — Schema

- [ ] Task 1. Extend `notes.targetKind` in `convex/schema.ts:292-296`
      to `v.union(v.literal("game"), v.literal("syndicate"),
      v.literal("minion"), v.literal("grant"), v.literal("goal"))`.
      Add `targetGrantId: v.optional(v.id("treasonGrants"))` and
      `targetGoalId: v.optional(v.id("goals"))` to the column list at
      `convex/schema.ts:297-298`. Update the table docstring at
      `convex/schema.ts:265-289` to mention grants and goals.
      Rationale: discriminator extension keeps the existing visibility
      / immutability / cascade rules in one place (Design Decision 1).
- [ ] Task 2. Add four new indexes on `notes` next to the existing
      `by_game_syndicate_created` block (`convex/schema.ts:316-324`):
      - `by_game_grant_created` on
        `["gameId", "targetGrantId", "createdAt"]`
      - `by_game_goal_created` on
        `["gameId", "targetGoalId", "createdAt"]`
      - `by_grant` on `["targetGrantId"]`
      - `by_goal` on `["targetGoalId"]`
      Rationale: parallels the existing minion / syndicate indexes
      (Design Decisions 2 and 3); every listing/cascade path must hit
      an index (Convex guideline — no `filter()` in queries).

### Phase 2 — Convex Backend (`convex/notes.ts`)

- [ ] Task 3. Extend the top-level `Notes` docstring at
      `convex/notes.ts:12-45` to mention the two new target kinds and
      to reaffirm that the note body is independent of the parent
      row's description redaction (Design Decision 5).
- [ ] Task 4. Extend `createNote.args` at
      `convex/notes.ts:94-113` with `targetGrantId:
      v.optional(v.id("treasonGrants"))` and `targetGoalId:
      v.optional(v.id("goals"))`, and broaden `targetKind` to include
      `v.literal("grant")` and `v.literal("goal")`.
- [ ] Task 5. Extend the target-consistency block at
      `convex/notes.ts:121-142` so each `targetKind` accepts exactly
      one matching id and rejects every other id. The validation
      cases for the new kinds are:
      - `grant` → `targetGrantId` set, all other `target*Id` absent;
      - `goal` → `targetGoalId` set, all other `target*Id` absent.
- [ ] Task 6. Extend the target-existence block at
      `convex/notes.ts:144-166` to add:
      - `grant` → `const grant = await ctx.db.get(args.targetGrantId!);
        if (!grant) throw new Error("Treason Grant not found.");
        if (grant.gameId !== args.gameId) throw new Error("That Grant
        is not in this game.");`
      - `goal` → analogous for `goals`.
      No further visibility gating is needed (Design Decision 4); a
      participant of the game can author on any grant/goal of the
      game.
- [ ] Task 7. The roll-set freeze block at `convex/notes.ts:171-191`
      stays untouched — it is gated on `targetKind === "minion"` and
      is not relevant to grants / goals.
- [ ] Task 8. The timer validation block at `convex/notes.ts:193-226`
      stays untouched. Grant / goal-target notes with a timer remain
      legal at the server level (per Design Decision 6); the UI gate
      lives in `getTimerCreateContext` (Task 11).
- [ ] Task 9. Extend the insert payload at
      `convex/notes.ts:228-239` to include the new ids when present:
      `...(args.targetGrantId !== undefined ? { targetGrantId:
      args.targetGrantId } : {})` and the same for `targetGoalId`.
      Rationale: the schema-level `v.optional` means we must omit the
      key when absent rather than write `undefined`.
- [ ] Task 10. Extend `listNotesForTarget` at
      `convex/notes.ts:619-740`:
      - extend `args.targetKind` union with `grant` and `goal`,
      - add `targetGrantId: v.optional(v.id("treasonGrants"))` and
        `targetGoalId: v.optional(v.id("goals"))` to `args`,
      - add two new branches in the dispatch at
        `convex/notes.ts:634-668`:
        ```ts
        else if (args.targetKind === "grant") {
          if (!args.targetGrantId) throw new Error("targetGrantId is required for grant notes.");
          rows = await ctx.db.query("notes")
            .withIndex("by_game_grant_created", q =>
              q.eq("gameId", args.gameId).eq("targetGrantId", args.targetGrantId!))
            .order("desc").collect();
        } else if (args.targetKind === "goal") { … }
        ```
      The remainder of the function (visibility filter, decoration
      with author display name, GM-only roll-set / timer joins) is
      target-kind-agnostic and needs no further change.
- [ ] Task 11. Extend `getTimerCreateContext` at
      `convex/notes.ts:301-331`:
      - extend `args.targetKind` with `grant` and `goal`,
      - add `targetGrantId: v.optional(v.id("treasonGrants"))` and
        `targetGoalId: v.optional(v.id("goals"))` (kept for shape
        parity with `listNotesForTarget` / `createNote`; the handler
        doesn't read them today),
      - the handler body needs NO change once the `targetKind`
        validator is widened. The existing condition
        `args.targetKind !== "minion"` at `convex/notes.ts:317`
        already returns `timerEligible: false` for any non-minion
        target, so the new kinds inherit the correct behaviour
        automatically (Design Decision 6).
- [ ] Task 12. Extend `getNoteCountsForGameView` at
      `convex/notes.ts:747-784`:
      - widen the return type to include
        `byGrant: Record<string, number>` and
        `byGoal: Record<string, number>`,
      - in the aggregation loop add the two new branches
        (`else if (n.targetKind === "grant" && n.targetGrantId) {
        byGrant[n.targetGrantId] = (byGrant[n.targetGrantId] ?? 0) + 1; }`
        and the analogous goal branch),
      - return both maps in the result.
      Existing callers ignore the new keys; new callers consume them
      via `resolveNoteCount` (Task 17).
- [ ] Task 13. Extend `GmTodoNoteRow` at
      `convex/notes.ts:396-412` with optional `targetGrantId?:
      Id<"treasonGrants">`, `targetGoalId?: Id<"goals">`,
      `grantKeyword?: string`, `goalKeyword?: string`.
- [ ] Task 14. Extend `listGameNotesWithTimers` at
      `convex/notes.ts:438-617`:
      - in the bulk-resolve section, collect the unique
        `targetGrantId` / `targetGoalId` sets exactly like the
        existing minion id set at `convex/notes.ts:463-475`,
      - load `grantById` / `goalById` maps the same way,
      - in the projection at `convex/notes.ts:553-606`, add the two
        new target kinds: copy `targetGrantId` / `targetGoalId` and
        the `grantKeyword` / `goalKeyword` from the lookup map onto
        the row. Player slot for grant rows uses the grant's
        `ownerPlayerId` (if any) hydrated through `playerById`;
        player slot for goal rows uses `fromPlayerId` (if any) for
        parity with the syndicate-target case where the row carries
        the player who "owns" the note's context. Both fall back to
        the existing `(unassigned)` rendering.
      - resolve those player ids via the existing `playerBySyndicateId`
        pattern adapted to direct player-id lookup; the cleanest
        change is to switch the existing logic to lookup players by
        id directly when a grant/goal target supplies the player id.
- [ ] Task 15. Update `convex/treasonGrants.ts:200-208`
      (`deleteGrant`) to cascade-delete every note with
      `targetGrantId === grant._id` BEFORE the parent row delete,
      using the new `by_grant` index. Same shape as
      `convex/minions.ts:194-199`.
- [ ] Task 16. Update `convex/goals.ts:458-466` (`deleteGoal`) to
      cascade-delete every note with `targetGoalId === goal._id`
      BEFORE the parent row delete, using the new `by_goal` index.

### Phase 3 — Shared UI Components

- [ ] Task 17. Extend `NoteTarget` at
      `src/components/NoteIcon.tsx:14-17` with two new shapes:
      `{ kind: "grant"; grantId: Id<"treasonGrants"> }` and
      `{ kind: "goal"; goalId: Id<"goals"> }`.
- [ ] Task 18. Extend `buildListArgs` at
      `src/components/NoteIcon.tsx:570-586` with two new branches
      that return `{ gameId, targetKind: "grant", targetGrantId:
      target.grantId }` and the analogous goal shape.
- [ ] Task 19. Extend the `timerCtx` query call inside
      `NotesPopover` at `src/components/NoteIcon.tsx:150-155` to
      thread the new ids:
      ```ts
      target.kind === "minion" ? { gameId, targetKind: "minion", targetMinionId: target.minionId }
        : target.kind === "grant" ? { gameId, targetKind: "grant", targetGrantId: target.grantId }
        : target.kind === "goal" ? { gameId, targetKind: "goal", targetGoalId: target.goalId }
        : { gameId, targetKind: target.kind }
      ```
- [ ] Task 20. Extend the `NoteCreateForm.submit` call at
      `src/components/NoteIcon.tsx:476-486` to pass `targetGrantId`
      and `targetGoalId` when the target kind matches:
      ```ts
      targetGrantId: target.kind === "grant" ? target.grantId : undefined,
      targetGoalId:  target.kind === "goal"  ? target.goalId  : undefined,
      ```
- [ ] Task 21. Extend `resolveNoteCount` in
      `src/hooks/useNotesCountMap.ts:22-41` with two new branches
      that read from `counts.byGrant[target.grantId]` /
      `counts.byGoal[target.goalId]`, and update the inline type
      argument and the `target` union to match. Update
      `useNotesCountMap`'s returned shape comment too.
- [ ] Task 22. Extend `formatGmTodoTarget` in
      `src/components/GmTodoDrawer.tsx:170-203` with two new
      branches: `grant-target` →
      `<grantKeyword? "(unknown grant)"> • <ownerPlayerName?
      (unassigned)>`, `goal-target` → `<goalKeyword? "(unknown
      goal)"> • <fromPlayerName? (unassigned)>`. Reuses the existing
      `playerDisplayName` slot from the projected row.

### Phase 4 — Page Integration

- [ ] Task 23. Thread `noteCounts` and `gameId` into
      `TreasonGrantRow` (currently rendered from
      `TreasonGrantsSection` at
      `src/pages/GameDetailPage.tsx:2525-2533`). Add the props to
      `TreasonGrantRow`'s signature (`src/pages/GameDetailPage.tsx:2644-2823`)
      and render a `<NoteIcon target={{ kind: "grant", grantId:
      grant._id }} count={resolveNoteCount(noteCounts, { kind:
      "grant", grantId: grant._id })} label={\`Grant: ${grant.keyword}\`}
      hideManagementControls={hideManagementControls} />` inside the
      left-side header span at
      `src/pages/GameDetailPage.tsx:2730-2752`, next to the
      `<strong>{grant.keyword}</strong>` element. The icon stays
      inside the same `row-wrap` so it participates in the existing
      wrap behaviour.
- [ ] Task 24. Same treatment for `GoalRowView`. Add `gameId` and
      `noteCounts` props (already available at the section level at
      `src/pages/GameDetailPage.tsx:3464-3526` — propagate from
      `GameDetailPage` into `GoalsSection` into `GoalRowView`).
      Render `<NoteIcon target={{ kind: "goal", goalId: goal._id }}
      count={resolveNoteCount(noteCounts, { kind: "goal", goalId:
      goal._id })} label={\`Goal: ${goal.keyword}\`}
      hideManagementControls={hideManagementControls} />` next to
      the `<strong>{formatGoalKeyword(goal.keyword,
      goal.type)}</strong>` element at
      `src/pages/GameDetailPage.tsx:3786`. The
      `hideManagementControls` prop is already plumbed through
      `GoalRowView` at `src/pages/GameDetailPage.tsx:3734`. For
      parity with the existing in-row icon usage at
      `src/pages/GameDetailPage.tsx:1150-1167` and `:1323-1337`,
      wrap the icon in `<span onClick={(e) =>
      e.stopPropagation()} style={{ display: "inline-flex" }}>` —
      `TreasonGrantRow` / `GoalRowView` have no row-level click
      handler today, so this is defensive only, but it matches the
      convention. Apply the same wrapper in Task 23.
- [ ] Task 25. Update the two section components' prop signatures so
      the parent passes `noteCounts` (already computed in
      `GameDetailPage` at `src/pages/GameDetailPage.tsx:59`). No new
      subscription is added on the client; the existing
      `useNotesCountMap(gid)` subscription covers grant + goal too
      after Task 12.

### Phase 5 — Tests & Verification

- [ ] Task 26. `convex-test` authorization matrix for grant-target
      notes (mirrors `notes.test.ts` cases for the minion target):
      - GM and any Player participant can create, list, and (visible
        to them) count grant notes;
      - non-participant rejected on create + list + count;
      - GM can delete any grant note; authors and other Players cannot;
      - private notes are invisible to other Players and to the
        author of a *different* private note;
      - GM sees every private note on the grant.
- [ ] Task 27. Same matrix for goal-target notes.
- [ ] Task 28. `convex-test` cross-game scoping: create two games each
      with one Treason Grant (and one Goal). Notes on game-A's grant
      do not appear when listing notes for the same grant id in
      game B; the server rejects mismatched `gameId` /
      `targetGrantId` (parent row gameId check from Task 6) and same
      for goals.
- [ ] Task 29. `convex-test` ordering: three notes on the same grant
      at distinct timestamps return newest-first from
      `listNotesForTarget` (and same for goals).
- [ ] Task 30. `convex-test` cascade: `deleteGrant` deletes every
      note with that `targetGrantId`; `deleteGoal` deletes every note
      with that `targetGoalId`. Pre-existing notes on unrelated
      grants / goals are left intact.
- [ ] Task 31. `convex-test` count-query correctness:
      `getNoteCountsForGameView` returns `byGrant` and `byGoal` maps
      that exactly match the per-target visible-note counts for the
      caller, including the GM-only path that sees private notes.
- [ ] Task 32. `convex-test` GM Todo projection: a grant-target
      timer-bearing note appears in `listGameNotesWithTimers` with
      `targetKind: "grant"`, `targetGrantId`, and `grantKeyword`
      populated; same for goals. Player sessions never see this
      query (existing GM-only gate; reuse the existing test
      pattern).
- [ ] Task 33. `convex-test` timer eligibility:
      `getTimerCreateContext` returns `timerEligible: false` for both
      grant and goal targets regardless of caller role. The GM still
      sees `viewerIsGm: true`.
- [ ] Task 34. `convex-test` note-body visibility is independent of
      parent-row description redaction (Design Decision 5):
      - Create a Treason Grant whose description is redacted for
        Player B (B is not the owner). Author a `public` note on it
        as Player A. Assert B sees the note body via
        `listNotesForTarget`, even though `listGrantsForGame`
        returns `description: null` for B.
      - Same shape for a Goal where Player B is neither `from` nor
        `to`: B must see the public note body even with the goal's
        description redacted.
- [ ] Task 35. `convex-test` server still accepts a GM-authored
      timer-bearing note on a grant target and on a goal target
      (locks Design Decision 6 against silent regression). The note
      persists with a `ticking` timer; `listGameNotesWithTimers`
      projects the row with the correct `targetKind`,
      `targetGrantId` / `targetGoalId`, and `grantKeyword` /
      `goalKeyword`. Players still see `timerEligible: false` from
      `getTimerCreateContext` for the same target — the UI gate is
      preserved.
- [ ] Task 36. `convex-test` mixed-id rejection in `createNote`: a
      caller passing `targetKind: "grant"` with BOTH `targetGrantId`
      and any of (`targetSyndicateId`, `targetMinionId`,
      `targetGoalId`) is rejected by the consistency check (Task 5).
      Same for `targetKind: "goal"` with mixed ids. This locks the
      "exactly one id per kind" invariant.
- [ ] Task 37. `convex-test` `getNoteCountsForGameView` GM vs Player
      asymmetry on grant/goal targets: Player A posts a `private`
      note on a grant; assert A's counts show `byGrant[g] = 1`, B's
      counts show `byGrant[g] = 0`, GM's counts show
      `byGrant[g] = 1`. Same matrix for a `private` goal note.
- [ ] Task 38. Confirm note authoring on grant/goal targets is
      allowed in `archived` games (parity with today's
      minion/syndicate-target notes — `convex/notes.ts:114-118` has
      no archived gate). One `convex-test` archived-game create on a
      grant target is sufficient.
- [ ] Task 39. Manual smoke test (two browser contexts, GM + Player):
      grant note icon and goal note icon appear with badge counts;
      popover opens, creates/deletes work, counts update reactively;
      a private note posted by Player A is invisible to Player B and
      visible to the GM.

## Verification Criteria

- The `notes` table accepts `targetKind` values `grant` and `goal`
  alongside the existing three, with matching optional id columns
  and four new indexes. The migration is additive — no existing rows
  change shape.
- `createNote`, `listNotesForTarget`, `getNoteCountsForGameView`,
  `getTimerCreateContext`, and `listGameNotesWithTimers` all accept
  and project the two new target kinds. No call path uses `filter()`
  on the `notes` table; every read hits a covering index (Convex
  guideline).
- `deleteGrant` and `deleteGoal` cascade-delete every note targeting
  the deleted row in the same mutation, mirroring the existing
  minion cascade.
- A `<NoteIcon target={{kind:"grant"...}} />` is rendered inline next
  to the keyword on every `TreasonGrantRow`; the same for
  `GoalRowView`. The icon uses the shared
  `useNotesCountMap(gameId)` subscription — no fan-out.
- Private notes on a grant or goal are visible only to the author
  and the GM. Public notes are visible to every participant. Note
  body visibility is independent of the parent row's description
  redaction.
- Notes are immutable post-creation — no edit mutation, no edit UI,
  no `updatedAt` field. GM is the only role that can delete.
- All listings are newest-first by `createdAt` descending.
- All existing rules and tests remain green; the change is strictly
  additive.

## Potential Risks and Mitigations

1. **Visibility leak through the new code paths.** A regression in
   the `grant` / `goal` branches of `listNotesForTarget` or
   `getNoteCountsForGameView` could expose a private note.
   Mitigation: every new branch goes through the existing
   `canViewNote` helper unchanged (single source of truth, Design
   Decision 4 of the original notes plan); dedicated authorization
   tests (Tasks 26, 27).
2. **Cross-game contamination.** A forged
   `(gameId, targetGrantId)` pair could surface another game's
   notes.
   Mitigation: explicit parent-row gameId check in `createNote`
   (Task 6) and the index `(gameId, targetGrantId, createdAt)` for
   the listing query (Task 2). Test 28 enforces this.
3. **Cascade gaps on parent delete.** Deleting a grant / goal could
   leave orphan notes.
   Mitigation: cascade pass in `deleteGrant` / `deleteGoal`
   (Tasks 15, 16) using the new single-column indexes; cascade test
   (Task 30).
4. **Counts-payload bloat.** `getNoteCountsForGameView` already
   returns one entry per syndicate and per minion; adding two more
   maps doubles down on the same pattern.
   Mitigation: per-game working set is bounded (grants and goals are
   GM-authored per Rule 26 / Rule 28) so the payload stays
   negligible. No new subscription is opened — the existing single
   subscription returns the wider object.
5. **GM Todo drawer rendering grants/goals with timers when no UI
   path creates them.** Today the UI gate keeps timers off
   grant/goal notes. Direct API callers could still produce them.
   Mitigation: `formatGmTodoTarget` handles the new kinds (Task 22)
   so the drawer renders sensibly even for these "off-path" rows.
   No data corruption risk — the projection mirrors the existing
   syndicate-target path.
6. **Schema column proliferation on `notes`.** Two new optional id
   columns plus four new indexes.
   Mitigation: the column count remains small (`notes` already has
   `targetSyndicateId` and `targetMinionId` of the same shape); the
   four indexes are necessary for `listNotesForTarget` /
   `getNoteCountsForGameView` performance and the two cascades, and
   they parallel the existing minion / syndicate indexes exactly.

## Alternative Approaches

1. **Per-target tables (`grantNotes`, `goalNotes`).** Trade-off:
   simpler indexes per table, at the cost of two more CRUD
   surfaces, two more cascade passes, and a third (and fourth)
   place that must encode `canViewNote`. Rejected because the
   discriminator pattern keeps visibility/authorization in one
   place and the original notes plan already validated this
   approach (Alternative #1 in
   `plans/2026-04-20-notes-feature-v3.md:145`).
2. **Embed notes as a JSON array on `treasonGrants` / `goals`
   rows.** Rejected: violates the Convex guideline against
   unbounded arrays on documents; breaks the
   newest-first listing query without an inner index; precludes
   GM-only deletion as a server-authoritative operation; and
   breaks the cross-target `getNoteCountsForGameView` aggregation.
3. **Restrict authoring to GM only on grant/goal notes.**
   Considered for parity with the GM-authored nature of the parent
   rows. Rejected: a Player participant can already author notes
   on the game and on syndicates (including syndicates they
   don't own), so restricting them on grants/goals would be
   inconsistent and would block legitimate Player annotations
   ("I'm chasing this grant", "this goal is hard for me").
4. **Surface timer duration buttons for GM-authored grant/goal
   notes.** Rejected for v1 — keeps the timer UX focused on the
   "live skill check" use case it was designed for
   (`plans/2026-04-28-2026-04-28-note-timers-v1.md`). Server still
   accepts such timers if a future plan wires them up.
5. **Cascade notes on `clearGrantOwner` / `clearToPlayer`.**
   Rejected: clearing ownership doesn't destroy the parent row, so
   the note is still attached to a valid target. Mirrors the
   "POWER paid out is not refunded" rule from
   `convex/treasonGrants.ts:32-35`.
6. **Add a `targetEntityId: v.union(v.id("syndicates"),
   v.id("minions"), v.id("treasonGrants"), v.id("goals"))` single
   column instead of one optional column per kind.** Rejected:
   Convex indexes are keyed on a specific field type; a single
   polymorphic column would force `filter()` for any cascade, and
   that breaks the Convex guideline against `filter()` in queries.
