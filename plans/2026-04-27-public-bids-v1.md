# Public Bids

## Objective

Add a new GM-driven, per-game ceremony — **Public Bids** — to Governance. The GM opens a bid round; every Player simultaneously submits a non-negative integer POWER amount; everyone sees everyone else's bids sorted by amount descending in real time; non-zero bid amounts must be unique across the round; when the GM closes the round, every Player's bid is paid to the bank atomically (one ledger entry per non-zero bidder, `players.power` patched in the same transaction).

This feature must integrate cleanly with:
- the rule-bound game lifecycle (`convex/games.ts:129-185`, Rule 10),
- the append-only POWER ledger and `players.power` materialised cache (Rules 18, 19, 25; `convex/ledger.ts:1-256`),
- the Rule 19 `source` enum extension pattern established by Treason Grants (`plans/2026-04-27-treason-grants-v1.md`, Tasks 1–2),
- the centralised auth helpers (`convex/lib/auth.ts:53-125`, Rule 24),
- the `GameDetailPage` main-column section pattern used by `TreasonGrantsSection` (`src/pages/GameDetailPage.tsx:110-114`, `1779-1834`).

## Confirmed design decisions

These decisions resolve the ambiguities in the task description and lock the feature's behaviour. Implementation tasks below reference them by number.

1. **Scope**: per-game. A bid round is bound to one `gameId`. No cross-game persistence.
2. **Authoring**: GM-only opens and closes a round. Players cannot start or end a round.
3. **Lifecycle**:
   - **Start a round** allowed only while `game.state === "playing"`. Disallowed in `ready` and `archived` (consistent with all POWER-moving operations: transfers, minion buys, treason-grant takes).
   - **Place/update a bid** allowed only while the round is `open` AND `game.state === "playing"`.
   - **End a round** (settlement) allowed only while the round is `open` AND `game.state === "playing"` (defence-in-depth: we never settle into an archived game).
   - At most **one `open` round per game at any time**. Starting a new round while another is open is rejected.
4. **Round status enum**: `"open" | "ended" | "cancelled"`. `ended` settled with payment; `cancelled` ended without payment (see Decision 11).
5. **Bid amount**: integer, `0 ≤ amount ≤ <player's current POWER + a sanity cap>`. Concretely: `Number.isInteger(amount) && amount >= 0 && amount <= 1_000_000`. **POWER can go negative on settlement** — by Rule 17 there is no floor. The server will not reject a bid because the player can't afford it; that is a deliberate gameplay risk (matches the existing transfer semantics, which also let POWER go negative).
6. **Uniqueness rule (per the task)**: within a single round, two bids may both be `0`, but two bids with the same `> 0` amount are rejected at place-bid time. This is enforced by a server-side scan in the same transaction as the upsert.
7. **Default state for non-bidders**: a Player who never places a bid is implicitly treated as **bid 0**. They are not displayed in the sorted bid list as having a bid; they appear in a separate "not yet bid" group so the GM can see who is still pending. They pay nothing on settlement.
8. **Withdraw / change**: a Player may freely change their bid (including back to 0) while the round is `open`. Re-submitting an identical amount is a no-op. There is **no separate withdraw mutation** — placing 0 conveys withdrawal.
9. **Concurrency on uniqueness**: two players hitting `placeBid` with the same non-zero amount race; Convex transactions serialise, so the second commit re-reads the index and rejects with a clear error.
10. **Settlement (end)**: GM clicks "End bid". In **one Convex transaction**:
    - read every bid in the round,
    - for each bid with `amount > 0`: insert one ledger entry (`source: "bid"`, `delta: -amount`, `reason: <label or "Public bid">`, `createdByUserId: gmId`), patch `players.power -= amount`,
    - patch the round to `status: "ended"`, `endedAt: now`, `endedByUserId: gmId`.
    Bids with `amount === 0` write **no ledger entry** (no POWER change → no audit row). The bid rows themselves remain attached to the round forever as the historical record.
11. **Cancel (no settlement)**: include a GM-only `cancelBidRound` mutation that sets `status: "cancelled"`, `endedAt`, `endedByUserId` and writes **no ledger entries**. The task description doesn't mention cancellation, but the GM needs an escape hatch (e.g. opened by accident, ambiguous instructions to players). Confirmation in the UI explicitly distinguishes "End (collect)" vs "Cancel (no payment)".
12. **Ledger source**: extend the `powerLedgerEntries.source` enum with a new literal `"bid"` (matches the Treason-Grants pattern in `convex/schema.ts:110-117`, Decision 6 of `plans/2026-04-27-treason-grants-v1.md`). Auditability: a public bid is its own revenue path and must be distinguishable from arbitrary `bank_in` activity.
13. **Visibility**: every participant (GM + every Player in the game) sees the open round (if any), the full sorted bid list with display names and amounts, and a "not yet bid" list of remaining roster members. Non-participants are rejected at the query layer per Rule 24.
14. **Round label** (optional): the GM may attach a free-text `label` to the round (1–120 chars, trimmed; or omitted) when starting it (e.g. "Auction: Senate seat"). The label is shown in the panel header and copied verbatim into each settlement ledger entry's `reason` for traceability. If absent, ledger entries use the literal string `"Public bid"`.
15. **History**: after `ended`/`cancelled`, the round and its bids remain queryable for the GM and Players (read-only) so the panel can show the most recent N rounds for context. Default surface: the current open round + the most recent 5 ended/cancelled rounds.
16. **UI placement**: a new "Public Bid" section on the **left main column** of the game page, immediately above or below Treason Grants (see Decision 14 of the Treason Grants plan; `src/pages/GameDetailPage.tsx:96-129`). Rationale: the section needs full width to render a roster-sized table of bids with display names and inputs, and the right rail is reserved for compact, frequently-changing summaries (Call Queue, POWER Standings).
17. **No automatic "round-over" trigger**: the round only ends when the GM explicitly clicks End or Cancel. Even if every Player has placed a non-zero bid, settlement does not auto-fire.

## Implementation Plan

### Phase 1 — Schema

- [ ] Task 1. Extend the `powerLedgerEntries.source` validator in `convex/schema.ts:110-117` with a new literal `v.literal("bid")`. Update the inline rule pointer comment to also reference this plan. Rationale: Decision 12; mirrors the Treason Grants schema-extension pattern.
- [ ] Task 2. Update the `LedgerSource` TypeScript union in `convex/ledger.ts:21-27` to include `"bid"` so the type-level enum matches the schema. Rationale: prevents drift between runtime values and types; mirrors `convex/ledger.ts` Treason Grants update.
- [ ] Task 3. Add a new `bidRounds` table to `convex/schema.ts` with fields:
  - `gameId: v.id("games")`,
  - `status: v.union(v.literal("open"), v.literal("ended"), v.literal("cancelled"))`,
  - `label: v.optional(v.string())` (trimmed, ≤120 chars; absent ↔ "Public bid"),
  - `createdAt: v.number()`,
  - `createdByUserId: v.id("users")` (must equal `game.gmId` at create time),
  - `endedAt: v.optional(v.number())`,
  - `endedByUserId: v.optional(v.id("users"))`.
  Indexes:
  - `by_game_status` on `["gameId", "status"]` — used to assert at-most-one-open-round and to fetch the current open round in O(1),
  - `by_game_created` on `["gameId", "createdAt"]` — used for the history list (most recent N).
  Rationale: Decision 1, 3 (at-most-one-open enforcement), 15 (history surface).
- [ ] Task 4. Add a new `bids` table to `convex/schema.ts` with fields:
  - `roundId: v.id("bidRounds")`,
  - `gameId: v.id("games")` (denormalised for cheap per-game scoping; matches `notes`/`calls`/`treasonGrants` pattern),
  - `playerId: v.id("players")`,
  - `amount: v.number()` (non-negative integer; validated at mutation time),
  - `updatedAt: v.number()`,
  - `updatedByUserId: v.id("users")` (the Player's user id; never the GM — GMs cannot place bids).
  Indexes:
  - `by_round` on `["roundId"]` — used to load every bid in the round for both visibility and settlement,
  - `by_round_player` on `["roundId", "playerId"]` — used by `placeBid` to upsert the caller's existing bid (`.unique()`),
  - `by_round_amount` on `["roundId", "amount"]` — used by the uniqueness scan in `placeBid` (Decision 6, 9). Index ordering `(roundId, amount)` lets the scan filter to a single row per amount.
  Rationale: Decisions 5, 6, 8 (upsert pattern); Convex has no schema-level unique constraint, so the index-backed lookup is the enforcement mechanism.

### Phase 2 — Backend module: `convex/publicBids.ts`

- [ ] Task 5. Create `convex/publicBids.ts` following the conventions of `convex/treasonGrants.ts`: top-level rule comment referencing this plan, named private helpers, explicit `Doc<>`/`Id<>` types, no implicit `any`, validators on every public function. Rationale: stylistic consistency with the rest of `convex/`.
- [ ] Task 6. Add a private helper `assertGameLive(ctx, gameId)` that calls `requireGame` and asserts `game.state === "playing"`. Returns the loaded game doc. Used by every mutation that requires an active session. Rationale: Decision 3 chokepoint; Rule 10 lifecycle.
- [ ] Task 7. Add a private helper `requireOpenRound(ctx, roundId)` that loads the round, asserts `status === "open"`, and asserts the parent game is still `"playing"`. Returns `{ round, game }`. Rationale: every place/end/cancel mutation needs the same "round is settleable" check; centralising prevents drift.
- [ ] Task 8. Add a private helper `validateBidAmount(amount)` that asserts `Number.isFinite(amount) && Number.isInteger(amount) && amount >= 0 && amount <= 1_000_000`. Returns `amount`. Throws plain Error with a user-readable message on failure. Rationale: Decision 5; defensive against client-side bypass per Rule 24.
- [ ] Task 9. Implement `startBidRound({ gameId, label? })` mutation:
  1. `requireGameGm(ctx, gameId)` (`convex/lib/auth.ts:53-63`).
  2. Assert `game.state === "playing"` (Decision 3).
  3. Use `by_game_status` index to look up any existing `open` round in this game; if one exists, throw `"A public bid round is already open in this game."` (Decision 3).
  4. If `label` is provided, trim it and assert `1 ≤ length ≤ 120`; otherwise store `undefined`.
  5. Insert a `bidRounds` row with `status: "open"`, `createdAt: Date.now()`, `createdByUserId: gmId`. Return the new `Id<"bidRounds">`.
  Rationale: Decisions 2, 3, 14.
- [ ] Task 10. Implement `placeBid({ roundId, amount })` mutation:
  1. Load round via `requireOpenRound`.
  2. `requireGamePlayer(ctx, round.gameId)` — caller must be a Player (this also rejects the GM by Rule 11).
  3. Validate amount (Task 8).
  4. **Uniqueness check (Decision 6)**: if `amount > 0`, query `by_round_amount` with `.eq("roundId", roundId).eq("amount", amount)` and inspect every returned row. If any row's `playerId !== caller._id`, throw `"That bid amount is already taken in this round."`.
  5. Look up the caller's existing bid via `by_round_player.unique()`.
  6. If no existing bid: insert a new `bids` row with `gameId: round.gameId`, `roundId`, `playerId: caller._id`, `amount`, `updatedAt: Date.now()`, `updatedByUserId: caller.userId`.
  7. If existing bid with the same `amount`: no-op (Decision 8).
  8. If existing bid with a different `amount`: `ctx.db.patch(existingBid._id, { amount, updatedAt, updatedByUserId })`.
  Rationale: Decisions 5, 6, 8, 9; idempotent re-submit.
- [ ] Task 11. Implement `endBidRound({ roundId })` mutation (settle with payment):
  1. Load round via `requireOpenRound`; `requireGameGm(ctx, round.gameId)`.
  2. Read every bid in the round via `by_round` index.
  3. For each bid with `amount > 0`, in the same transaction:
     - Resolve the player doc; assert it still belongs to the same game (defence-in-depth).
     - Insert a `powerLedgerEntries` row: `gameId: round.gameId`, `playerId: bid.playerId`, `delta: -bid.amount`, `reason: round.label?.trim().length ? round.label : "Public bid"`, `source: "bid"`, `createdByUserId: gmId`, `createdAt: now`.
     - Patch the player row: `power: player.power - bid.amount` (Rule 25).
  4. Patch the round to `status: "ended"`, `endedAt: now`, `endedByUserId: gmId`.
  Rationale: Decision 10; Rule 25 reconciliation invariant; transactional all-or-nothing settlement.
- [ ] Task 12. Implement `cancelBidRound({ roundId })` mutation (no payment):
  1. Load round via `requireOpenRound`; `requireGameGm(ctx, round.gameId)`.
  2. Patch round to `status: "cancelled"`, `endedAt: now`, `endedByUserId: gmId`. **No ledger entries written.**
  3. Bid rows are preserved as historical record (Decision 11).
  Rationale: Decision 11.
- [ ] Task 13. Implement `getOpenBidRound({ gameId })` query (participant-scoped):
  1. `requireGameParticipant(ctx, gameId)` (`convex/lib/auth.ts:101-125`).
  2. Use `by_game_status` to find the single `open` round (or `null`).
  3. If a round exists, fetch all bids via `by_round`; bulk-resolve `playerId → user.displayName` using the same hydration pattern as `convex/ledger.ts:235-256` and `convex/treasonGrants.ts:371-386` (one read per unique player).
  4. Compute the sorted bid list (descending by `amount`, ties broken by `updatedAt` ascending — earliest commit wins display order at amount=0).
  5. Compute the "not yet bid" list: every Player in the game whose `playerId` is not present in the bids set.
  6. Return shape:
     ```ts
     {
       round: { _id, label, createdAt, createdByUserId } | null,
       bids: Array<{ _id, playerId, displayName, amount, updatedAt, isMine }>,
       pending: Array<{ playerId, displayName }>,
       viewerRole: "gm" | "player",
       viewerPlayerId: Id<"players"> | null,
     }
     ```
  Rationale: Decision 13; one bulk subscription so the panel re-renders reactively when any other Player updates.
- [ ] Task 14. Implement `listRecentRounds({ gameId, limit? })` query (participant-scoped):
  1. `requireGameParticipant(ctx, gameId)`.
  2. Use `by_game_created` index, `.order("desc")`, `.take(limit ?? 5)`.
  3. For each round, attach a count of bids and the total POWER paid out (computed from bids with `amount > 0`).
  4. Skip the currently-open round (the live panel already shows it).
  Rationale: Decision 15; lightweight history surface — no full bid hydration to keep the payload small.
- [ ] Task 15. Implement `getRoundBids({ roundId })` query (participant-scoped, drills into a historical round):
  1. Load the round; `requireGameParticipant(ctx, round.gameId)`.
  2. Hydrate bids exactly as in Task 13 step 3.
  3. Return `{ round, bids }`.
  Rationale: lets the history list expand a row without paying the cost upfront.

### Phase 3 — Frontend: `GameDetailPage` integration

- [ ] Task 16. Add a new `<PublicBidSection>` invocation to the main column of `GameDetailPage` (`src/pages/GameDetailPage.tsx:96-129`), above the `<TreasonGrantsSection>` so it sits where the action is. Render it for the GM in `playing` state and for Players in `playing` state. Hidden in `ready` and `archived`. Rationale: Decision 3, 16.
- [ ] Task 17. Build the `PublicBidSection` component:
  - Subscribe to `api.publicBids.getOpenBidRound`.
  - **No open round**:
    - GM view: a "Start public bid" button + an optional label input that opens an inline form (matches `NewGrantForm` aesthetic at `src/pages/GameDetailPage.tsx:1836-1938`).
    - Player view: a muted "No public bid in progress." line.
  - **Open round**:
    - Header row showing the label (or "Public bid"), the time elapsed since `createdAt` (re-using `useElapsed`/`formatElapsed` from `src/hooks/useElapsed.ts`), and (GM only) two buttons: "End (collect)" and "Cancel (no payment)".
    - A live, sorted table of bids (descending by amount). Each row: display name (with "(you)" if `isMine`), amount badge, last-updated timestamp.
    - A subdued "Not yet bid" list below the table for any roster members in `pending`.
    - For the calling Player only: an inline input to place/update their bid + a "Submit" button. The input is pre-filled with the caller's current bid (or empty if none yet). After submit, the input remains the source of truth for editing.
  Rationale: Decision 13, 16; matches the look and feel of existing in-game panels.
- [ ] Task 18. Wire mutation callbacks:
  - GM "Start": `useMutation(api.publicBids.startBidRound)` with the optional label.
  - GM "End": `useMutation(api.publicBids.endBidRound)` after `window.confirm("End the bid? Each non-zero bidder will pay their bid to the bank. POWER may go negative.")`. Disable while in flight.
  - GM "Cancel": `useMutation(api.publicBids.cancelBidRound)` after `window.confirm("Cancel the bid? No POWER will be taken.")`.
  - Player "Submit": `useMutation(api.publicBids.placeBid)`. Surface the server-side uniqueness error inline using the existing `error-text` styling (`src/pages/GameDetailPage.tsx:836`). Disable while in flight.
  Rationale: defence-in-depth confirmation copy; identical UX to the Treason Grants `Take`/`Delete`/`Clear owner` confirmations (`src/pages/GameDetailPage.tsx:1959-2000`).
- [ ] Task 19. Build a small `<RecentBidsHistory>` collapsible block under the live panel that subscribes to `api.publicBids.listRecentRounds`. Each row shows the label, status badge (`ended`/`cancelled`), `endedAt`, bidder count, and total paid. Clicking a row expands it and lazy-loads via `api.publicBids.getRoundBids`. Hidden when there are no historical rounds. Rationale: Decision 15.
- [ ] Task 20. Visual treatment for the bid panel:
  - Reuse the `card` and `row-divider` classes already used by the Treason Grants and Roster panels for visual continuity.
  - Show the calling Player's row with a subtle highlight (e.g. `style={{ background: "var(--accent-soft)" }}` if available) so they can see their own position at a glance.
  - Render amount as `<strong>{amount}</strong> POWER`, matching the rest of the page.
  Rationale: visual consistency with `RosterRow` and `TreasonGrantRow`.

### Phase 4 — Tests (`convex/publicBids.test.ts`)

- [ ] Task 21. Add `convex/publicBids.test.ts` mirroring the structure of `convex/treasonGrants.test.ts`. Use `convex-test` with `vitest` and `@edge-runtime/vm` per the project's test conventions (`convex/_generated/ai/guidelines.md` § Testing).
- [ ] Task 22. **Start round**: GM can start in `playing`; non-GM (Player or non-participant) cannot; starting in `ready` rejected; starting in `archived` rejected; starting a second round while one is open rejected (`by_game_status` guard). Label trimming and length cap exercised.
- [ ] Task 23. **Place bid**: Player can place 0 / positive / re-submit same / change amount / change to 0 (withdraw); two players bidding the same `>0` amount → second is rejected; two players both bidding 0 → both succeed; non-participant rejected; GM placing a bid rejected (no `players` row → `requireGamePlayer` throws); placing a bid in a `cancelled` or `ended` round rejected; placing while game is `archived` rejected. Negative and non-integer amounts rejected.
- [ ] Task 24. **End round (settle)**: GM ends a round with three bidders (amounts `7`, `3`, `0`); assert exactly two ledger entries written (`source: "bid"`, deltas `-7` and `-3`), the `0` bidder gets no ledger entry, every Player's `players.power` matches `sum(ledger.delta where playerId = X)` (Rule 25 reconciliation). Reason field carries the round label when present, falls back to `"Public bid"` otherwise. Round status flips to `"ended"`; subsequent end/cancel/place rejected.
- [ ] Task 25. **Cancel round**: GM cancels; status flips to `"cancelled"`; **no ledger entries written**; players' `power` unchanged; subsequent place/end/cancel rejected.
- [ ] Task 26. **Negative POWER on settlement**: a Player with `power = 2` bids `5`; settlement succeeds; their `power` becomes `-3`; ledger reconciliation still holds. Rationale: Rule 17 (no floor) is intentional and must be exercised.
- [ ] Task 27. **Visibility**: `getOpenBidRound` returns the same shape to GM and Players; non-participant rejected outright; pending list correctly excludes players who have placed any bid (including `0`).
- [ ] Task 28. **History**: after end+cancel of two rounds, `listRecentRounds` returns them most-recent-first; the currently-open round is excluded; `getRoundBids` rehydrates display names correctly.
- [ ] Task 29. **Race-condition smoke test for uniqueness**: simulate two concurrent `placeBid` calls with the same non-zero amount; assert exactly one succeeds and one throws the uniqueness error. Rationale: Decision 9 — Convex transactions serialise; this test pins that property.

### Phase 5 — Documentation

- [ ] Task 30. Add **Rule 27 — Public Bids** to `plans/2026-04-20-init-v4.md` under "Confirmed Rules", succinctly restating Decisions 1–17 above and cross-referencing this plan file. Note that Rule 19's `source` enum is now also extended with `"bid"`. Rationale: keep the rule numbers as the canonical authority — this is the same pattern Treason Grants used (Rule 26).

## Verification Criteria

- The GM can start a public bid only while the game is `playing`. Attempting to start in `ready` or `archived`, or while another round is already `open`, is rejected server-side with a clear error.
- A Player can place an integer bid `0 ≤ amount ≤ 1_000_000`. Negative or non-integer values are rejected.
- Two Players can both bid `0`; two Players cannot both hold the same non-zero bid amount in the same round — the second `placeBid` call is rejected.
- A Player may freely change their bid (including back to `0`) while the round is `open`. Re-submitting an identical amount is a no-op.
- Every participant (GM and Players) sees the open round, the sorted-descending bid list with display names and amounts, and the "not yet bid" list. Non-participants are rejected at the query layer.
- When the GM clicks **End**, exactly the bidders with `amount > 0` are charged: each gets one ledger entry with `source: "bid"`, `delta: -amount`, `reason: <label or "Public bid">`, and their `players.power` is patched in the same transaction. Bidders with `amount === 0` write no ledger entry.
- After **End**, `sum(ledger.delta where playerId = X) === players.power[X]` holds for every Player (Rule 25 reconciliation).
- POWER is allowed to go negative on settlement (Rule 17). A bid greater than current POWER is accepted at place-time and produces a negative balance at end-time.
- When the GM clicks **Cancel**, **no ledger entries are written** and no `players.power` changes. The round transitions to `cancelled` and is locked.
- After a round is `ended` or `cancelled`, all of `placeBid`, `endBidRound`, `cancelBidRound` on that round are rejected.
- Archived games are read-only with respect to bids: no start, no place, no end, no cancel.
- The GM view on the game page shows Start/End/Cancel buttons appropriately; the Player view shows the bid input only while the round is `open` and the calling user is a Player.
- Recent-rounds history surface lists the most recent 5 ended/cancelled rounds, drillable into per-round bid lists.

## Potential Risks and Mitigations

1. **Race on uniqueness when two players bid the same amount simultaneously.**
   Mitigation: Convex mutations are single-document transactions; the `by_round_amount` index lookup runs inside the same transaction as the upsert. Whichever commits first wins; the loser sees the uniqueness error inline (Task 22, 29).
2. **Race on at-most-one-open-round.**
   Mitigation: same transactional guard via `by_game_status` (Task 9); a second concurrent Start mutation re-reads the index and sees the just-committed open round.
3. **Settlement straddles a state transition.**
   A GM might trigger End while another tab is archiving the game. Mitigation: `requireOpenRound` re-reads `game.state` inside the End transaction and rejects if not `playing` (Task 7, 11). Convex serialises both mutations.
4. **Rule 19 source enum drift.**
   If schema literal `"bid"` is added but the TypeScript `LedgerSource` union or any `source`-switch in the ledger pretty-printers is not updated, runtime values won't match types. Mitigation: Task 2 updates the union; Task 24 exercises the new source end-to-end including reason-field carry-over.
5. **Negative-POWER surprise.**
   A Player bids more than they hold and is shocked when their POWER goes negative. Mitigation: confirmation copy on End (Task 18) explicitly says "POWER may go negative". The behaviour is also explicitly tested (Task 26).
6. **Information leak via "pending" list.**
   The pending list reveals who has not yet bid. This is intentional (Decision 13) — public bids are explicitly public — but if private bids are ever added later, that surface will need a redaction layer. Mitigation: a comment in the `getOpenBidRound` query making the visibility decision explicit.
7. **Stale bid input after server upsert.**
   If the Player's local input becomes stale (e.g. another submission overwrote nothing meaningful), they could re-submit and hit a uniqueness collision. Mitigation: the live `getOpenBidRound` subscription updates the input's "current bid" hint; the inline error surfaces collisions clearly.
8. **N+1 hydration on big games.**
   `getOpenBidRound` resolves player → user display names. Mitigation: bulk-resolve unique player ids in one pass, mirroring `convex/ledger.ts:235-256` and `convex/treasonGrants.ts:371-386`.
9. **Round leaks across game archive.**
   If the GM archives the game while a round is `open`, the round becomes a zombie (`open` but in an archived game). Mitigation: a follow-up consideration — Phase-6 task to auto-cancel any `open` round when the game transitions to `archived` (see Alternative 3). Out of scope for v1 but flagged.
10. **`bids` per round growing without bound.**
    Each round accumulates at most one bid per Player, and Convex caps tables and queries well above the realistic player count for a game (≤ a few dozen). Mitigation: no action needed for v1; documented for awareness.

## Alternative Approaches

1. **Reuse `bank_in` as the ledger source instead of adding `"bid"`.**
   Less audit fidelity (public-bid payments and arbitrary GM bank-ins would be indistinguishable in the ledger), but no schema migration. Rejected per Decision 12 — auditability matters more than the one-line schema diff, and this is exactly the precedent set by Treason Grants.
2. **Single `bids` table without a separate `bidRounds` table; encode round identity in a synthetic field.**
   Saves one table but conflates round metadata (label, status, who-ended-it) with per-Player bids, and forces every "is the round open" check to scan bids. Rejected — the `bidRounds` row is the natural home for status and the at-most-one-open guard, and it's the document we patch atomically on settlement.
3. **Auto-cancel any open round on `playing → archived` transition.**
   Stronger lifecycle guarantee. Considered but deferred from v1 — the GM can manually cancel before archiving; the zombie-round scenario in Risk 9 is recoverable via a follow-up patch and shouldn't gate this feature. A future task can add the auto-cancel hook to `convex/games.ts:transitionState`.
4. **Sealed bids (Players can't see each other's amounts until end).**
   Different mechanic entirely — explicitly contrary to the task description ("Players can see all other players bids"). Mentioned only to note that the data model (visibility computed at query time) would generalise to a sealed-bid mode later by gating the `bids` array behind `round.status !== "open"` for non-callers.
5. **Auto-end when every Player has placed a non-zero bid.**
   Removes the explicit GM "End" click. Rejected per Decision 17 — the task description requires the GM to press a button, and auto-ending forecloses the GM's ability to give Players "last call".
6. **Allow the GM to also place a bid.**
   Rejected per Decision 2 and Rule 11 — the GM is not a participant in the in-game economy and has no `players` row to charge. The auth helper `requireGamePlayer` already encodes this.
7. **Implement bids as a free-form ledger reason rather than a structured feature.**
   The GM could just `gmEditPower` each Player by `-amount` after collecting bids verbally. Rejected — it punts the entire UX to off-platform coordination, defeats the live multi-user reactivity that's the project's headline strength, and provides no uniqueness enforcement.

## Status

Not Started.
