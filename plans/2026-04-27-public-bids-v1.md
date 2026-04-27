# Public Bids

## Objective

Add a new GM-driven, per-game ceremony — **Public Bids** — to Governance. The GM opens a bid round; every Player simultaneously submits a non-negative integer POWER amount; everyone sees everyone else's bids sorted by amount descending in real time; non-zero bid amounts must be unique across the round; when the GM closes the round, every Player's bid is paid to the bank atomically (one ledger entry per non-zero bidder, `players.power` patched in the same transaction); when the GM archives the round, it disappears from the main game panel and is only viewable from the Game Log drawer.

This feature must integrate cleanly with:
- the rule-bound game lifecycle (`convex/games.ts:129-185`, Rule 10),
- the append-only POWER ledger and `players.power` materialised cache (Rules 18, 19, 25; `convex/ledger.ts:1-256`),
- the Rule 19 `source` enum extension pattern established by Treason Grants (`plans/2026-04-27-treason-grants-v1.md`, Tasks 1–2),
- the centralised auth helpers (`convex/lib/auth.ts:53-125`, Rule 24),
- the `GameDetailPage` main-column section pattern used by `TreasonGrantsSection` (`src/pages/GameDetailPage.tsx:110-114`, `1779-1834`),
- the existing **Game Log drawer** (`src/pages/GameDetailPage.tsx:632-665`), which is already framed for additional event sources — archived bid rounds become its second section.

## Confirmed design decisions

These decisions resolve the ambiguities in the task description and lock the feature's behaviour. Implementation tasks below reference them by number.

1. **Scope**: per-game. A bid round is bound to one `gameId`. No cross-game persistence.
2. **Authoring**: GM-only opens, closes, and archives a round. Players cannot start, close, or archive.
3. **Lifecycle (3 stages)**:
   - **Open** — GM has started the round; players see it live and can place / update / withdraw bids.
   - **Closed** — GM has clicked **Close**; non-zero bids have been paid to the bank in one transaction. The round is still visible in the main panel as a result snapshot so players can see what just happened. No more bids can be placed. POWER is locked in.
   - **Archived** — GM has clicked **Archive**; the round disappears from the main panel. It remains queryable from the **Game Log drawer** (`src/pages/GameDetailPage.tsx:632-665`) as a permanent record. No further mutations.
   Allowed transitions:
   - `open → closed` (GM clicks **Close (collect)** — settles non-zero bids).
   - `open → archived` (GM clicks **Cancel (no payment)** — escape hatch; no settlement, skips closed).
   - `closed → archived` (GM clicks **Archive** — already settled; just hides it).
   No other transitions. In particular `closed → open` is not allowed: settlement is irreversible by design (matches Rule 26's irreversibility for Treason Grants).
4. **Lifecycle gates by `game.state`**:
   - **Start** allowed only while `game.state === "playing"`. Disallowed in `ready` and `archived` (consistent with all POWER-moving operations: transfers, minion buys, treason-grant takes).
   - **Place / update / withdraw a bid** allowed only while the round is `open` AND `game.state === "playing"`.
   - **Close** allowed only while the round is `open` AND `game.state === "playing"` (defence-in-depth: we never settle into an archived game).
   - **Archive** allowed when the round is `open` (with cancel semantics) or `closed` AND `game.state` is `playing` or `archived` — the GM must be able to clean up an active round even if the game itself was archived afterwards. Archive performs **no POWER moves**, so it's safe to allow in archived games.
   - At most **one non-archived round per game at any time** (i.e. open + closed combined ≤ 1). Starting a new round while one is `open` *or* `closed` is rejected. The GM must archive a closed round before opening another.
5. **Round status enum**: `"open" | "closed" | "archived"`. Three timestamps + actors track the transitions: `createdAt` / `createdByUserId`, `closedAt?` / `closedByUserId?` (set on `open → closed`), `archivedAt?` / `archivedByUserId?` (set on either `→ archived`). A round that went `open → archived` (cancelled) has `closedAt === undefined && archivedAt !== undefined`; that pair is the audit signature for "cancelled, no settlement".
6. **Bid amount**: integer, `Number.isInteger(amount) && amount >= 0 && amount <= 100` (sanity cap; chosen to match the order of magnitude of the existing in-game economy — Treason Grant POWER caps at 1000 per `convex/treasonGrants.ts:43` and Minion buy prices range over `[0..14]` per Rule 21, so `100` keeps a single bid within a realistic per-Player POWER range). **POWER can go negative on settlement** — by Rule 17 there is no floor. The server will not reject a bid because the player can't afford it; that is a deliberate gameplay risk (matches the existing transfer semantics, which also let POWER go negative).
7. **Uniqueness rule**: within a single round, two bids may both be `0`, but two bids with the same `> 0` amount are rejected at place-bid time. Enforced in the same transaction as the upsert via a `.unique()` lookup on the `by_round_amount` index (the index is the only enforcement mechanism since Convex has no schema-level uniqueness).
8. **Default state for non-bidders**: a Player who never places a bid is implicitly treated as **bid 0**. They are not displayed in the sorted bid list as having a bid; they appear in a separate "not yet bid" group so the GM can see who is still pending. They pay nothing on close.
9. **Withdraw / change**: a Player may freely change their bid (including back to 0) while the round is `open`. Re-submitting an identical amount is a no-op. There is **no separate withdraw mutation** — placing 0 conveys withdrawal. A Player who has explicitly placed `0` appears in the bid list at amount 0 (distinct from "not yet bid"); this is intentional UX so the GM can see who has actively opted out vs who hasn't decided.
10. **Concurrency on uniqueness**: two players hitting `placeBid` with the same non-zero amount race; Convex's optimistic concurrency control retries on read-set conflicts, so the second commit re-reads the `by_round_amount` index and rejects with a clear error.
11. **Close (settle)**: GM clicks **Close (collect)**. In **one Convex transaction**:
    - read every bid in the round,
    - for each bid with `amount > 0`: insert one ledger entry (`source: "bid"`, `delta: -amount`, `reason: <label or "Public bid">`, `createdByUserId: gmId`), patch `players.power -= amount`,
    - patch the round to `status: "closed"`, `closedAt: now`, `closedByUserId: gmId`.
    Bids with `amount === 0` write **no ledger entry** (no POWER change → no audit row). The bid rows themselves remain attached to the round forever as the historical record. The closed round remains visible in the main panel (with a results header) until the GM archives it.
12. **Archive (hide)**: GM clicks **Archive**. Two paths into this state:
    - `closed → archived`: the round was already settled; archiving just hides it from the main panel. **No ledger entries written.** Patches `status: "archived"`, `archivedAt: now`, `archivedByUserId: gmId`.
    - `open → archived` (cancellation): the GM aborts an open round without settling. **No ledger entries written.** Patches the same fields; `closedAt` remains `undefined` to preserve the cancellation audit signature (Decision 5).
    Confirmation copy in the UI distinguishes the two: "Cancel (no payment)" for `open → archived` vs "Archive" for `closed → archived`.
13. **Ledger source**: extend the `powerLedgerEntries.source` enum with a new literal `"bid"` (matches the Treason-Grants pattern in `convex/schema.ts:110-117`, Decision 6 of `plans/2026-04-27-treason-grants-v1.md`). Auditability: a public bid is its own revenue path and must be distinguishable from arbitrary `bank_in` activity.
14. **Visibility**:
    - **Open round**: every participant (GM + every Player in the game) sees the round live in the main panel: the full sorted bid list with display names and amounts, and a "not yet bid" list of remaining roster members.
    - **Closed round**: same shape, rendered as a read-only result snapshot. Players can no longer edit their bid input.
    - **Archived round**: invisible in the main panel for everyone (including the GM). Visible only via the **Game Log drawer**'s new "Past Public Bids" section, drillable to show the per-round bid list. Non-participants are rejected at the query layer per Rule 24.
15. **Round label** (optional): the GM may attach a free-text `label` to the round (1–120 chars, trimmed at insert time in the start mutation; or omitted) when starting it (e.g. "Auction: Senate seat"). The label is shown in the panel header and copied verbatim into each settlement ledger entry's `reason` for traceability. If absent (or empty after trim), ledger entries use the literal string `"Public bid"`.
16. **History surface**: archived rounds are exposed only through the **Game Log drawer** (`src/pages/GameDetailPage.tsx:632-665`), under a new "Past Public Bids" section. The drawer's existing "Recently removed calls" section remains; the new section is appended below it, mirroring the section-based layout the drawer was designed for. Default page size: most recent 20 archived rounds, drillable per row to show bids.
17. **UI placement**: a new "Public Bid" section on the **left main column** of the game page, immediately above or below Treason Grants (`src/pages/GameDetailPage.tsx:96-129`). Rationale: the section needs full width to render a roster-sized table of bids with display names and inputs; the right rail is reserved for compact, frequently-changing summaries (Call Queue, POWER Standings).
18. **No automatic "round-over" trigger**: the round only changes state when the GM explicitly clicks Close, Cancel, or Archive. Even if every Player has placed a non-zero bid, the round does not auto-close.

## Implementation Plan

### Phase 1 — Schema

- [ ] Task 1. Extend the `powerLedgerEntries.source` validator in `convex/schema.ts:110-117` with a new literal `v.literal("bid")`. Update the inline rule pointer comment block (`convex/schema.ts:101-104`) to also reference this plan and Rule 27. Rationale: Decision 13; mirrors the Treason Grants schema-extension pattern.
- [ ] Task 2. Update the `LedgerSource` TypeScript union in `convex/ledger.ts:21-27` to include `"bid"` so the type-level enum matches the schema. Rationale: prevents drift between runtime values and types; mirrors `convex/ledger.ts` Treason Grants update.
- [ ] Task 3. Add a new `bidRounds` table to `convex/schema.ts` with fields:
  - `gameId: v.id("games")`,
  - `status: v.union(v.literal("open"), v.literal("closed"), v.literal("archived"))`,
  - `label: v.optional(v.string())` (trimmed at insert time, ≤120 chars; absent ↔ "Public bid"),
  - `createdAt: v.number()`,
  - `createdByUserId: v.id("users")` (must equal `game.gmId` at create time),
  - `closedAt: v.optional(v.number())`,
  - `closedByUserId: v.optional(v.id("users"))`,
  - `archivedAt: v.optional(v.number())`,
  - `archivedByUserId: v.optional(v.id("users"))`.
  Indexes:
  - `by_game_status` on `["gameId", "status"]` — used to assert at-most-one-non-archived-round (`status IN {open, closed}`) and to fetch the current active round in O(1),
  - `by_game_archivedAt` on `["gameId", "archivedAt"]` — used by the Game Log drawer's history list (most recent N archived rounds, ordered desc).
  Inline rule comment: reference Rule 27 and this plan, mirroring the comment block above `treasonGrants` at `convex/schema.ts:179-183`.
  Rationale: Decisions 1, 4 (at-most-one-non-archived-round), 5 (timestamps), 16 (history surface).
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
  - `by_round_amount` on `["roundId", "amount"]` — used by the uniqueness `.unique()` lookup in `placeBid` (Decisions 7, 10). Index ordering `(roundId, amount)` lets the lookup resolve to a single row.
  Inline rule comment: reference Rule 27 and this plan.
  Rationale: Decisions 6, 7, 9 (upsert pattern); Convex has no schema-level unique constraint, so the index-backed `.unique()` lookup is the enforcement mechanism.

### Phase 2 — Backend module: `convex/publicBids.ts`

- [ ] Task 5. Create `convex/publicBids.ts` following the conventions of `convex/treasonGrants.ts`: top-level rule comment referencing this plan and Rule 27, named private helpers, explicit `Doc<>`/`Id<>` types, no implicit `any`, validators on every public function. Rationale: stylistic consistency with the rest of `convex/`.
- [ ] Task 6. Add a private helper `assertGameLive(ctx, gameId)` that calls `requireGame` and asserts `game.state === "playing"`. Returns the loaded game doc. Used by `startBidRound`, `placeBid`, and `closeBidRound`. **Not** used by `archiveBidRound` (Decision 4 allows archive in `archived` games). Rationale: Decision 4 chokepoint; Rule 10 lifecycle.
- [ ] Task 7. Add two private helpers, both **auth-agnostic** (the caller mutation enforces role separately):
  - `requireOpenRound(ctx, roundId)` — loads the round, asserts `status === "open"`, asserts the parent game is `"playing"`. Returns `{ round, game }`. Used by `placeBid` and `closeBidRound`.
  - `requireUnarchivedRound(ctx, roundId)` — loads the round, asserts `status !== "archived"`. Does **not** assert game state (archive is allowed even when the game is archived per Decision 4). Returns `{ round, game }`. Used by `archiveBidRound`.
  Rationale: each mutation has subtly different lifecycle requirements; centralising prevents drift while making the difference explicit. Auth (`requireGameGm` / `requireGamePlayer`) lives in the caller, not the helper.
- [ ] Task 8. Add a private helper `validateBidAmount(amount)` that asserts `Number.isFinite(amount) && Number.isInteger(amount) && amount >= 0 && amount <= 100`. Returns `amount`. Throws plain Error with a user-readable message on failure (the message must include the cap value so the UI can surface it directly). Rationale: Decision 6; defensive against client-side bypass per Rule 24.
- [ ] Task 9. Implement `startBidRound({ gameId, label? })` mutation:
  1. `requireGameGm(ctx, gameId)` (`convex/lib/auth.ts:53-63`).
  2. Assert `game.state === "playing"` (Decision 4).
  3. Use `by_game_status` index to look up any existing **non-archived** round (status `"open"` or `"closed"`) in this game. Two reads (one per status) and a `.first()` on each is fine; alternatively scan `by_game_status` for `gameId` and reject if any row has `status !== "archived"`. If one exists, throw `"A public bid round is already active in this game. Archive it before starting another."` (Decision 4).
  4. If `label` is provided, **trim it** and assert `1 ≤ length ≤ 120`; otherwise store `undefined`. The trimmed value is the canonical stored value (Decision 15).
  5. Insert a `bidRounds` row with `status: "open"`, `createdAt: Date.now()`, `createdByUserId: gmId`. Return the new `Id<"bidRounds">`.
  Rationale: Decisions 2, 3, 4, 15.
- [ ] Task 10. Implement `placeBid({ roundId, amount })` mutation:
  1. Load round via `requireOpenRound`.
  2. `requireGamePlayer(ctx, round.gameId)` — caller must be a Player (this also rejects the GM by Rule 11).
  3. Validate amount (Task 8).
  4. **Uniqueness check (Decision 7)**: if `amount > 0`, query `by_round_amount` with `q.eq("roundId", roundId).eq("amount", amount)` and call `.unique()`. If the result is non-null and its `playerId !== caller._id`, throw `"That bid amount is already taken in this round."`. (`.unique()` itself throws if the uniqueness invariant is somehow violated, which is the safer failure mode.)
  5. Look up the caller's existing bid via `by_round_player.unique()`.
  6. If no existing bid: insert a new `bids` row with `gameId: round.gameId`, `roundId`, `playerId: caller._id`, `amount`, `updatedAt: Date.now()`, `updatedByUserId: caller.userId`.
  7. If existing bid with the same `amount`: no-op (Decision 9).
  8. If existing bid with a different `amount`: `ctx.db.patch(existingBid._id, { amount, updatedAt, updatedByUserId })`.
  Rationale: Decisions 6, 7, 9, 10; idempotent re-submit.
- [ ] Task 11. Implement `closeBidRound({ roundId })` mutation (settle with payment; `open → closed`):
  1. Load round via `requireOpenRound`; `requireGameGm(ctx, round.gameId)`.
  2. Read every bid in the round via `by_round` index.
  3. For each bid with `amount > 0`, in the same transaction:
     - Resolve the player doc; assert it still belongs to the same game (defence-in-depth).
     - Insert a `powerLedgerEntries` row: `gameId: round.gameId`, `playerId: bid.playerId`, `delta: -bid.amount`, `reason: round.label && round.label.length > 0 ? round.label : "Public bid"` (label was already trimmed at insert; see Task 9), `source: "bid"`, `createdByUserId: gmId`, `createdAt: now`.
     - Patch the player row: `power: player.power - bid.amount` (Rule 25).
  4. Patch the round to `status: "closed"`, `closedAt: now`, `closedByUserId: gmId`. Do **not** set `archivedAt`.
  Rationale: Decision 11; Rule 25 reconciliation invariant; transactional all-or-nothing settlement; the round remains visible in the main panel until archived.
- [ ] Task 12. Implement `archiveBidRound({ roundId })` mutation (no POWER moves; `open → archived` cancels, `closed → archived` hides):
  1. Load round via `requireUnarchivedRound`; `requireGameGm(ctx, round.gameId)`.
  2. **No game-state gate**: archive is allowed in `playing` and `archived` games (Decision 4) so the GM can clean up rounds even after archiving the game.
  3. Patch round to `status: "archived"`, `archivedAt: now`, `archivedByUserId: gmId`. **No ledger entries written.** Do **not** touch `closedAt` — its presence/absence is the audit signature for whether the round was settled before archive (Decision 5).
  4. Bid rows are preserved as historical record (Decision 12, 16).
  Rationale: Decision 12; unifies the cancel and archive escape hatches into one mutation parameterised by the source state.
- [ ] Task 13. Implement `getActiveBidRound({ gameId })` query (participant-scoped):
  1. `requireGameParticipant(ctx, gameId)` (`convex/lib/auth.ts:101-125`).
  2. Use `by_game_status` to find a round with status `"open"`. If absent, look for `"closed"`. Returns `null` if neither exists. (Decision 4 guarantees at most one row across both statuses.)
  3. If a round exists, fetch all bids via `by_round`; bulk-resolve `playerId → user.displayName` using the same hydration pattern as `convex/ledger.ts:235-256` and `convex/treasonGrants.ts:371-386` (one read per unique player).
  4. Compute the sorted bid list (descending by `amount`, ties broken by `updatedAt` ascending — earliest commit wins display order at amount=0).
  5. Compute the "not yet bid" list: every Player in the game whose `playerId` is not present in the bids set. (For closed rounds the pending list is informational — those players never placed a bid before close.)
  6. Return shape:
     ```ts
     {
       round: {
         _id,
         status: "open" | "closed",
         label,
         createdAt,
         createdByUserId,
         closedAt: number | null,
         closedByUserId: Id<"users"> | null,
       } | null,
       bids: Array<{ _id, playerId, displayName, amount, updatedAt, isMine }>,
       pending: Array<{ playerId, displayName }>,
       viewerRole: "gm" | "player",
       viewerPlayerId: Id<"players"> | null,
     }
     ```
  Rationale: Decision 14; one bulk subscription so the panel re-renders reactively on any bid update **and** when the round transitions to `closed` (the same query feeds the post-settlement results view). Comment in the query explicitly notes the visibility model is intentional (every participant sees every other participant's amount, including after close).
- [ ] Task 14. Implement `listArchivedBidRounds({ gameId, limit? })` query (participant-scoped, drives the Game Log drawer's "Past Public Bids" section):
  1. `requireGameParticipant(ctx, gameId)`.
  2. Use `by_game_archivedAt` index, `.order("desc")`, `.take(limit ?? 20)`. Only archived rounds are returned (the index is keyed on `archivedAt`, which is `undefined` until archive).
  3. For each round, attach a count of bids and the total POWER paid out (computed from bids with `amount > 0`). For rounds where `closedAt === undefined` (i.e. cancelled before settlement), `totalPaid` is `0` and the row is flagged `wasSettled: false`.
  4. Return shape per row: `{ _id, label, createdAt, closedAt, archivedAt, wasSettled, bidCount, totalPaid }`.
  Rationale: Decisions 12, 16; lightweight history surface — no full bid hydration to keep the payload small. Drilldown is via Task 15.
- [ ] Task 15. Implement `getRoundBids({ roundId })` query (participant-scoped, drills into a historical or active round):
  1. Load the round; `requireGameParticipant(ctx, round.gameId)`.
  2. Hydrate bids exactly as in Task 13 step 3.
  3. Return `{ round, bids }` where `round` includes `status`, `label`, `createdAt`, `closedAt`, `archivedAt`.
  Rationale: lets the Game Log row expand without paying the cost upfront; reusable for any drilldown including `closed` rounds (the live panel already hydrates open/closed via Task 13, but `getRoundBids` remains the canonical drilldown for archived rounds).

### Phase 3 — Frontend: `GameDetailPage` integration

- [ ] Task 16. Add a new `<PublicBidSection>` invocation to the main column of `GameDetailPage` (`src/pages/GameDetailPage.tsx:96-129`), above the `<TreasonGrantsSection>` so it sits where the action is. Render it for the GM in `playing` state and for Players in `playing` state. Hidden in `ready` and `archived` (game-state). Rationale: Decisions 4, 17.
- [ ] Task 17. Build the `PublicBidSection` component:
  - Subscribe to `api.publicBids.getActiveBidRound`.
  - **No active round**:
    - GM view: a "Start public bid" button + an optional label input that opens an inline form (matches `NewGrantForm` aesthetic at `src/pages/GameDetailPage.tsx:1836-1938`).
    - Player view: a muted "No public bid in progress." line.
  - **Open round** (`round.status === "open"`):
    - Header row showing the label (or "Public bid"), the time elapsed since `createdAt` (re-using `useElapsed`/`formatElapsed` from `src/hooks/useElapsed.ts`), and (GM only) two buttons: **"Close (collect)"** and **"Cancel (no payment)"**.
    - A live, sorted table of bids (descending by amount). Each row: display name (with "(you)" if `isMine`), amount badge, last-updated timestamp.
    - A subdued "Not yet bid" list below the table for any roster members in `pending`.
    - For the calling Player only: an inline input to place/update their bid + a "Submit" button. The input is pre-filled with the caller's current bid (or empty if none yet). After submit, the input remains the source of truth for editing.
  - **Closed round** (`round.status === "closed"`):
    - Header row showing the label, a `Closed` badge, the elapsed time `createdAt → closedAt`, and (GM only) one button: **"Archive"**.
    - Same sorted bid table as above, but read-only (no input form for any Player; "(you)" highlight still applies). Each settled bid row optionally shows `−{amount}` styled as a debit (matches the ledger's existing visual convention if any; otherwise just the badge).
    - The "Not yet bid" list is rendered as `Did not bid` for clarity.
    - A summary line: `∑ {totalPaid} POWER paid to bank by {nonZeroBidderCount} bidder(s)`.
  Rationale: Decisions 11, 14, 17; matches the look and feel of existing in-game panels and surfaces the post-settlement state without forcing the GM to navigate away.
- [ ] Task 18. Wire mutation callbacks:
  - GM **Start**: `useMutation(api.publicBids.startBidRound)` with the optional label.
  - GM **Close (collect)** (open only): `useMutation(api.publicBids.closeBidRound)` after `window.confirm("Close the bid? Each non-zero bidder will pay their bid to the bank. POWER may go negative. This cannot be undone.")`. Disable while in flight.
  - GM **Cancel (no payment)** (open only): `useMutation(api.publicBids.archiveBidRound)` after `window.confirm("Cancel the bid? No POWER will be taken. The round will be archived.")`. The same `archiveBidRound` mutation is used — the server distinguishes by the round's source `status`.
  - GM **Archive** (closed only): `useMutation(api.publicBids.archiveBidRound)` after `window.confirm("Archive this bid? It will be hidden from the main panel and remain visible in the Game Log.")`.
  - Player **Submit**: `useMutation(api.publicBids.placeBid)`. Surface the server-side uniqueness error inline using the existing `error-text` styling (`src/pages/GameDetailPage.tsx:836`). Disable while in flight.
  Rationale: defence-in-depth confirmation copy; identical UX to the Treason Grants `Take`/`Delete`/`Clear owner` confirmations (`src/pages/GameDetailPage.tsx:1959-2000`). One mutation (`archiveBidRound`) backs both cancel and archive; the user-facing copy distinguishes them.
- [ ] Task 19. Extend the **`GameLogDrawer`** at `src/pages/GameDetailPage.tsx:632-665` with a new section **"Past Public Bids"** appended below the existing "Recently removed calls" section (matching the section-based layout the drawer was designed for; see the comment at lines 627-630):
  - Subscribe to `api.publicBids.listArchivedBidRounds` (default `limit: 20`).
  - Render `Loading…` / `No archived bids.` empty states matching the call section's style.
  - Each row shows the label (or "Public bid"), a status hint (`Settled` if `wasSettled`, otherwise `Cancelled`), `archivedAt` rendered with `toLocaleTimeString()` (matching line 657), the bidder count, and the total POWER paid (only for settled rows).
  - Clicking a row toggles an inline expansion that lazy-loads via `api.publicBids.getRoundBids` and renders the per-bid table inside the drawer. Collapse on second click.
  - Hidden when there are no archived rounds (the section header is omitted, not just empty — keep the drawer visually tight).
  Rationale: Decision 16; the drawer is the canonical historical event surface and the comment block at `src/pages/GameDetailPage.tsx:625-631` explicitly anticipates additional sections.
- [ ] Task 20. Visual treatment for the bid panel:
  - Reuse the `card` and `row-divider` classes already used by the Treason Grants and Roster panels for visual continuity.
  - Show the calling Player's row with a subtle highlight. Pick **one** of: an existing utility class already used on `GameDetailPage` for self-rows (search for `isSelf` styling around `src/pages/GameDetailPage.tsx:710-770`) or a single inline `style` derived from a CSS variable that is **verified to exist** in `src/index.css` / `THEME.md` before landing the change. Do not ship a conditional `if available` style.
  - Render amount as `<strong>{amount}</strong> POWER`, matching the rest of the page.
  - Closed rounds: render the header label with an inline `Closed` chip styled like the existing call-removed chip (search for the closest existing badge in `GameDetailPage.tsx`).
  Rationale: visual consistency with `RosterRow` and `TreasonGrantRow`.

### Phase 4 — Tests (`convex/publicBids.test.ts`)

- [ ] Task 21. Add `convex/publicBids.test.ts` mirroring the structure of `convex/treasonGrants.test.ts`. Use `convex-test` with `vitest` and `@edge-runtime/vm` per the project's test conventions (`convex/_generated/ai/guidelines.md` § Testing).
- [ ] Task 22. **Start round**: GM can start in `playing`; non-GM (Player or non-participant) cannot; starting in `ready` rejected; starting while `game.state` is `archived` rejected; starting a second round while one is `open` rejected; starting a second round while one is `closed` (not yet archived) rejected; starting a second round after the previous round was archived **succeeds**; label trimming and length cap exercised.
- [ ] Task 23. **Place bid**: Player can place 0 / positive / re-submit same / change amount / change to 0 (withdraw); two players bidding the same `>0` amount → second is rejected; two players both bidding 0 → both succeed; non-participant rejected; GM placing a bid rejected (no `players` row → `requireGamePlayer` throws); placing a bid in a `closed` or `archived` round rejected; placing while game is `archived` rejected. Negative and non-integer amounts rejected.
- [ ] Task 24. **Close round (settle)**: GM closes a round with three bidders (amounts `7`, `3`, `0`); assert exactly two ledger entries written (`source: "bid"`, deltas `-7` and `-3`), the `0` bidder gets no ledger entry, every Player's `players.power` matches `sum(ledger.delta where playerId = X)` (Rule 25 reconciliation). Reason field carries the round label when present, falls back to `"Public bid"` otherwise. Round status flips to `"closed"`; `closedAt` set; `archivedAt` remains `undefined`. Subsequent close/place rejected; archive **succeeds** (and is the only forward transition).
- [ ] Task 25. **Archive from open (cancel)**: GM archives an open round directly; status flips to `"archived"`; `archivedAt` set; `closedAt` **remains undefined** (cancellation audit signature per Decision 5); **no ledger entries written**; players' `power` unchanged; subsequent place/close/archive rejected. A new round can then be started.
- [ ] Task 26. **Archive from closed (hide)**: GM closes a round (settlement happens), then archives it; status flips to `"archived"`; `closedAt` is preserved (settled audit signature); no additional ledger entries written; players' `power` unchanged from the close step. A new round can then be started.
- [ ] Task 27. **Archive in archived game**: GM archives the game (game `playing → archived`) while a `closed` round is still active in the panel; GM can still call `archiveBidRound` and the call succeeds (Decision 4). The same is true for `open → archived` if the round was somehow left open at game-archive time.
- [ ] Task 28. **Negative POWER on close**: a Player with `power = 2` bids `5`; close succeeds; their `power` becomes `-3`; ledger reconciliation still holds. Rationale: Rule 17 (no floor) is intentional and must be exercised.
- [ ] Task 29. **Visibility (active)**: `getActiveBidRound` returns the same shape to GM and Players; non-participant rejected outright; pending list correctly excludes players who have placed any bid (including `0`). For a `closed` round, `getActiveBidRound` still returns the round with `status: "closed"` and the bid list — the panel renders the result snapshot.
- [ ] Task 30. **Visibility (archived)**: `getActiveBidRound` returns `null` after archive (the round vanishes from the main panel for everyone, including the GM). `listArchivedBidRounds` returns the same archived round, sorted desc by `archivedAt`; the cancelled-vs-settled distinction is reflected in `wasSettled` and `totalPaid`. `getRoundBids` rehydrates display names correctly for any archived round.
- [ ] Task 31. **Race on uniqueness (sequential)**: with one `placeBid` already committed at `amount=5`, a second player's `placeBid` at `amount=5` is rejected with the uniqueness error. (Note: `convex-test` does not model OCC retries, so this is a sequential test of the in-transaction check; production OCC behaviour is implied by the same code path. This subsumes the original race-condition smoke test.)

### Phase 5 — Documentation

- [ ] Task 32. Add **Rule 27 — Public Bids** to `plans/2026-04-20-init-v4.md` under "Confirmed Rules", succinctly restating the three-stage lifecycle (open → closed → archived; open → archived as cancellation), the uniqueness rule, the public-visibility model, and the `"bid"` ledger source. Cross-reference this plan file. Note that Rule 19's `source` enum is now also extended with `"bid"`. Rationale: keep the rule numbers as the canonical authority — this is the same pattern Treason Grants used (Rule 26).

## Verification Criteria

- The GM can start a public bid only while the game is `playing`. Attempting to start in `ready`, in `archived`, or while another round is `open` **or** `closed` (not yet archived), is rejected server-side with a clear error.
- A Player can place an integer bid `0 ≤ amount ≤ 100`. Negative, non-integer, or above-cap values are rejected.
- Two Players can both bid `0`; two Players cannot both hold the same non-zero bid amount in the same round — the second `placeBid` call is rejected.
- A Player may freely change their bid (including back to `0`) while the round is `open`. Re-submitting an identical amount is a no-op. Placing a bid in a `closed` or `archived` round is rejected.
- Every participant (GM and Players) sees the active round (whether `open` or `closed`), the sorted-descending bid list with display names and amounts, and the "not yet bid" / "did not bid" list. Non-participants are rejected at the query layer. The bid input is rendered for the calling Player only when the round is `open`.
- When the GM clicks **Close (collect)**, exactly the bidders with `amount > 0` are charged: each gets one ledger entry with `source: "bid"`, `delta: -amount`, `reason: <label or "Public bid">`, and their `players.power` is patched in the same transaction. Bidders with `amount === 0` write no ledger entry. The round transitions to `closed` and remains visible in the main panel as a result snapshot.
- After **Close**, `sum(ledger.delta where playerId = X) === players.power[X]` holds for every Player (Rule 25 reconciliation).
- POWER is allowed to go negative on close (Rule 17). A bid greater than current POWER is accepted at place-time and produces a negative balance at close-time.
- When the GM clicks **Cancel (no payment)** on an `open` round, **no ledger entries are written** and no `players.power` changes. The round transitions directly to `archived` with `closedAt === undefined`.
- When the GM clicks **Archive** on a `closed` round, no further ledger entries or `players.power` changes occur; `closedAt` is preserved; the round transitions to `archived` and disappears from the main panel.
- After a round is `archived`, all of `placeBid`, `closeBidRound`, `archiveBidRound` on that round are rejected.
- An archived round is invisible in the main panel for everyone (including the GM) and visible only via the **Game Log drawer**'s "Past Public Bids" section.
- `archiveBidRound` is allowed even when `game.state === "archived"` so the GM can clean up rounds left active when the game was archived.
- `game.state === "ready"` blocks all bid mutations (no start, no place, no close, no archive). `game.state === "archived"` blocks start / place / close (but allows archive).
- The GM view on the game page shows Start (when no active round) / Close+Cancel (open) / Archive (closed) buttons appropriately; the Player view shows the bid input only while the round is `open` and the calling user is a Player.
- The Game Log drawer's "Past Public Bids" section lists the most recent 20 archived rounds, drillable into per-round bid lists, distinguishes settled vs cancelled rows, and is hidden entirely when there are no archived rounds.

## Potential Risks and Mitigations

1. **Race on uniqueness when two players bid the same amount simultaneously.**
   Mitigation: Convex's optimistic concurrency control retries on read-set conflicts; the `by_round_amount` `.unique()` lookup runs inside the same transaction as the upsert. Whichever commits first wins; the loser's retry sees the just-committed row and rejects (Task 23, 31).
2. **Race on at-most-one-non-archived-round.**
   Mitigation: same OCC guard via `by_game_status` (Task 9); a second concurrent Start mutation re-reads the index on retry and sees the just-committed `open` (or `closed`) round. Note this guard now covers both `open` and `closed`, not just `open`.
3. **Settlement straddles a state transition.**
   A GM might trigger Close while another tab is archiving the game. Mitigation: `requireOpenRound` re-reads `game.state` inside the Close transaction and rejects if not `playing` (Tasks 7, 11). Convex serialises retries; one of the two will see the other's write.
4. **Rule 19 source enum drift.**
   If schema literal `"bid"` is added but the TypeScript `LedgerSource` union or any `source`-switch in the ledger pretty-printers is not updated, runtime values won't match types. Mitigation: Task 2 updates the union; Task 24 exercises the new source end-to-end including reason-field carry-over. (Confirmed: no current `src/` code switches over `source` literals.)
5. **Negative-POWER surprise.**
   A Player bids more than they hold and is shocked when their POWER goes negative. Mitigation: confirmation copy on Close (Task 18) explicitly says "POWER may go negative". The behaviour is also explicitly tested (Task 28).
6. **Information leak via "pending" / "placed-zero" lists.**
   The pending list reveals who has not yet bid, and the bid list reveals players who explicitly placed `0`. Both signals are intentional (Decision 9, 14) — public bids are explicitly public — but the **active-zero vs not-yet-bid distinction** is strategically meaningful (active opt-out vs undecided). If private/sealed bids are ever added later, both surfaces will need a redaction layer. Mitigation: a comment in the `getActiveBidRound` query making the visibility decision explicit.
7. **Stale bid input after server upsert.**
   If the Player's local input becomes stale (e.g. another submission overwrote nothing meaningful), they could re-submit and hit a uniqueness collision. Mitigation: the live `getActiveBidRound` subscription updates the input's "current bid" hint; the inline error surfaces collisions clearly.
8. **N+1 hydration on big games.**
   `getActiveBidRound` resolves player → user display names. Mitigation: bulk-resolve unique player ids in one pass, mirroring `convex/ledger.ts:235-256` and `convex/treasonGrants.ts:371-386`.
9. **Round leaks across game archive.**
   If the GM archives the game while a round is `open` or `closed`, the round persists in the main panel until the game itself is reopened (which never happens). Mitigation: Decision 4 explicitly allows `archiveBidRound` on archived games so the GM can manually clean up. A stronger follow-up — either block `playing → archived` while a non-archived round exists, or auto-archive any non-archived rounds on game-archive transition — is captured in Alternative 3 and is recommended as a v1.1 follow-up. Out of scope for v1.
10. **Closed-round panel persists indefinitely if the GM forgets to archive.**
    The panel will keep showing the result snapshot, which blocks starting another round. Mitigation: the at-most-one-non-archived guard surfaces a clear error ("Archive it before starting another") on `startBidRound`, prompting the GM to archive. Acceptable for v1.
11. **`bids` per round growing without bound.**
    Each round accumulates at most one bid per Player, and Convex caps tables and queries well above the realistic player count for a game (≤ a few dozen). Mitigation: no action needed for v1; documented for awareness.

## Alternative Approaches

1. **Reuse `bank_in` as the ledger source instead of adding `"bid"`.**
   Less audit fidelity (public-bid payments and arbitrary GM bank-ins would be indistinguishable in the ledger), but no schema migration. Rejected per Decision 13 — auditability matters more than the one-line schema diff, and this is exactly the precedent set by Treason Grants.
2. **Single `bids` table without a separate `bidRounds` table; encode round identity in a synthetic field.**
   Saves one table but conflates round metadata (label, status, who-closed-it) with per-Player bids, and forces every "is the round open" check to scan bids. Rejected — the `bidRounds` row is the natural home for status and the at-most-one-non-archived guard, and it's the document we patch atomically on close and archive.
3. **Auto-archive any non-archived round on `playing → archived` transition.**
   Stronger lifecycle guarantee than Decision 4. Considered but deferred from v1 — the GM can manually archive after archiving the game (Decision 4 keeps this path open). Risk 9 captures the follow-up. A future task can add an auto-archive hook to `convex/games.ts:transitionState`.
4. **Sealed bids (Players can't see each other's amounts until close).**
   Different mechanic entirely — explicitly contrary to the task description ("Players can see all other players bids"). Mentioned only to note that the data model would generalise to a sealed-bid mode by gating the `bids` array behind `round.status !== "open"` for non-callers in `getActiveBidRound`.
5. **Auto-close when every Player has placed a non-zero bid.**
   Removes the explicit GM "Close" click. Rejected per Decision 18 — the task description requires the GM to press a button, and auto-closing forecloses the GM's ability to give Players "last call".
6. **Allow the GM to also place a bid.**
   Rejected per Decision 2 and Rule 11 — the GM is not a participant in the in-game economy and has no `players` row to charge. The auth helper `requireGamePlayer` already encodes this.
7. **Implement bids as a free-form ledger reason rather than a structured feature.**
   The GM could just `gmEditPower` each Player by `-amount` after collecting bids verbally. Rejected — it punts the entire UX to off-platform coordination, defeats the live multi-user reactivity that's the project's headline strength, and provides no uniqueness enforcement.
8. **Two-state lifecycle (drop the `closed` intermediate, settle and hide in one click).**
   Simpler, but loses the post-settlement visibility window users explicitly asked for. The two-step `Close → Archive` flow is what the user-provided lifecycle specifies, and it gives Players a chance to see and react to the result before the panel disappears.
9. **Allow `closed → open` to undo settlement.**
   Considered for symmetry with Treason Grants' `clearGrantOwner`. Rejected — settlement writes ledger entries that, by Rule 18 (append-only), cannot be undone. Reversing settlement would either violate that rule (delete entries) or require compensating entries with their own audit trail, which is more complexity than v1 needs. A round, once closed, can only be archived.

## Status

Not Started.
