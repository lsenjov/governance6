# Next Minion — v1

## Objective

Let a player **queue a follow-up minion** so the moment the GM removes
the player's active Call, a fresh minion Call for the queued minion is
auto-enqueued at the tail of the FIFO queue without the player having
to click anything.

Concretely:

- Each of the player's bought minions in the per-player
  `MinionBuyPanel` (`src/pages/GameDetailPage.tsx:1272-1373`) gains a
  **"Next"** button beside the existing **"Call"** button.
- At most **one** minion per `(gameId, playerId)` may be marked
  "next" at a time. Clicking Next on a different minion clears the
  previous selection. Clicking Next on the currently-marked minion
  un-marks it (toggle off).
- The Next button is only rendered when **the viewer is the owner**,
  the game is `"playing"`, the minion is `bought`, AND the viewer
  currently has an active call. (Without an active call there's
  nothing for the auto-promote to fire on, so we hide the affordance
  to keep the intent unambiguous.)
- The currently-marked Next minion's button renders with a
  pressed/active visual style; un-marked Next buttons use the muted
  `.secondary` look.
- When the **GM** removes (and only the GM can — `removeCall` at
  `convex/calls.ts:159-207` is the only path) a call belonging to a
  player who has a Next minion that is **still bought**, the server
  atomically:
  1. Inserts a fresh `kind: "minion"` call for that minion (new row,
     new `createdAt` → tail of FIFO).
  2. Clears the `isNext` flag on the `gamePlayerMinions` row.
  3. Fires the existing roll-set generation when the auto-promoted
     call ends up the head (i.e., the queue was otherwise empty
     after the removal).
- The flag is **only** cleared by the auto-promote path, by an
  explicit user toggle-off, or by a defensive cleanup when the next
  minion is no longer bought at removal time. **In-place replace via
  `addOrReplaceCall` / `addOrReplaceCustomCall` does NOT clear
  `isNext`** — those paths leave the flag untouched so a player's
  queued follow-up survives their own re-call. (A one-line
  doc-comment in each of those mutations records the invariant at
  the call site so the next maintainer doesn't have to read this
  plan to know it.)
- **Visibility of `isNext` is public to all game participants.**
  The Call queue itself is already public via `activeCalls`
  (`convex/calls.ts:249-353`); exposing a player's queued follow-up
  to other participants is consistent with that contract. The field
  is therefore returned unredacted on every `listForPlayer` viewer
  (`isSelf`, other-player, GM).

## Initial Assessment

### Project Structure Summary

- Convex backend lives in `convex/`. The Call queue is in
  `convex/calls.ts` and `convex/lib/calls.ts`; per-game minion buys
  are in `convex/minionBuys.ts`; schema in `convex/schema.ts`. Dice
  rolls live in `convex/lib/rolls.ts`.
- React UI for the per-player buy/call panel is the
  `MinionBuyPanel` component in `src/pages/GameDetailPage.tsx` at
  `:1229-1374` (button rendering at `:1340-1367`, mutation wiring at
  `:1244,:1262-1270`). Button styling conventions live in
  `src/index.css:121-169` (`button.secondary` is the muted state;
  the default `button` style is the "pressed/primary" look).
- Convex tests live alongside modules:
  - Call queue: `convex/calls.test.ts` (harness with two players,
    bought minions, etc. at `:62-174`).
  - There is **no** existing `convex/minionBuys.test.ts`; we will
    create one for the `toggleNextMinion` mutation. (Tests for the
    auto-promote interaction belong in `convex/calls.test.ts`
    because they exercise `removeCall`.)

### Relevant Files Examination

- `convex/schema.ts:172-182` — `gamePlayerMinions` table. Already
  carries `bought`, `boughtAt`, `pricePaid`. Indexes:
  `by_game_player`, `by_game_player_minion`. We add an optional
  `isNext: v.optional(v.boolean())` field. **No new index** —
  uniqueness is enforced in the mutation by `by_game_player` scan,
  and the auto-promote in `removeCall` looks up the flagged row via
  the same scan. The per-player row count is ≤8 (the
  `MINION_PRICES` cap in `convex/minionBuys.ts:14`) so the scan is
  trivial.
- `convex/calls.ts:43-106` — `addOrReplaceCall`. Untouched by this
  plan apart from a one-line comment update noting that `isNext` is
  intentionally left alone here.
- `convex/calls.ts:122-148` — `addOrReplaceCustomCall`. Untouched
  (same comment note).
- `convex/calls.ts:159-207` — `removeCall`. The single auto-promote
  trigger site. The new logic slots in **after** the `ctx.db.patch`
  that soft-deletes the row and **before** the existing
  `if (removedWasHead)` roll-set block, so the existing head-lookup
  picks up the auto-promoted row when the queue was otherwise empty.
- `convex/lib/calls.ts:61-136` — `upsertActiveCall`. Reused by the
  auto-promote path: the removed call is already soft-deleted, so
  the helper's `by_game_player_active` lookup will find no existing
  active call and take the fresh-insert branch. Perfect fit; no
  changes needed.
- `convex/lib/rolls.ts:155-193` (`getDrawbackExtrasForCall`) and
  `:213-323` (`generateRollSetForCall`). Reused unchanged. The
  auto-promoted call is a `kind: "minion"` row and routes through
  the same roll-set path as the existing "next-head" branch in
  `removeCall`.
- `convex/minionBuys.ts:90-176` — `listForPlayer`. Today returns
  `{ isSelf, syndicateId, minions: [...], nextPrice, boughtCount }`.
  We add an `isNext: boolean` field per minion row AND a
  top-level `hasActiveCall: boolean` so the UI can gate the Next
  button without a separate query.
- `src/pages/GameDetailPage.tsx:1229-1374` — `MinionBuyPanel`. The
  Next button slots into the action group at `:1325-1368`, next to
  Call. A new `toggleNextMinion` mutation is wired alongside
  `addCall` and `buy` at `:1243-1244`.

### Architecture and Design Patterns

- **Storage shape.** The `isNext` boolean lives on
  `gamePlayerMinions` rather than on `players` because (a) it's
  conceptually a per-`(player, minion)` mark, (b) it sits naturally
  next to `bought` which gates the same UI affordance, and (c)
  uniqueness is implicitly enforced by "scan all of this player's
  ≤8 rows and clear any other set to true before patching this one".
  Storing `nextMinionId` on `players` would require a join on every
  buy-panel query — strictly worse.
- **`v.optional(v.boolean())` + `undefined → false` projection.**
  Matches the existing convention for `drawbacks.isRolled`
  (`convex/schema.ts:96-100`) and `calls.kind`
  (`convex/schema.ts:203-205`). Legacy rows written before this
  change project to `false` without a migration.
- **Clearing writes `undefined`, not `false`.** Matches the
  established "clear an optional field" pattern at
  `convex/lib/calls.ts:102,108` and `convex/games.ts:105`. Readers
  project `undefined` to `false` via `row.isNext === true` (see
  Task 3), so the on-the-wire shape is identical whether the row
  was "never set" or "explicitly cleared".
- **Toggle semantics.** A single mutation `toggleNextMinion` covers
  both set and clear cases. The server inspects the target row's
  current `isNext`: if `true` → clear; if `false`/absent → first
  clear any other row of this `(game, player)` that has
  `isNext === true`, then set the target to `true`. This is the
  minimum-API surface that respects the uniqueness invariant.
- **Active-call gate is server-side, not just UI.** The mutation
  rejects "set" attempts when the player has no active call.
  "Clear" is unconditional (idempotent, safe under races). The UI
  hides the button entirely when there's no active call so the
  reject path is purely defence-in-depth.
- **Active-call check.** Use the existing `by_game_player_active`
  index on `calls` with a `.unique()` lookup. Same pattern as
  `upsertActiveCall` (`convex/lib/calls.ts:71-77`).
- **Auto-promote ordering inside `removeCall`.** Slot the
  auto-promote block **between** the soft-delete `ctx.db.patch` and
  the existing roll-set block. Because both writes share a single
  Convex transaction, the auto-promoted call's `createdAt`
  (`Date.now()` at insert time inside `upsertActiveCall`) is
  guaranteed `≥` the removed call's `createdAt`. Any other already-
  active call in the queue has an even older `createdAt`, so the
  FIFO `by_game_active_time` index will always place the new row at
  (or near) the tail. Ms-resolution ties between same-transaction
  inserts fall back to `_id` order, which is also insertion order —
  the new row still lands at the tail. This way:
  - When the removed call was mid-queue: auto-promote inserts at the
    tail; head is unchanged; existing roll-set block (gated by
    `removedWasHead`) doesn't run; no rolls fire for the
    auto-promoted call yet. Correct.
  - When the removed call was the head AND the queue was otherwise
    empty: auto-promote inserts a fresh call; the existing
    roll-set block re-reads the head and finds the auto-promoted
    call; rolls fire for it as `became_head`. Correct.
  - When the removed call was the head AND another call was already
    in line: auto-promote inserts at the tail; the existing block
    re-reads the head, finds the next-oldest (unrelated) call, and
    fires rolls for it. The auto-promoted call sits at the tail and
    will fire rolls when its own turn comes (via a future
    `removeCall`). Correct.
- **`upsertActiveCall` reuse.** We could technically `ctx.db.insert`
  directly, but funnelling through the helper keeps the invariant
  "exactly one helper writes call rows" intact and gives us back
  the `id`/`changed` shape if we ever need it. The helper's "patch
  in place" branch is unreachable here (we just soft-deleted the
  player's only active call) but harmless.
- **Pressed-style affordance.** Existing CSS already gives us two
  button looks via `button` (primary/accent) and `button.secondary`
  (muted). The Call button is `.secondary`. The Next button mirrors
  this: `.secondary` when unmarked; **no `.secondary`** (so primary)
  when marked. Add `aria-pressed={isNext}` for accessibility. No
  new CSS required.
- **Bought-but-unmarked-next defensive case.** If a player's
  `isNext` minion has been (somehow) unbought between marking and
  the removal — currently impossible since there's no unbuy
  mutation, but defended anyway — silently clear the flag and
  enqueue nothing. Mirrors the existing "minion was deleted"
  defensive nulls in the call helpers.

## Implementation Plan

### Task 1: Schema — add `isNext` to `gamePlayerMinions`

- task_status: DONE
- Files & locations:
  - `convex/schema.ts:172-182` — append
    `isNext: v.optional(v.boolean()),` to the field list of the
    `gamePlayerMinions` table. Keep both existing indexes
    unchanged.
  - Update the doc comment immediately above the table
    (`convex/schema.ts:172`) to mention the new field, e.g.:
    "`isNext` flags the player's queued follow-up minion. At most
    one row per `(gameId, playerId)` may have `isNext === true`,
    enforced by `toggleNextMinion` and consumed by `removeCall`'s
    auto-promote path. See `plans/2026-05-17-next-minion-v1.md`."
- Verification:
  - `npx convex codegen` (or the dev server) succeeds.
  - `npx tsc --noEmit` is green.
  - Re-read every `ctx.db.insert("gamePlayerMinions", { ... })` and
    `ctx.db.patch(gpmId, { ... })` callsite to confirm none of them
    need `isNext` set (the field is optional, defaults to absent
    which projects to `false`). Callsites today:
    `convex/minionBuys.ts:62-66`, `:68-76`.

### Task 2: Server — `toggleNextMinion` mutation in `convex/minionBuys.ts`

- task_status: DONE
- Files & locations:
  - `convex/minionBuys.ts` — append a new exported `toggleNextMinion`
    mutation after `buyMinion` (before `listForPlayer`):
    ```ts
    export const toggleNextMinion = mutation({
      args: { gameId: v.id("games"), minionId: v.id("minions") },
      handler: async (ctx, args) => { ... }
    });
    ```
  - Handler steps:
    1. `const { game, player } = await requireGamePlayer(ctx, args.gameId);`
       (rejects non-participants and the GM, matching `buyMinion`).
    2. Reject if `game.state !== "playing"`. Error message:
       `"Next can only be set while the game is playing."`.
    3. Look up the target `gamePlayerMinions` row via the existing
       `by_game_player_minion` index. If missing OR `!row.bought`,
       throw `"You must buy this Minion before marking it next."`.
    4. Compute the desired action: if `row.isNext === true` →
       clear; else → set.
    5. **Set branch** (only): assert the player currently has an
       active call by reading `calls` via the
       `by_game_player_active` index for `(gameId, player._id, true)`
       with `.unique()`. If `null`, throw
       `"You must have an active Call before marking a Minion next."`.
       The clear branch deliberately skips this check — a player
       must always be able to revoke their own flag (idempotent,
       safe under races).
    6. Scan the player's other `gamePlayerMinions` rows via
       `by_game_player` and `ctx.db.patch(other._id, { isNext: undefined })`
       for every row with `isNext === true` and `_id !== row._id`.
       (Even though uniqueness is meant to be invariant, do this
       defensively in case a prior write left two rows true.)
    7. Apply the toggle:
       - On set: `ctx.db.patch(row._id, { isNext: true })`.
       - On clear: `ctx.db.patch(row._id, { isNext: undefined })`.
       Writing `undefined` (not `false`) matches the project
       convention for clearing optional fields
       (`convex/lib/calls.ts:102,108`).
    8. Return `void`.
  - Comment block above the mutation explains the toggle semantics,
    the active-call gate, and that the auto-promote in
    `removeCall` is what consumes the flag.
- Verification:
  - `npx tsc --noEmit` green.
  - `npx vitest run convex/minionBuys.test.ts` green (see Task 6
    for the test file).

### Task 3: Server — expose `isNext` + `hasActiveCall` on `listForPlayer`

- task_status: DONE
- Files & locations:
  - `convex/minionBuys.ts:90-176` — extend `listForPlayer`'s return
    shape:
    - Per-minion object gains `isNext: boolean` after `pricePaid`.
      Compute via `byMinion.get(m._id)?.isNext === true` so absent
      flags project to `false`.
    - Top-level object gains `hasActiveCall: boolean`. Compute by
      reading the `calls` table once via
      `by_game_player_active` for `(gameId, args.playerId, true)`
      with `.unique()` and projecting to `row !== null`. Do this
      regardless of `selectedSyndicateId` (the empty-syndicate
      branch should still return `hasActiveCall`, even though the
      Next button can't render there).
  - Update the inline TypeScript type for the empty-syndicate
    branch's `minions: [...]` array to include `isNext`. The
    top-level type should include `hasActiveCall`.
- Verification:
  - `npx tsc --noEmit` green.
  - `MinionBuyPanel` (next task) compiles against the new shape.

### Task 4: Server — auto-promote inside `removeCall` + invariant comments on the replace paths

- task_status: DONE
- Files & locations:
  - `convex/calls.ts:159-207` — modify `removeCall`. Insert a new
    block between the soft-delete patch (`:176-180`) and the
    existing `if (removedWasHead)` block (`:182-205`). New block:
    ```ts
    // Auto-promote the removed-call player's "next" minion, if any.
    // Runs AFTER the soft-delete so `upsertActiveCall` sees no
    // active call for this player and takes the insert branch.
    // Runs BEFORE the existing roll-set block so the head lookup
    // inside that block reflects the newly-inserted call when the
    // queue was otherwise empty.
    const nextRow = await ctx.db
      .query("gamePlayerMinions")
      .withIndex("by_game_player", (q) =>
        q.eq("gameId", call.gameId).eq("playerId", call.playerId),
      )
      .collect();
    const flagged = nextRow.find((r) => r.isNext === true);
    if (flagged) {
      // Clear the flag regardless of whether we re-enqueue, so a
      // stale flag for an unbought minion is GC'd.
      await ctx.db.patch(flagged._id, { isNext: undefined });
      if (flagged.bought) {
        const player = await ctx.db.get(call.playerId);
        if (player) {
          await upsertActiveCall(ctx, {
            gameId: call.gameId,
            player,
            content: { kind: "minion", minionId: flagged.minionId },
          });
        }
      }
    }
    ```
  - Add `import { upsertActiveCall } from "./lib/calls";` if not
    already imported (it is — `convex/calls.ts:17`).
  - **Do not** generate a roll set inside this block. The existing
    `if (removedWasHead) { ... generateRollSetForCall(...) }` block
    immediately below handles roll generation for the new head,
    and that's the only roll-generating event for this scenario.
    When the removed call was mid-queue, no rolls fire — matches
    current behaviour and matches the design rationale (the
    auto-promoted call will roll when it becomes head later).
  - Add a doc comment above the new block referencing this plan
    and explaining the ordering invariant.
  - **Invariant comments on the other call mutations.** Add a
    one-line doc-comment near the top of
    `addOrReplaceCall` (`convex/calls.ts:43-106`) and
    `addOrReplaceCustomCall` (`convex/calls.ts:122-148`)
    explicitly noting that the `gamePlayerMinions.isNext` flag is
    intentionally untouched by the replace-in-place path — the
    auto-promote in `removeCall` is the sole consumer/clearer.
- Verification:
  - `npx tsc --noEmit` green.
  - `npx vitest run convex/calls.test.ts` green; new auto-promote
    tests (Task 6) pass.

### Task 5: UI — Next button in `MinionBuyPanel`

- task_status: DONE
- Files & locations:
  - `src/pages/GameDetailPage.tsx:1244` — add
    `const toggleNext = useMutation(api.minionBuys.toggleNextMinion);`.
  - `src/pages/GameDetailPage.tsx:1262-1270` — add an analogous
    `handleNext` callback that calls `toggleNext({ gameId, minionId })`
    inside a try/catch that writes to the existing `err` state.
  - `src/pages/GameDetailPage.tsx:1340-1368` — after the existing
    Call button and inside the same action `<span>`, conditionally
    render the Next button:
    ```tsx
    {gameState === "playing" &&
      m.bought &&
      data.isSelf &&
      data.hasActiveCall && (
        <button
          type="button"
          className={m.isNext ? undefined : "secondary"}
          aria-pressed={m.isNext}
          title={m.isNext ? "Clear next minion" : "Mark as next minion"}
          onClick={(e) => void handleNext(e, m._id)}
          style={{ padding: "0.25rem 0.6rem", fontSize: "0.85rem" }}
        >
          Next
        </button>
      )}
    ```
    Place it **after** the Call button so the visual order is
    `[note-icon] [Buy/Call] [Next] [Bought-badge]`.
  - Update the destructured fields from `data` if necessary to
    include `hasActiveCall`.
  - No CSS additions: `button` (primary look) vs `button.secondary`
    (muted look) already gives the pressed/active vs idle styling.
    `aria-pressed` covers screen-readers.
- Verification:
  - `npm run typecheck` / `npx tsc --noEmit` green.
  - Manual smoke test in `npm run dev`:
    1. Player with no active call → no Next buttons rendered on
       any minion row.
    2. Player makes a Call → all bought minions show a Next button
       in `.secondary` style.
    3. Click Next on minion A → button switches to primary style;
       other minions stay `.secondary`.
    4. Click Next on minion B → A reverts to `.secondary`, B
       becomes primary.
    5. Click Next on B again → B reverts to `.secondary` (toggle
       off); no minion is now marked.
    6. Mark A as next; GM removes the active Call. Player's queue
       now contains a fresh A call at the head; A's Next button
       is gone (no active call exists yet — wait, the new call IS
       the active call, so the Next button SHOULD reappear on every
       bought minion, all in `.secondary` state).
    7. With a longer queue: Bob has the head; Alice has a Call at
       position 2; Alice marks minion X as next; GM removes Alice's
       call. Result: queue is `[Bob, AliceX]` (AliceX at tail).
       AliceX's Next button is again rendered (because Alice has an
       active call), all `.secondary`.

### Task 6: Tests

- task_status: DONE

#### 6a — New file `convex/minionBuys.test.ts`

- Build a small harness like `convex/calls.test.ts:62-174` but
  scoped to `toggleNextMinion`. Two players, one bought minion
  each, plus an unbought minion.
- Cases:
  1. **Set requires active call.** Player calls `toggleNextMinion`
     with no active call → mutation rejects with the active-call
     error.
  2. **Set succeeds when active call exists.** Player makes a call,
     then `toggleNextMinion(minionX)` → the row's `isNext === true`.
  3. **Clear via toggle is idempotent under normal flow.** From the
     state in (2) (active call still present), call
     `toggleNextMinion(minionX)` again → the row's `isNext`
     projects to `false` (the underlying value is `undefined`).
  4. **Clear does NOT require an active call.** Set up a row
     directly via `t.run(async (ctx) => ctx.db.patch(rowId, { isNext: true }))`
     so the flag is `true` while the player has NO active call
     (bypassing the mutation's set-time gate). Then invoke
     `toggleNextMinion(minionX)`. Assert the call succeeds (no
     throw) and the row's `isNext` projects to `false`. This
     directly exercises the asymmetric active-call gate described
     in Task 2 step 5.
  5. **Uniqueness: setting a second minion clears the first.**
     Player has minionA marked. Player calls `toggleNextMinion(minionB)`
     → minionA's row has `isNext === false`, minionB's row has
     `isNext === true`.
  6. **Bought guard.** Player calls `toggleNextMinion(unboughtId)`
     → rejects with the "must buy" error.
  7. **Ownership guard.** Player A's user calls
     `toggleNextMinion` for a minion that is owned by player A but
     viewed by a different user → `requireGamePlayer` rejects.
     (The GM also rejects because they have no player row.)
  8. **Game-state guard.** Game in `"ready"` state → rejects.

#### 6b — Extensions to `convex/calls.test.ts`

- Reuse the existing harness. New cases:
  1. **Auto-promote when queue would otherwise be empty.** Alice
     calls minionRaven; Alice toggles minionWraith as next; GM
     removes Alice's call. Assertions:
     - `activeCalls` now has exactly one row: Alice / minionWraith.
     - `gamePlayerMinions` for `(game, Alice, Wraith)` has
       `isNext === false` (i.e., `isNext` projects to `false`;
       underlying value should be `undefined`).
     - The auto-promoted call's `createdAt` is strictly greater
       than the removed call's `createdAt` (FIFO tail position).
     - `getCurrentCallDetails` (GM viewer) returns a minion head
       for Wraith, and `rolls !== null` (the `became_head` roll
       set fired).
     - **Second removal does not re-promote.** GM then removes the
       auto-promoted call. Assert `activeCalls` is empty and no
       new `calls` row was inserted (i.e., the flag really was
       cleared by the first auto-promote, not silently re-set).
  2. **Auto-promote at tail when another call is ahead.** Alice
     calls Raven; Bob calls Wraith (Alice is head); Alice toggles
     Wraith as next; GM removes Alice's call. Assertions:
     - `activeCalls` returns `[Bob/Wraith, Alice/Wraith]` in that
       FIFO order.
     - Alice's `isNext` is cleared.
     - The head is still Bob/Wraith; the existing `became_head`
       roll generator does NOT fire for Alice/Wraith (it fires
       only for the new head, which is Bob's — but Bob already
       had rolls from being enqueued earlier... verify the
       behaviour matches the existing `removeCall` semantics on a
       mid-queue removal, i.e., no NEW roll set is generated for
       Alice/Wraith at this point).
     - Actually: in this scenario the removed call WAS the head
       (Alice's), so the existing block does fire and generates a
       fresh `became_head` roll set for the new head, which is now
       Bob's call (the call that was already in queue). Verify
       Bob's call now has a fresh roll set with reason
       `became_head` and a higher `createdAt` than the prior one.
       Alice's auto-promoted call sits at the tail with no roll set
       yet (it'll get one when it eventually becomes head).
  3. **No auto-promote when no flag set.** Standard remove-head
     case without any `isNext` mark. Verify behaviour unchanged
     (one assertion: the removed-call player's only active call is
     gone; no new call inserted for them).
  4. **Defensive: flag clears even if minion is no longer bought.**
     Manually patch a `gamePlayerMinions` row to
     `{ isNext: true, bought: false }` (bypassing the toggle's
     bought-guard, simulating a hypothetical future unbuy path).
     GM removes that player's active call. Assertions: row's
     `isNext === false`, no auto-promote insert happened, queue
     state matches a plain removal.
  5. **`addOrReplaceCall` does NOT clear the flag.** Alice has an
     active call and marks Wraith as next. Alice calls Raven
     (replaces in place via `addOrReplaceCall`). Assert Wraith's
     `isNext` is still `true`.
  6. **`addOrReplaceCustomCall` does NOT clear the flag.** Same as
     (5) but with a custom call replacement.
  7. **`listForPlayer` exposes `isNext` and `hasActiveCall`.**
     - Before any call: `hasActiveCall === false`; every minion's
       `isNext === false`.
     - After a call: `hasActiveCall === true`; flags still
       `false`.
     - After toggling minionX: `isNext === true` for X,
       `false` for others.
     - Visibility: query `listForPlayer` as Bob (a non-self
       participant) for Alice's row — the `isNext` flag is
       returned unredacted (consistent with the public Call queue).
     - Visibility: query `listForPlayer` as the GM — same.

### Task 7: Run the full suite and typecheck

- task_status: DONE
- Commands (project conventions — see other v1 plans):
  - `npx tsc --noEmit`
  - `npx vitest run`
- Both must exit 0 with no new warnings attributable to these
  changes.

## Risks & Mitigations

- **Risk:** The auto-promote insert runs while the removed call's
  patch is still in the same transaction. _Mitigation:_ Convex
  mutations are transactional — `ctx.db.patch` followed by
  `ctx.db.insert` is one atomic write, so the inserted call's
  `by_game_player_active` lookup in `upsertActiveCall` will see the
  removed call as already `isActive: false`. Verified by
  reading the existing `upsertActiveCall` flow at
  `convex/lib/calls.ts:71-77`.
- **Risk:** A race where the player toggles next, the GM removes
  the call, AND the player's mutation tries to re-toggle. Convex's
  serialisable transactions handle this; whichever lands second
  observes the world post-first-commit. The clear branch is
  idempotent.
- **Risk:** A future "unbuy" or "minion deleted" feature would need
  to clear the `isNext` flag too. _Mitigation:_ Out of scope
  (no such mutation exists today), but the defensive `if (bought)`
  gate in the auto-promote block already protects the runtime —
  the worst case is a stale `isNext: true` row that produces no
  enqueue, which we then GC by patching to `false`.
- **Risk:** The UI Next button visibility depends on
  `hasActiveCall`, which is computed by a separate query than the
  one driving the call queue. If the queries refresh out of step,
  the button could briefly flicker. _Mitigation:_ Both queries are
  Convex `useQuery` subscriptions, refreshed in the same batch when
  the underlying `calls` table mutates. A one-frame flicker on
  removal is acceptable and matches existing UI patterns elsewhere
  (e.g., the Call button itself disappears when game state changes).
- **Risk:** Visual ambiguity between "Next is marked" (primary
  style) and "Call" (also primary style for new players accustomed
  to default styling). _Mitigation:_ The Call button is explicitly
  `.secondary` today, so primary = marked-Next is unambiguous within
  this row. `aria-pressed` makes the state explicit for assistive
  tech.

## Verification Criteria

- The schema accepts `isNext` on `gamePlayerMinions`; existing rows
  project to `isNext: false`; no migration required.
- `toggleNextMinion` enforces every gate listed in Task 2 and is
  covered by `convex/minionBuys.test.ts`.
- `removeCall` auto-promotes when, and only when, the removed
  call's player has a `isNext === true` row with `bought === true`;
  the flag is cleared in all "found flag" branches; covered by
  `convex/calls.test.ts`.
- `addOrReplaceCall` and `addOrReplaceCustomCall` leave `isNext`
  untouched (covered by tests in `convex/calls.test.ts`).
- `MinionBuyPanel` renders the Next button if and only if all of
  `(isSelf, gameState === "playing", m.bought, hasActiveCall)` hold,
  with `aria-pressed` and the primary-vs-secondary visual distinction
  in place.
- `npx tsc --noEmit` and `npx vitest run` exit 0.
