# Private and Custom Calls — v2

## Relationship to v1

`plans/2026-04-21-private-and-custom-calls-v1.md` was authored before
several adjacent features shipped — most importantly dice rolls v3
(`plans/2026-04-28-2026-04-28-dice-rolls-v3.md`), the GM-only
`getCurrentCallDetails` deep-dive section
(`plans/2026-04-27-2026-04-27-current-call-rail-section-v1.md`), and the
v5 layout rework that introduced the `YouStrip`, `BottomStrip`, and
renamed `CallQueuePanel` to `CallQueueRail`. v1's line references and
file structure no longer match the codebase, and v1 made no decision
about dice rolls or the new Current Call section. This v2 supersedes v1
in full; v1 is retained for audit only.

The objective is unchanged. The substantive deltas vs. v1 are:

*Revision 2026-04-28b: amended in place after self-review to (a) pin
the `createdReason` rule for cross-kind head transitions, (b)
spell out the `CurrentCallSection` pre-render hook updates, (c)
tighten `recentlyRemovedCalls` field projection, (d) place
`upsertActiveCall` in `convex/lib/calls.ts`, (e) refine
`GameLogDrawer` copy for custom rows, (f) make the label-trim
contract explicit between Task 4 and Task 2, and (g) promote the
legacy-row back-compat test from a risk mitigation into Task 18.*

- **Dice rolls.** Custom calls do not generate `callRollSets` rows; the
  trigger sites in `addOrReplaceCall` and `removeCall` short-circuit on
  `kind === "custom"`. Roll generation otherwise behaves identically to
  today.
- **`getCurrentCallDetails`.** Returns a discriminated-union payload so
  the GM Current Call section can render a custom-head row without
  trying to dereference an absent minion / syndicate / drawbacks /
  rolls.
- **UI placement.** The custom-call form lives in `YouStrip`
  (`src/pages/GameDetailPage.tsx:479-521`), not in `CallQueueRail`.
  `YouStrip` already hosts the Player's self-mutations (Transfer,
  Ledger), is only rendered for Players in non-`ready` games, and is
  not duplicated across the mobile bottom sheet — putting the form
  there avoids the form appearing twice on narrow viewports.
- **Tests.** Extend the existing `convex/calls.test.ts` (which already
  has a `createHarness` and dice-rolls coverage), not a new file.

## Objective

Extend the Call Queue so a Player may enqueue a **custom call**
(free-form text label) in addition to the existing bought-Minion call.
Add a **Private Call** shortcut that creates a custom call whose label
is the literal string `"Private Call"`. All other queue semantics (one
active Call per Player, FIFO, GM removal, recently-removed history,
dice-roll generation for minion calls) are preserved and apply
uniformly to both call kinds.

## Project structure summary

- **Schema.** The `calls` table is at `convex/schema.ts:142-154`
  (`minionId` currently required, no `kind` / `label`). The
  `callRollSets` table is at `convex/schema.ts:163-203` and is
  minion-driven via `minionId` and `skillCount`.
- **Backend mutations.** `addOrReplaceCall` is at
  `convex/calls.ts:34-109`; `removeCall` at `convex/calls.ts:119-152`.
  Both already invoke `generateRollSetForCall` from
  `convex/lib/rolls.ts:146-202` whenever the head changes.
- **Backend queries.** `activeCalls` is at `convex/calls.ts:162-234`
  (GM viewers receive a `rolls` field, non-GM viewers do not — the
  field is omitted, not nulled). `getCurrentCallDetails` is at
  `convex/calls.ts:248-311` and dereferences minion + syndicate +
  drawbacks + rolls; this is the query most affected by the new kind.
  `recentlyRemovedCalls` is at `convex/calls.ts:316-354`.
- **Frontend display surfaces.**
  - `CallQueueRail` at `src/pages/GameDetailPage.tsx:1404-1496` — the
    queue list, rendered in both the right rail
    (`src/pages/GameDetailPage.tsx:108`) and the mobile bottom sheet
    (`src/pages/GameDetailPage.tsx:2034`). Dice render inline for the
    head row when the viewer is the GM
    (`src/pages/GameDetailPage.tsx:1482-1489`).
  - `CurrentCallSection` at `src/pages/GameDetailPage.tsx:2070`+ — the
    GM-only Current Call deep-dive at the top of the main column.
  - `MinionBuyPanel` at `src/pages/GameDetailPage.tsx:1158-1302` —
    hosts the existing per-Minion **Call** button at
    `src/pages/GameDetailPage.tsx:1281-1290`. It is gated on the
    Player having selected a syndicate
    (`src/pages/GameDetailPage.tsx:1028-1029`), which is the original
    motivating problem: a Player without a Syndicate has no call
    affordance today.
  - `YouStrip` at `src/pages/GameDetailPage.tsx:479-521` — the
    Player's self-mutation strip (Transfer / Ledger), visible only
    when `viewer.playerId !== null && gameState !== "ready"`
    (`src/pages/GameDetailPage.tsx:75-76`).
  - `GameLogDrawer` at `src/pages/GameDetailPage.tsx:760-800` —
    renders "Recently removed calls" via
    `api.calls.recentlyRemovedCalls`; today dereferences
    `c.minionName` directly.
- **Auth helpers.** `requireGamePlayer` at `convex/lib/auth.ts:65-81`
  is the existing chokepoint for Player-only mutations; matches what
  the minion-call mutation uses.
- **Existing tests.** `convex/calls.test.ts` (670 lines) already has a
  `createHarness()` covering GM, Alice, Bob, an outsider, a syndicate
  with two minions and two drawbacks, and per-player buys. Extend in
  place; do not create a new file.

## Key findings & rationale

1. **Custom calls are minion-less by definition.** Every existing
   downstream that joins through `minionId` (queue rendering, the
   Current Call section, dice roll generation, recently-removed log)
   must branch on `kind`. A discriminated union (`kind: "minion"` vs.
   `kind: "custom"`) at the `calls` table — defaulting `undefined → "minion"` for back-compat — is the smallest change that lets readers
   pattern-match exhaustively without a data migration.

2. **Dice rolls do not apply to custom calls.** The skill die is
   derived from `minion.skills.length`
   (`convex/lib/rolls.ts:33-38`); a custom call has no minion and no
   skill source. Chaos is keyed off the same trigger event, not an
   independent semantic, so it is also skipped. `addOrReplaceCall` and
   `removeCall` therefore short-circuit `generateRollSetForCall` when
   the (new or newly-promoted) head call has `kind === "custom"`.
   Switching minion-call → custom-call **on the head** leaves the
   pre-swap roll set in place but emits no new roll; switching
   custom-call → minion-call **on the head** emits a fresh roll set
   with `reason: "minion_replaced"`. This keeps the roll set
   immutable-and-append-only invariant from dice-rolls v3 intact.

3. **Replace-in-place must work across kinds.** Rule 22's
   "one active call per player; preserve `_id` and `createdAt` when
   replacing" invariant is independent of `kind`. Both mutations must
   funnel through a single helper that owns this contract and rewrites
   the kind-discriminator + mutually-exclusive content fields
   atomically (always set `kind`; always `undefined` the unused field).
   This prevents drift where a row could end up with both `minionId`
   and `label` populated.

4. **`getCurrentCallDetails` becomes a discriminated union.** The
   existing GM Current Call section deeply joins minion + syndicate +
   drawbacks + rolls. None of those exist for a custom head call, and
   `null`-ing the whole payload (the v1 fallback for "minion missing")
   would be wrong: the section should still show the caller, label,
   timestamp, and Remove button. Returning
   `{ kind: "minion", call, minion, syndicate, rolls } | { kind: "custom", call, label }` lets the React component branch
   exhaustively without lying about the empty state.

5. **`YouStrip` is the right home for the form.** The original v1 plan
   put the form inside `CallQueuePanel`, which today is rendered both
   in the right rail and the mobile bottom-sheet — the form would
   appear twice on narrow viewports. `YouStrip`:
   - already hosts the Player-self mutations (Transfer at
     `src/pages/GameDetailPage.tsx:516`, Ledger at
     `src/pages/GameDetailPage.tsx:518`),
   - is only rendered when `gameState !== "ready"` and the viewer is
     a Player (`src/pages/GameDetailPage.tsx:76`),
   - already uses the `ActionPopover` primitive
     (`src/pages/GameDetailPage.tsx:600-697`) for self-mutations,
     which is exactly the right shape for a small text input + two
     buttons.
   The custom-call form therefore drops in as a third button —
   `Custom Call` — opening an `ActionPopover` with the input,
   `Add custom call`, and `Private Call` actions. This also makes the
   feature reachable for a Player who has not selected a Syndicate
   (the v1 motivation), because `YouStrip` does not gate on
   `selectedSyndicateId`.

6. **The per-Minion `Call` button stays.** It's the existing,
   discoverable affordance for minion calls and is colocated with the
   minion list. Custom calls are additive, not a replacement.

## Implementation Plan

### Phase 1 — Schema

- [x] Task 1. In `convex/schema.ts:142-154`, mutate the `calls` table:
  - Make `minionId` optional: `minionId: v.optional(v.id("minions"))`.
  - Add `kind: v.optional(v.union(v.literal("minion"), v.literal("custom")))`. Readers treat `undefined` as `"minion"` for
    back-compat with existing rows (every existing row has `minionId`
    set and no `kind`).
  - Add `label: v.optional(v.string())`.
  - **Indexes unchanged.** `by_game_active_time`,
    `by_game_removed_time`, `by_game_player_active` all encode
    kind-independent invariants. No data migration required because
    every existing row's projected kind is `"minion"`.

  Rationale: smallest backward-compatible schema delta that admits
  custom calls. No `callRollSets` change is required because rolls
  remain minion-keyed.

### Phase 2 — Backend mutations (`convex/calls.ts`)

- [x] Task 2. Extract the "one active call per player; preserve `_id`
  and `createdAt` on replace" invariant into a helper
  `upsertActiveCall(ctx, { gameId, player, content })` placed in a
  new file `convex/lib/calls.ts` (matches the existing
  `convex/lib/{auth,rolls}.ts` convention; both mutations import it).
  `content` is a discriminated union
  `{ kind: "minion"; minionId } | { kind: "custom"; label }`. **Label
  trim contract:** `content.label` is *already trimmed and validated*
  by the calling mutation (Task 4); the helper does no further
  trimming and only does direct string equality on the trimmed
  value. The helper:
  - Looks up the existing active call via the
    `by_game_player_active` index.
  - If found and `content` matches kind+payload byte-for-byte
    (`existing.kind ?? "minion"` equals `content.kind` AND the
    payload field matches: same `minionId` for minion, same
    already-trimmed `label` for custom), return the existing id as
    a no-op (zero writes; the caller observes unchanged
    `createdAt`).
  - If found and `content` differs (including the
    legacy-row case where `existing.kind` is `undefined` and the
    new `content.kind` is `"minion"` — this performs a one-time
    idempotent kind-stamping patch on the legacy row), `ctx.db.patch`
    with the kind and the active payload and **explicitly
    `undefined` the unused field** (set `minionId: undefined` for
    a custom patch and `label: undefined` for a minion patch — the
    `: undefined` idiom is already used to clear optional fields
    elsewhere, e.g. `convex/games.ts:105`). Preserve `createdAt`.
    **Return** `{ id: existing._id, prevKind: existing.kind ?? "minion", changed: true }` so the caller can decide whether
    and how to fire dice rolls (Tasks 3 and 4 below). For the no-op
    branch, return `{ id, prevKind, changed: false }`. For the
    fresh-insert branch, return `{ id: newId, prevKind: null, changed: true }`.
  - Otherwise (no existing active call), `ctx.db.insert` a fresh row
    with
    `{ gameId, playerId: player._id, kind, ...content, createdAt: Date.now(), isActive: true }`. Return the new id with
    `prevKind: null`.

  Rationale: centralises the kind/content drift defence (Decision 3)
  and the queue-position invariant in one place; both mutations
  funnel through it. The `prevKind` return is what lets Task 3
  resolve the `createdReason` ambiguity for cross-kind head
  transitions without re-reading the row.

- [x] Task 3. Refactor `addOrReplaceCall` (`convex/calls.ts:34-109`)
  to use the helper:
  - The minion-bought precondition stays
    (`convex/calls.ts:42-54`).
  - Replace the inline insert/patch branch with
    `upsertActiveCall(ctx, { gameId, player, content: { kind: "minion", minionId: args.minionId } })`.
  - Dice-rolls trigger logic uses the helper's `{ id, prevKind, changed }` return and the post-upsert head id. The
    **`createdReason` rule** for the resulting roll set is:
    - `changed === false` (idempotent same-minion no-op): no roll
      fires (matches today).
    - The upserted row is **not** the head: no roll fires; rolls
      will fire when the call advances (handled in `removeCall`).
    - The upserted row **is** the head AND `prevKind === "minion"`
      AND it was a fresh insert (`prevKind === null` is impossible
      here when the row is the head and the upsert was a fresh
      insert into an empty queue — see next bullet) OR the row
      previously had a different `minionId` (in-place minion-to-
      minion swap on the head): fire `generateRollSetForCall` with
      `reason: "minion_replaced"` — matches today's semantics.
    - The upserted row **is** the head AND (`prevKind === null`
      i.e. fresh insert into an empty queue, OR `prevKind === "custom"`
      i.e. cross-kind upgrade where there was no prior minion roll
      set to "replace"): fire `generateRollSetForCall` with
      `reason: "became_head"`. *This is the new rule*: when the
      prior head's `kind` was custom (or absent), the row's minion
      is **becoming** a head minion for the first time, so
      `became_head` is the correct semantic, not `minion_replaced`.

  Rationale: the `prevKind === "custom"` branch is the only new
  path; existing minion-only flows behave exactly as today. The
  rule is captured by the rule-of-thumb "`minion_replaced` requires
  a prior minion roll set on the same row; everything else is
  `became_head`".

- [x] Task 4. Add a new mutation `addOrReplaceCustomCall({ gameId, label })`:
  - `requireGamePlayer(ctx, args.gameId)` and assert
    `game.state === "playing"` (matches the existing minion
    mutation's preconditions).
  - **Validate and trim `label`** *in this mutation, exactly once*:
    coerce to string (the validator already does this), trim; reject
    empty / whitespace-only; reject `length > 80` after trim. Throw
    plain `Error` with a concise user-readable message; the form
    surfaces it inline. The trimmed value is what flows into the
    helper — see Task 2's label trim contract.
  - Call `upsertActiveCall(ctx, { gameId, player, content: { kind: "custom", label: trimmedLabel } })`.
  - **No `generateRollSetForCall` call.** Custom calls do not roll
    dice (Decision 2). If this upsert turned a *previous* minion
    head into a custom head, no new roll fires; the previous
    minion call's existing roll set remains attached to its
    historical rows but is no longer surfaced because the call's
    `kind` is now `"custom"`.

  Rationale: keeps the Private button a pure client-side shortcut
  (it just supplies `"Private Call"` as the label); the server has
  no concept of "private". Trimming exactly once at the mutation
  boundary keeps equality comparisons in the helper safe from
  trailing-whitespace mismatches.

- [x] Task 5. Update `removeCall` (`convex/calls.ts:119-152`) to gate
  the new-head roll generation on `kind`:
  - The "removed call was the head; advance head; roll for new
    head" branch (`convex/calls.ts:142-150`) loads the new head
    row and resolves `newHeadKind = newHead.kind ?? "minion"`. It
    calls `generateRollSetForCall({ callId: newHead._id, reason: "became_head" })` **only when `newHeadKind === "minion"`**.
    If the new head is a custom call, the soft-delete proceeds but
    no roll is generated.
  - The `reason` here is unconditionally `became_head` (matches
    today and matches the rule of thumb in Task 3: a fresh roll on
    a different row is always `became_head`; `minion_replaced` is
    reserved for in-place edits to the *same* row).
  - All other behaviour (idempotency, soft-delete fields,
    `removedByGmId`) is unchanged.

  Rationale: keeps roll-set immutability invariants from dice-rolls
  v3 intact while extending naturally to the custom-head case.

### Phase 3 — Backend queries (`convex/calls.ts`)

- [x] Task 6. Update `activeCalls` (`convex/calls.ts:162-234`) to
  branch on `kind`:
  - Resolve `kind` per row as `c.kind ?? "minion"` (back-compat).
  - Minion branch (`kind === "minion"`): unchanged — load minion,
    return `{ kind: "minion", minionId, minionName }` plus shared
    fields. The GM-only `rolls` field continues to be added
    conditionally (`convex/calls.ts:219-227`).
  - Custom branch (`kind === "custom"`): skip the `ctx.db.get(c.minionId)` call and return
    `{ kind: "custom", label: c.label ?? "" }` plus shared fields.
    The GM `rolls` field is **omitted** for custom rows (no roll
    set ever exists; emitting `rolls: null` would be misleading).
    Defence in depth against an aberrant row with both fields set:
    discriminator wins; the renderer never reads `minionName` on a
    `kind: "custom"` row.

  Rationale: keeps the live-subscribed query as the UI's source of
  truth and avoids a second round-trip from the client.

- [x] Task 7. Update `recentlyRemovedCalls`
  (`convex/calls.ts:316-354`) with the same kind-branching the
  query in Task 6 uses. Per-row return shape:
  - **Minion row** (`kind === "minion"`, including the legacy
    `kind === undefined` projection): `{ _id, kind: "minion", playerId, playerName, minionId, minionName, createdAt, removedAt }`. Preserves today's `minionId`/`minionName` keys.
  - **Custom row** (`kind === "custom"`): `{ _id, kind: "custom", playerId, playerName, label, createdAt, removedAt }`. **Omit
    `minionId` and `minionName` entirely** — do not project them
    as `null`/`undefined`; the discriminated union is the contract
    and Task 18 asserts genuine absence via
    `Object.prototype.hasOwnProperty.call`.

  Rationale: matches the active-queue projection (Task 6) and lets
  the Game Log drawer (Task 12) branch on `kind` exhaustively
  without dereferencing fields that don't exist.

- [x] Task 8. Update `getCurrentCallDetails`
  (`convex/calls.ts:248-311`) to return a discriminated union:
  - **`kind: "custom"`:** when the head call is custom, return
    `{ kind: "custom", call: { _id, createdAt, playerId, playerName }, label }`. Skip every minion / syndicate / drawback / roll-set
    fetch — none apply.
  - **`kind: "minion"`:** the existing payload, wrapped in
    `{ kind: "minion", call, minion, syndicate, rolls }` (where
    `call`, `minion`, `syndicate`, `rolls` are exactly the existing
    fields). The same defensive nulls apply (missing minion or
    syndicate → return `null` from the query, matching today).
  - Continue to return `null` for an empty queue.

  Rationale: lets `CurrentCallSection` render a meaningful header
  for a custom head (caller, label, time, Remove button) without
  fabricating a minion or syndicate.

- [x] Task 9. Define and export a TypeScript discriminated-union
  type `CallRow` in `convex/calls.ts` reflecting the shared shape
  (`_id`, `playerId`, `createdAt`, `playerName`) plus the kind-
  specific payload (`{ kind: "minion"; minionId; minionName; rolls? }` | `{ kind: "custom"; label }`). Used by the client for
  exhaustive switch statements.

### Phase 4 — Client (`src/pages/GameDetailPage.tsx`)

- [x] Task 10. Update `CallQueueRail` (`:1404-1496`):
  - Replace the unconditional `<strong>{c.minionName}</strong>`
    render at `:1448` with a `kind` switch:
    - `"minion"` → existing layout, including the per-row
      `NoteIcon` against `{ kind: "minion", minionId: c.minionId }`
      (`:1455-1464`).
    - `"custom"` → `<strong>{c.label}</strong>`. **No** `NoteIcon`
      (custom calls have no notes target) and **no** dice display
      block (`:1482-1489`); the `i === 0 && "rolls" in c` guard
      already handles the absence of `rolls` for custom rows
      because Task 6 omits the field.
  - GM Remove button is unchanged — works on both kinds.

- [x] Task 11. Update `CurrentCallSection` (`:2070`+) to switch on
  `data.kind`. **This includes the pre-render hooks at
  `:2088-2096`, not just the JSX** — getting the JSX right while
  leaving the hooks unchanged would have the custom-head case
  subscribe `api.notes.listNotesForTarget` against
  `data.minion._id` (which doesn't exist on the custom branch) and
  crash at hook eval time. Concretely:
  - Replace `const minionId = data ? data.minion._id : null;` with
    `const minionId = data && data.kind === "minion" ? data.minion._id : null;` so the `useMemo`/`useQuery` for notes is
    `"skip"` on a custom head and only fires for a minion head.
  - `"minion"` branch: today's render path, unchanged after the
    payload is unwrapped (the existing `data.minion`,
    `data.syndicate`, `data.rolls` references continue to work).
  - `"custom"` branch: render only the header card —
    `<strong>{data.call.playerName}</strong> → <strong>{data.label}</strong>` plus the timestamp and the Remove button. No notes
    column, no context column, no dice (none exist). A muted note
    line: *"Custom calls have no Minion or Syndicate context."* so
    the empty space is intentional rather than mistakable for a
    loading state.

- [x] Task 12. Update `GameLogDrawer`'s "Recently removed calls"
  section (`:760-800`). At `:783-786`, branch on `c.kind`:
  - **Minion row:** unchanged — `<strong>{c.playerName}</strong> called <strong>{c.minionName}</strong>`.
  - **Custom row:** swap the connector verb from "called" to
    "posted" so the sentence reads naturally for free-form labels:
    `<strong>{c.playerName}</strong> posted <strong>{c.label}</strong>`. ("Alice called Need GM" reads as a typo;
    "Alice posted Need GM" is unambiguous.)
  - The "Removed at HH:MM" line is shared and stays as-is.

- [x] Task 13. Add a `CustomCallButton` + `CustomCallForm` to
  `YouStrip` (`:479-521`):
  - **Visibility.** Render only when
    `gameState === "playing"` (Transfer is already gated this way
    at `:515`; identical posture). For `gameState === "archived"`,
    omit the button (mutations would fail anyway).
  - **Button.** Sits between Transfer and Ledger, labelled
    `Custom Call`.
  - **Popover content** (using the existing `ActionPopover` at
    `:600-697`, title `"Custom Call"`):
    - A single-line `<input>` controlled by component state,
      `maxLength={80}`, `placeholder="Label (e.g. Need GM)"`,
      with `aria-label="Custom call label"`.
    - A muted help line: *"Replaces your current call, if any."*
      (makes the one-active-per-player rule discoverable).
    - Primary button **Add custom call** — disabled while the
      trimmed input is empty; on click calls
      `api.calls.addOrReplaceCustomCall({ gameId, label: input.trim() })` and closes the popover on success.
    - Secondary button **Private Call** — always enabled;
      calls the same mutation with the literal
      `label: "Private Call"`. Includes `title="Posts the text 'Private Call' to the queue."` so the label is not misread
      as a visibility flag (Decision 5 of v1; still applies).
    - Error surface (matches the existing `Transfer` popover's
      pattern).

  Rationale: colocating the form with Transfer / Ledger gives the
  Player a single place to perform self-actions, makes the form
  reachable without a Syndicate, and avoids duplicating the form
  across the right rail and mobile bottom-sheet because `YouStrip`
  is rendered once at the top of the page.

- [x] Task 14. Leave the per-Minion **Call** button in
  `MinionBuyPanel` (`:1281-1290`) unchanged. Its behaviour is
  identical: clicking still issues the existing
  `api.calls.addOrReplaceCall` mutation, which now flows through
  `upsertActiveCall` but exposes the same surface to the client.

### Phase 5 — Tests (extend `convex/calls.test.ts`)

- [x] Task 15. Add a new `describe("addOrReplaceCustomCall", ...)`
  block reusing the existing `createHarness()` helper. Cover:
  - Custom call inserts when no active call exists; row has
    `kind === "custom"`, `label` set, `minionId` undefined,
    `isActive === true`.
  - Private Call shortcut is exactly a custom call with
    `label === "Private Call"` (asserted via the same insert
    path).
  - Same-label custom resubmission is a no-op (no new row, no
    `createdAt` change).
  - **Replace minion → custom** preserves `_id` and `createdAt`,
    flips `kind`, sets `label`, and **clears** `minionId` (Convex
    permits an explicit `undefined` patch on an optional field).
  - **Replace custom → minion** preserves `_id` and `createdAt`,
    flips `kind`, sets `minionId`, and clears `label`.
  - Empty/whitespace-only labels rejected with a clear error;
    `length > 80` rejected.
  - Non-Player callers rejected (GM, outsider, anonymous);
    `game.state === "ready"` and `"archived"` rejected with the
    "only while playing" error.

- [x] Task 16. Extend the existing dice-rolls describe block(s) in
  the same file with two cases:
  - **Custom call does not generate a roll set.** Insert a custom
    head call from an empty queue; assert `callRollSets` for that
    `(gameId, callId)` is empty.
  - **Replace-in-place across kinds.** With a minion call as
    head, replace it with a custom call and assert no new
    `callRollSets` row is written (the pre-swap roll set is
    untouched). Then replace it back with a minion call and
    assert a fresh `callRollSets` row is written with
    `createdReason === "became_head"` (per the Task 3 rule:
    `minion_replaced` requires a *prior minion* on the same row;
    when the prior head's kind was `"custom"`, the row's minion
    is becoming a head minion for the first time, so
    `became_head` is the correct reason). Finally, replace the
    minion call again with a *different* `minionId` while it is
    still the head and assert that roll set has
    `createdReason === "minion_replaced"` — this is the only
    path that produces `minion_replaced` and it is unchanged
    from today.
  - **Removal advancing to a custom new head.** Queue
    `[minion(A), custom(B)]`; remove the head minion call; assert
    no new roll set is generated for B. Conversely with
    `[custom(A), minion(B)]`, removing A's head emits a fresh
    roll set for B with `createdReason === "became_head"`.

- [x] Task 17. Extend the existing `getCurrentCallDetails` describe
  block with:
  - **Custom head returns `kind: "custom"`** with the caller's
    name, the label, and the call timestamp; no `minion`,
    `syndicate`, or `rolls` keys are present.
  - **Minion head still returns `kind: "minion"`** with the
    existing fields (regression guard for the wrap).

- [x] Task 18. Extend the `recentlyRemovedCalls` and `activeCalls`
  describe blocks with kind-discrimination assertions:
  - A custom row in the response has `kind === "custom"` and
    `label` set (and `Object.prototype.hasOwnProperty.call(row, "minionName") === false` and same for `minionId`); a minion row
    has `kind === "minion"` and `minionName` set (and
    `hasOwnProperty(row, "label") === false`). The non-GM payload
    for a custom row continues to omit the `rolls` key (matches
    the existing assertion style at the top of
    `convex/calls.ts:228-230`).
  - **Legacy back-compat regression test** (promoted from Risk 1
    mitigation). Insert a `calls` row directly via
    `t.run((ctx) => ctx.db.insert("calls", { ... }))` with no
    `kind` field set (mirroring rows written before this plan
    shipped). Assert that both `activeCalls` and
    `recentlyRemovedCalls` project the row with `kind === "minion"`
    and the existing `minionName` field. Also assert that
    `addOrReplaceCall` against the same legacy row with the same
    `minionId` is an idempotent no-op (no new roll set, unchanged
    `createdAt`) — even though the helper sees `existing.kind === undefined`, its `existing.kind ?? "minion"` projection makes
    the equality check succeed.

### Phase 6 — Documentation

- [x] Task 19. Update the file-top doc comment in
  `convex/calls.ts:18-32` to:
  - Mention the two call kinds (`"minion"`, `"custom"`).
  - Note that "Private Call" is a client-side shortcut for a
    custom call with the literal label `"Private Call"` and
    **not** a visibility feature — every active call remains
    visible to every game participant.
  - Note that custom calls do not generate roll sets and that the
    natural-1 / dice-rolls invariants from v3 only apply to
    minion calls.

## Verification criteria

- A Player whose Syndicate is unset can submit a Private Call from the
  `YouStrip` Custom Call popover and see it appear in the queue,
  attributed to them with the text `"Private Call"`.
- A Player with an existing Minion call who submits a custom call ends
  up with exactly **one** active queue row, preserving `_id` and
  `createdAt`, with `kind === "custom"` and `label` set; and vice
  versa.
- Submitting the same custom label twice in a row results in zero new
  DB writes (observable via unchanged `createdAt` and queue order).
- GMs can remove custom calls; removed custom calls appear in the
  Game Log drawer's "Recently removed calls" with the label preserved.
- Clients never render `"Unknown Minion"` for a custom call; the
  `kind` switch always renders the label instead.
- Server rejects empty / whitespace / `>80`-char labels with a clear
  error surfaced inline by the form.
- `addOrReplaceCustomCall` rejects callers who are not Players in the
  game (GM, outsider, anonymous) and rejects games not in `playing`.
- **Dice-rolls invariants preserved.** Custom calls write zero
  `callRollSets` rows. Replace-in-place across kinds writes a fresh
  roll set only when the resulting head call is `kind === "minion"`
  AND its `minionId` differs from the previous head's `minionId`.
  Removal advancing to a custom new head writes no roll set;
  advancing to a minion new head writes one with
  `createdReason === "became_head"`.
- **`getCurrentCallDetails`** returns a discriminated union; the
  GM Current Call section renders a clean caller / label / time /
  Remove header for a custom head, with no minion / syndicate /
  notes / dice subsections.
- All existing minion-call paths remain green: same-minion replace
  is still a no-op; calling an unbought minion still fails;
  same-minion replace fires no roll; minion-replace on the head
  still fires `reason: "minion_replaced"`.
- `convex/calls.test.ts` covers all of the above.

## Potential risks and mitigations

1. **Back-compat read of legacy rows.** Every existing row has
   `minionId` set and no `kind`. Readers project `kind ?? "minion"`,
   so legacy rows are indistinguishable from explicit minion rows.
   Mitigation: enforced in Tasks 6–8 with the explicit fallback;
   the regression test in Task 18 inserts a row directly with no
   `kind` field and asserts both queries treat it as a minion row
   AND that an idempotent same-minion `addOrReplaceCall` is a
   no-op against the legacy shape.

2. **Drift between `kind` and content on replace.** A row that ends
   up with both `minionId` and `label` set, or neither, would break
   every consumer. Mitigation: the `upsertActiveCall` helper in
   Task 2 always sets `kind` and explicitly `undefined`s the unused
   field on every patch; tests in Task 15 assert the cleared field
   is genuinely absent after a swap.

3. **Custom-head dice ambiguity.** A future caller of
   `generateRollSetForCall` could attempt to roll for a custom head
   if the kind-gate is missed. Mitigation: keep the gate at the
   trigger sites (Tasks 3, 4, 5) and add the test in Task 16 that
   asserts zero `callRollSets` rows for a custom head. The helper
   itself already gracefully tolerates a missing minion
   (`convex/lib/rolls.ts:171-177`), which is a second line of
   defence.

4. **Untrusted free-form label.** A long or HTML-ish label could
   bloat rows or break the UI. Mitigation: server-side trim +
   length cap of 80 chars in Task 4; the client renders labels as
   text via React's default escaping — never
   `dangerouslySetInnerHTML`. The tests in Task 15 cover the cap
   and the empty-string rejection.

5. **"Private" misread as a visibility feature.** The button label
   could confuse Players into thinking the call is hidden from
   the GM. Mitigation: queue visibility is unchanged for everyone;
   the popover's button has a `title` attribute clarifying the
   behaviour (Task 13); the file-top doc comment in `convex/calls.ts` documents it (Task 19).

6. **Index pressure.** Filtering on `kind` could tempt adding a new
   index. Mitigation: do not. `activeCalls` already `.collect()`s
   the active set per game; in-memory kind-branching is free at
   the typical queue sizes (≤ rosterSize active rows).

7. **Notes against custom-head calls.** Notes are attached to game
   / syndicate / minion targets only (`convex/schema.ts:215-219`);
   there is no "custom call" target. The `attachedRollSetId`
   freezing logic in `convex/notes.ts` will simply not fire for a
   custom head because no roll set exists. Mitigation: no schema
   or code change required; a clarifying sentence in the file-top
   doc comment of `convex/notes.ts` is optional but not in scope.

## Alternatives considered (and rejected)

1. **Separate `customCalls` table.** Keeps the existing `calls`
   schema unchanged and merges at query time. Rejected: duplicates
   the one-active-per-player invariant across two tables, doubles
   the indexes, complicates FIFO ordering across tables, makes GM
   removal non-uniform, and forces every reader to reimplement the
   merge. The schema delta in Task 1 is strictly smaller in code.

2. **Discriminated-union mutation args on `addOrReplaceCall`.**
   Instead of a new mutation, extend the existing one with
   `v.union(v.object({ minionId }), v.object({ label }))`. Rejected:
   conflates two distinct user intents under one name, forces every
   call-site and every test to runtime-discriminate, and makes the
   Private button's implementation harder to read. Two named
   mutations are clearer.

3. **First-class "Private" visibility flag.** Treat Private Call as
   GM-only- or originator-only-visible. Rejected: contradicts the
   original feedback ("just a custom call labelled 'Private Call'"),
   introduces a per-Player queue filtering model, and balloons
   scope. The `"Private Call"` literal label is sufficient.

4. **Roll-on-custom-call with synthetic skill count.** Treat custom
   calls as `skillCount = 0` so a chaos die still fires. Rejected:
   would silently downgrade the dice-rolls v3 invariant that
   `skillCount` is a snapshot of `minion.skills.length`, and the
   chaos die has no semantic meaning detached from a minion-bound
   action. The cleaner contract is "custom calls have no rolls" —
   simple to explain and simple to enforce.

5. **Form in `CallQueueRail`.** v1's choice. Rejected here because
   `CallQueueRail` is rendered twice on the page (right rail +
   mobile bottom-sheet), the form would appear twice on narrow
   viewports, and `CallQueueRail` is also rendered for the GM —
   who has no use for a Player-only mutation form. `YouStrip`
   (Task 13) is gated correctly out of the box.
