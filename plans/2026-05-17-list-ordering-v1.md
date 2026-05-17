# Minions, Grants, Goals — List Ordering

## Objective

Change server-side list ordering for three resources so the UI surfaces
the most relevant rows first:

1. **Minions** — always sorted alphabetically by `name`
   (case-insensitive), replacing the existing `order`-field sort. The
   `minions.order` field itself stays on the schema (still written by
   `convex/minions.ts:88-129` on create) but is no longer used as a
   sort key by any reader.

2. **Treason Grants** — sorted into three groups, each internally
   alphabetical by `keyword` (case-insensitive):
   - Group A: grants where the viewer is the owner (`isMine === true`).
   - Group B: grants owned by someone else (`ownerPlayerId !== null`
     and not the viewer).
   - Group C: unclaimed grants (`ownerPlayerId === null`).
   - For a GM (no `playerId`) Group A is always empty; they see B → C.

3. **Goals** — sorted into four groups, each internally alphabetical
   by `keyword` (case-insensitive):
   - Group A: goals where the viewer is the to-player
     (`isToMe === true`).
   - Group B: goals where the viewer is the from-player
     (`isFromMe === true`).
   - Group C: goals with any assignment
     (`fromPlayerId !== null || toPlayerId !== null`) that are not in
     A or B.
   - Group D: goals with neither `fromPlayerId` nor `toPlayerId`.
   - For a GM (no `playerId`) Groups A and B are always empty; they
     see C → D.

The change is server-side only — the client renders rows in the order
the server returns them. No schema migration, no new indexes.

## Initial Assessment

### Project Structure Summary

- Convex backend lives in `convex/`. The three resources are
  implemented in `convex/minions.ts`, `convex/treasonGrants.ts`, and
  `convex/goals.ts`. Each defines its own `list*` query that already
  returns a sorted array.
- The React UI in `src/pages/GameDetailPage.tsx` and
  `src/pages/SyndicateEditorPage.tsx` calls those queries and renders
  rows in their natural order (no client-side re-sort).
- Tests live alongside the modules: `convex/minions.test.ts`,
  `convex/treasonGrants.test.ts`, `convex/goals.test.ts`. The existing
  expectations almost always work against a single row (so ordering is
  irrelevant) — verified during planning. Multi-row ordering
  assertions, if any, must be re-read before edits land.

### Relevant Files Examination

- `convex/minions.ts:205-216` — `listForSyndicate` query. Currently
  sorts `minions.sort((a, b) => a.order - b.order)`. **No live UI
  consumer today** — both the syndicate editor
  (`src/pages/SyndicateEditorPage.tsx:35-38`) and the game-detail
  "Your Syndicate" preview (`src/pages/GameDetailPage.tsx:1933`)
  read minions through `api.syndicates.getWithChildren`. We still
  update `listForSyndicate` for API parity with `getWithChildren` so
  a future caller can't accidentally pick up the legacy `order` sort.
- `convex/minionBuys.ts:94-173` — `listForPlayer` query. At line 149
  sorts the joined minion list by `order` for the per-game buy panel.
- `convex/syndicates.ts:215-260` — `getWithChildren` query. At line
  238 sorts `minions` by `order`; this feeds both the syndicate editor
  and the read-only "Your Syndicate" preview shown on the game detail
  page (`src/pages/GameDetailPage.tsx:1933-2046`).
- `convex/treasonGrants.ts:304-358` — `listGrantsForGame`. Today
  sorts by `_creationTime` desc at line 323, then maps each grant
  into the public `GrantRow` shape (which already includes
  `isMine`, `ownerPlayerId`, `keyword`). The sort is the only line
  that needs to change.
- `convex/goals.ts:505-596` — `listGoalsForGame`. Today sorts by
  `_creationTime` desc at line 524, then maps to `GoalRow` (which
  exposes `isFromMe`, `isToMe`, `fromPlayerId`, `toPlayerId`,
  `keyword`).
- `src/pages/GameDetailPage.tsx:2477-2538`, `:3464-3526` — the
  `TreasonGrantsSection` and `GoalsSection` React components (the
  preceding `:2460-2476` / `:3406-3463` lines are banner comments
  and type declarations). They iterate `data.grants` / `data.goals`
  directly, so changing the server sort changes the rendered order
  with no client edits.
- `src/pages/SyndicateEditorPage.tsx:558-741` — `MinionsEditor`. It
  iterates `minions.map(...)` in the order returned by the query and
  uses the `order` field only as backing data (not as a sort key) so
  switching the sort to name-alphabetical is safe.

### Architecture and Design Patterns

- Convex queries do the ordering server-side; React renders in the
  given order. This plan adds zero client-side sorts.
- `keyword` and `name` are user-authored free text. Comparison uses
  `a.X.localeCompare(b.X, undefined, { sensitivity: "base" })` so
  case differences don't fragment the ordering and the result is
  Unicode-correct. This is a deliberate divergence from the six
  existing bare-`localeCompare` call sites in the repo
  (`convex/presetSkills.ts:35`, `convex/presetDrawbacks.ts:66`,
  `convex/notes.ts:513`, `convex/goals.ts:543`,
  `convex/publicBids.ts:449`, `convex/syndicates.ts:334`): in those
  sites strings are admin-curated and case is meaningful, whereas
  for user-authored `keyword` / `name` we want "Murmur" and "murmur"
  to sort adjacently. We stay with `localeCompare` (not
  `Intl.Collator`) so the style stays close to precedent; for the
  N ≤ a few dozen rows these queries return, the perf difference is
  negligible.
- The grants/goals queries already compute the per-row viewer flags
  (`isMine`, `isFromMe`, `isToMe`) needed to bucket the rows. The
  cleanest place to apply the new sort is **after** the map step so
  the sort comparator can read the already-computed flags directly,
  rather than re-deriving them from `Doc<>` rows.
- Per-game keyword uniqueness is enforced case-insensitively for
  both grants (`convex/treasonGrants.ts:105-124`) and goals
  (`convex/goals.ts:150-167`), so an in-group `keyword` tie is
  impossible by construction — no secondary `_id` tiebreaker is
  needed in the comparator.
- The from-player / to-player invariant (`from !== to`) that the
  goals comparator relies on is enforced in every mutation path:
  `createGoal` (`convex/goals.ts:198-203`), `updateGoal`
  (`convex/goals.ts:311-352`), `assignFromPlayer`
  (`convex/goals.ts:383-388`), and `assignToPlayer`
  (`convex/goals.ts:433-435`). So `isFromMe && isToMe` cannot occur.

## Implementation Plan

### Task 1: Sort minions alphabetically across all readers

- task_status: DONE
- Files & locations:
  - `convex/minions.ts:213` — replace
    `minions.sort((a, b) => a.order - b.order)` with
    `minions.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))`.
  - `convex/minionBuys.ts:149` — replace the same `order` sort with
    the same name comparator (the sort runs against `Doc<"minions">`
    rows, so `.name` is directly accessible).
  - `convex/syndicates.ts:238` — replace the `minions` sort with the
    same name comparator. Leave the `drawbacks` sort (line 237)
    untouched.
- Verification:
  - Run `npx convex codegen` (or rely on the dev server) to ensure
    no type drift.
  - Run `npx vitest run convex/minions.test.ts` and confirm green.
  - Spot-check the syndicate editor and game detail "Your Syndicate"
    preview locally if a dev environment is available; otherwise
    rely on the unit tests + manual reading of the diff.

### Task 2: Sort Treason Grants by ownership group then keyword

- task_status: DONE
- Files & locations:
  - `convex/treasonGrants.ts:317-356` — delete the
    `grants.sort(... _creationTime ...)` line **and the stale
    `// Newest first (matches notes ordering).` comment immediately
    above it at `convex/treasonGrants.ts:322`**. After building the
    `GrantRow[]` array (the `grants.map(...)` block at lines
    332-355), assign the result to `const rows: GrantRow[]`, sort
    `rows` in place with a comparator that:
    1. Returns negative when `a` is in a higher-priority group than
       `b`. Group rank: `isMine ? 0 : ownerPlayerId !== null ? 1 : 2`.
    2. On group-rank tie, returns
       `a.keyword.localeCompare(b.keyword, undefined, { sensitivity: "base" })`.
       Per-game keyword uniqueness (case-insensitive) means an
       in-group tie is impossible, so no `_id` fallback is needed.
  - Return `{ gameState: game.state, grants: rows }`.
- Verification:
  - Run `npx vitest run convex/treasonGrants.test.ts` and confirm
    green. Audit the `view.grants[0]` assertions at lines 224, 298,
    566, 572, 584, 592, 601 — every one of those tests operates on
    a single grant, so the new sort leaves `grants[0]` unchanged.
  - Manual sanity: build a fixture with one mine-owned, one
    other-owned, one unclaimed grant and confirm the order is
    [mine, other, unclaimed].

### Task 3: Sort Goals by viewer-relevance group then keyword

- task_status: DONE
- Files & locations:
  - `convex/goals.ts:518-595` — delete the
    `goals.sort(... _creationTime ...)` line. After the
    `goals.map(...)` block that produces `GoalRow[]`, assign to
    `const rows: GoalRow[]` and sort in place with a comparator
    that:
    1. Group rank:
       - `0` when `isToMe === true`
       - `1` when `isFromMe === true` (and not `isToMe`, but those
         two are mutually exclusive by the from/to invariant)
       - `2` when `fromPlayerId !== null || toPlayerId !== null`
       - `3` otherwise
    2. On group-rank tie, returns
       `a.keyword.localeCompare(b.keyword, undefined, { sensitivity: "base" })`.
       Per-game keyword uniqueness (case-insensitive) means an
       in-group tie is impossible, so no `_id` fallback is needed.
  - Return `{ gameState, eligiblePlayers, goals: rows }`.
- Verification:
  - Run `npx vitest run convex/goals.test.ts` and confirm green.
    Audit the `view.goals[0]` assertions at lines 328-334, 363-366,
    401-402, 435-436, 473, 617 — every one operates on a single
    goal so the new sort is a no-op for those expectations.
  - Manual sanity: build a fixture with one to-me, one from-me,
    one neither-but-assigned, one unassigned goal and confirm the
    order is [to-me, from-me, assigned, unassigned].

### Task 4: Audit and update tests for multi-row ordering assumptions

- task_status: DONE
- Re-read the three test files end-to-end:
  - `convex/minions.test.ts`
  - `convex/treasonGrants.test.ts`
  - `convex/goals.test.ts`
- For each multi-row case, confirm the assertions still hold under
  the new sort. If any assertion is order-sensitive and now fails,
  update the assertion to match the new contract (NOT the other way
  around — the new contract is authoritative).
- If no test currently covers the new ordering, add a small
  multi-row test per resource that locks in:
  - Minions: three minions named "Charlie", "alice", "Bob" (mixed
    case) return alphabetically as alice, Bob, Charlie.
  - Grants: three grants — viewer-owned "Zebra", other-owned
    "Alpha", unclaimed "Mango" — return as Zebra, Alpha, Mango.
  - Goals: four goals — to-viewer "Zulu", from-viewer "Yankee",
    other-assigned "Alpha", unassigned "Mango" — return as Zulu,
    Yankee, Alpha, Mango.
- task_status: DONE

### Task 5: Run the full test suite and typecheck

- task_status: DONE
- Commands:
  - `npx vitest run`
  - `npx tsc --noEmit`
- Both must exit 0 with no new warnings attributable to these
  changes.

## Risks & Mitigations

- **Risk:** Hidden consumers re-sort or rely on `_creationTime`
  ordering of grants/goals. _Mitigation:_ A repo-wide search for
  `grants.sort`, `goals.sort`, `minions.sort` and for the relevant
  `_creationTime` comparators turned up only the three sites this
  plan modifies. Confirm again during implementation before editing.
- **Risk:** `minions.order` is still maintained by the create path
  but no longer consumed. _Mitigation:_ Intentional. Out-of-scope to
  remove the column today; deferring lets a future drag-to-reorder
  feature reuse the field without a migration.
- **Risk:** A locale-aware comparator may sort differently on
  different runtimes (Convex's V8 vs Vitest's Node ICU data).
  _Mitigation:_ Tests use ASCII-only fixtures (`alice`, `Bob`,
  `Charlie`, `Zebra`/`Alpha`/`Mango`, `Zulu`/`Yankee`/`Alpha`/`Mango`)
  whose `{ sensitivity: "base" }` ordering is unambiguous on every
  modern ICU build. Diacritic-heavy inputs are out of scope for this
  contract.
- **Risk:** Existing single-row tests are passing-by-accident
  because there's only one row. _Mitigation:_ Task 4 explicitly adds
  multi-row coverage so the new ordering contract is locked in.

## Verification Criteria

- All three resources return rows in the new order from their
  respective queries.
- `npx vitest run` and `npx tsc --noEmit` exit 0.
- The syndicate editor, game-detail "Your Syndicate" preview, the
  per-game minion buy panel, the Treason Grants section, and the
  Goals section render rows in the new order with no client-side
  changes required.
