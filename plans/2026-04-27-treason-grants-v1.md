# Treason Grants

## Objective

Add a new per-game asset class — **Treason Grants** — to Governance. A Grant is a GM-authored bundle of (keyword, POWER, description, optional player owner). The GM authors and curates the list; Players see a redacted view of the list while the game is `playing` and may **take** an unowned Grant in exchange for the listed POWER, at which point the Grant becomes owned by them and reveals its description to that player.

This feature must integrate cleanly with:
- the rule-bound game lifecycle (`convex/games.ts:129-185`, rule 10),
- the append-only POWER ledger and `players.power` materialised cache (rules 18, 19, 25, `convex/ledger.ts:1-256`),
- centralised authorisation helpers (`convex/lib/auth.ts:44-125`, rule 24),
- the `GameDetailPage` layout (`src/pages/GameDetailPage.tsx:73-163`).

## Confirmed design decisions

1. **Scope**: per-game. Each Grant carries a `gameId`. Grants do not carry across games.
2. **Owner**: `Id<"players">` (per-game), not a `Id<"users">`.
3. **Authoring**: GM-only. The GM **cannot** take a Grant.
4. **Lifecycle states for GM CRUD**: allowed in `ready` and `playing`. Disallowed in `archived`.
5. **Take action**: any Player may take an **unowned** Grant **only while the game is `playing`**, with confirmation. Taking writes one ledger entry on the taker, source `treason_grant`, delta `+power`, and patches `players.power` in the same transaction.
6. **Ledger source**: extend the `powerLedgerEntries.source` enum with a new literal `"treason_grant"` (rule 19 is augmented by this plan; the source is informational and never reversible).
7. **POWER amount**: positive integer ≥ 1. No floor (POWER itself can already go negative under rule 17, but the Grant's award is always positive).
8. **GM edit after taken (B)**: the GM may edit `keyword` and `description` at any time. The `power` field is **frozen once `ownerPlayerId` is set** (server-side check). Deleting an owned Grant is allowed; **POWER is not reversed** on delete.
9. **GM clear-owner**: the GM may clear (`ownerPlayerId → undefined`) an owned Grant via a confirmation dialog. **No POWER reversal.** The Grant becomes takeable again, including by a different player, who will receive the listed POWER on take. The GM cannot directly assign an owner.
10. **GM visibility**: the GM sees every Grant in full, including descriptions and unowned ones, in any state.
11. **Player visibility**: a Player sees `keyword`, `power`, and `ownerPlayerId` (with display name) for every Grant. A Player sees `description` **only** for Grants they own.
12. **Validation**:
    - `keyword`: trimmed, 1–40 chars, **unique within a game** (case-insensitive).
    - `description`: 0–2000 chars (matches `notes.ts:21-22`). Empty allowed.
    - `power`: positive integer ≥ 1, ≤ 1000 (sanity bound).
13. **No cap** on the number of Grants a player may take in a game.
14. **UI placement**: new "Treason Grants" section on the left side of the game page (the main column, where descriptions can render at full width). The right rail (`src/pages/GameDetailPage.tsx:131-151`) stays as it is.

## Implementation Plan

### Phase 1 — Schema

- [ ] Task 1. Extend the `powerLedgerEntries.source` validator in `convex/schema.ts:107-113` with a new literal `v.literal("treason_grant")`. Update the inline rule pointer to reference rules 18, 19, 22 plus this plan. Rationale: Rule 19's source enum is closed; taking a Grant is a new, distinct revenue source that must be auditable in the ledger.
- [ ] Task 2. Update the `LedgerSource` TypeScript union in `convex/ledger.ts:21-26` to include `"treason_grant"` so callers/consumers stay in sync. Rationale: keeps the type-level enum aligned with the schema.
- [ ] Task 3. Add a new `treasonGrants` table to `convex/schema.ts` with fields:
    - `gameId: v.id("games")`,
    - `keyword: v.string()`,
    - `keywordLower: v.string()` (a normalised form used solely to enforce uniqueness; written by mutations alongside `keyword`),
    - `power: v.number()`,
    - `description: v.string()`,
    - `ownerPlayerId: v.optional(v.id("players"))`,
    - `takenAt: v.optional(v.number())`,
    - `createdAt: v.number()`,
    - `createdByUserId: v.id("users")`.
    Indexes:
    - `by_game` on `["gameId"]` (for the per-game listing query),
    - `by_game_keywordLower` on `["gameId", "keywordLower"]` (for uniqueness check on create/edit),
    - `by_game_owner` on `["gameId", "ownerPlayerId"]` (for future "my grants" listings; useful for showing all my grants in one place).
    Rationale: per-game scope + indexed keyword uniqueness + ownership lookup. Convex has no schema-level unique constraint, so uniqueness is enforced at mutation time using `by_game_keywordLower` (matches the `addPlayer` pattern in `convex/games.ts:44-67`).

### Phase 2 — Backend module: `convex/treasonGrants.ts`

- [ ] Task 4. Create `convex/treasonGrants.ts` with the same conventions as `convex/notes.ts` (top-level rule comment, named helpers, explicit `Doc<>`/`Id<>` types). Rationale: stylistic consistency.
- [ ] Task 5. Add a private helper `assertGrantWritable(ctx, gameId)` that calls `requireGameGm` from `convex/lib/auth.ts:53-63` and asserts `game.state !== "archived"`. Used by every GM mutation. Rationale: single chokepoint for the lifecycle rule (Decision 4).
- [ ] Task 6. Add a private helper `validateGrantFields({ keyword, power, description })` that:
    - trims `keyword`, asserts `1 <= length <= 40`, returns the trimmed value plus its lowercased form,
    - asserts `power` is a finite integer with `1 <= power <= 1000`,
    - asserts `description.length <= 2000` (empty allowed; description is **not** trimmed so leading/trailing whitespace is preserved if intentional, but tabs/newlines are fine).
    Rationale: Decision 12.
- [ ] Task 7. Add a private helper `assertKeywordUniqueInGame(ctx, gameId, keywordLower, exceptGrantId?)` that uses the `by_game_keywordLower` index to find a row with the same lowered keyword in this game. Throws if a different grant matches. Rationale: case-insensitive uniqueness with edit support.
- [ ] Task 8. Implement `createGrant({ gameId, keyword, power, description })` mutation:
    1. `assertGrantWritable(ctx, gameId)`.
    2. Validate fields (Task 6).
    3. Assert uniqueness (Task 7).
    4. Insert with `ownerPlayerId: undefined`, `takenAt: undefined`, `createdAt: Date.now()`, `createdByUserId: gmId`.
    Returns the new `Id<"treasonGrants">`. Rationale: Decision 3, 4, 12.
- [ ] Task 9. Implement `updateGrant({ grantId, keyword?, power?, description? })` mutation:
    1. Load the grant; resolve its game; `assertGrantWritable(ctx, grant.gameId)`.
    2. Treat all field args as optional patches; if none provided, no-op return.
    3. If `power` is provided **and** `grant.ownerPlayerId !== undefined`, throw `"POWER cannot be changed once a Grant has been taken."` (Decision 8).
    4. If `keyword` is provided, validate + recompute `keywordLower` + run uniqueness check excluding `grantId`.
    5. If `description` is provided, validate length only.
    6. If `power` is provided (and grant is unowned), validate it's a positive integer.
    7. `ctx.db.patch(grantId, …)` with the resolved subset.
    Rationale: Decision 8 (B); GM may freely fix typos in keyword/description even after take.
- [ ] Task 10. Implement `deleteGrant({ grantId })` mutation:
    1. Load grant; resolve game; `assertGrantWritable`.
    2. `ctx.db.delete(grantId)` — **no ledger entry, no POWER reversal**, even if owned.
    Rationale: Decision 8 (delete allowed; POWER persists).
- [ ] Task 11. Implement `clearGrantOwner({ grantId })` mutation (GM only):
    1. Load grant; resolve game; `assertGrantWritable`.
    2. If `ownerPlayerId === undefined`, no-op return (idempotent).
    3. `ctx.db.patch(grantId, { ownerPlayerId: undefined, takenAt: undefined })` — **no ledger reversal**.
    Confirmation is enforced by the client (Decision 9). The GM intentionally **cannot** assign an owner — there is no `setGrantOwner` mutation.
- [ ] Task 12. Implement `takeGrant({ grantId })` mutation (Player path):
    1. Load grant; resolve `gameId` and load game.
    2. `requireGamePlayer(ctx, gameId)` (`convex/lib/auth.ts:65-81`) — caller must be a Player; this also rejects the GM (rule 11).
    3. Assert `game.state === "playing"` (Decision 5).
    4. Assert `grant.ownerPlayerId === undefined` (taking an owned grant is a hard error, surfaced as `"That Grant has already been taken."`).
    5. Re-assert `power >= 1` defensively (data integrity in case of an old row).
    6. In one transaction:
       - `ctx.db.patch(grantId, { ownerPlayerId: player._id, takenAt: now })`,
       - `ctx.db.insert("powerLedgerEntries", { gameId, playerId: player._id, delta: +grant.power, source: "treason_grant", reason: "Treason grant: <keyword>", createdByUserId: player.userId, createdAt: now })`,
       - `ctx.db.patch(player._id, { power: player.power + grant.power })` (rule 25 cache).
    Rationale: Decision 5; matches the transactional pattern in `buyMinion` at `convex/minionBuys.ts:78-87`.
- [ ] Task 13. Implement `listGrantsForGame({ gameId })` query returning a redacted, viewer-aware list:
    - `requireGameParticipant(ctx, gameId)` (`convex/lib/auth.ts:101-125`); reject non-participants.
    - Read all grants via `by_game` index; sort newest-first by `_creationTime`.
    - For each grant compute:
      - `canSeeDescription = role === "gm" || ownerPlayerId === viewerPlayer?._id`,
      - `description: canSeeDescription ? grant.description : null`,
      - `ownerPlayerId`, plus a hydrated `ownerDisplayName` (or `null` if unowned), looked up via the player → user join (avoid N+1: bulk-resolve unique owner ids first, mirroring `hydrateEntries` in `convex/ledger.ts:234-256`),
      - `canTake = role === "player" && game.state === "playing" && ownerPlayerId === undefined`,
      - `canEditPower = role === "gm" && ownerPlayerId === undefined`,
      - `isMine = ownerPlayerId === viewerPlayer?._id`.
    - Return shape: `{ grants: GrantRow[], gameState }`.
    Rationale: Decisions 10, 11; one bulk subscription rather than per-row queries; encodes server-side rule 24 enforcement so the client can render trustingly.
- [ ] Task 14. (No standalone "my grants" query needed for v1.) The list view already exposes `isMine`; if a "My Grants" filter is later wanted, it's a pure client-side filter over the same query.

### Phase 3 — Frontend: GameDetailPage integration

- [ ] Task 15. Add a new section to the main column of `GameDetailPage` (`src/pages/GameDetailPage.tsx:96-129`) titled **"Treason Grants"**, rendered:
    - For the GM: in `ready` and `playing` (and read-only in `archived` so they can review history).
    - For Players: only when `gameState !== "ready"` (i.e. `playing` or `archived`); not surfaced in `ready` so it doesn't tempt mid-prep takes.
    Rationale: Decision 14 placement; Decision 4 lifecycle.
- [ ] Task 16. Build a `TreasonGrantsPanel` component subscribing to `api.treasonGrants.listGrantsForGame`. Layout:
    - Header row with grant count and (GM only) a `+ New Grant` button that opens an inline form (keyword, POWER, description textarea) — matches the inline-form aesthetic of `AddPlayerForm` (`src/pages/GameDetailPage.tsx:1412-1468`) and `GmEditPowerForm` (`src/pages/GameDetailPage.tsx:1029-1092`).
    - One card per grant showing keyword (prominent), POWER badge, owner display name (or "Unowned"), and the description (full text when visible; otherwise a muted placeholder like *"Description hidden"*).
    Rationale: Decision 14 — full-width main column gives descriptions the breathing room they need.
- [ ] Task 17. Render per-grant action affordances based on the server-computed flags:
    - `canTake`: a `Take` button on the grant row that calls `useMutation(api.treasonGrants.takeGrant)` after `window.confirm("Take grant '<keyword>' for +<power> POWER?")` (matches `RosterRow.handleRemove` confirmation in `src/pages/GameDetailPage.tsx:724-727`). Disable while the mutation is in flight.
    - `role === "gm"` (and `gameState !== "archived"`): show `Edit`, `Delete`, and (when owned) `Clear owner` buttons.
        - `Delete` → `window.confirm("Delete grant '<keyword>'? POWER already paid out is NOT refunded.")`.
        - `Clear owner` → `window.confirm("Clear owner of '<keyword>'? POWER is NOT refunded; the grant becomes takeable again.")`.
    Rationale: Decision 5, 8, 9; defence-in-depth confirmation copy makes the no-reversal semantics obvious to GMs.
- [ ] Task 18. Build a `GrantEditor` inline form used by both create and edit. The form must:
    - Disable the POWER input when editing an owned grant (`canEditPower === false`) and show a tooltip "POWER is locked because this Grant has been taken." (Decision 8 / Task 9).
    - Surface server-side errors inline (uniqueness, validation) using the existing `error-text` styling (`src/pages/GameDetailPage.tsx:836`, `1086-1089`).
- [ ] Task 19. Render the description visibility precisely:
    - Visible (GM, or owner): full multi-line `<p style={{ whiteSpace: "pre-wrap" }}>` (matches typical note rendering).
    - Hidden: muted italic `Description hidden — only the owner can read it.` This text is identical for "unowned" and "owned by someone else" cases so non-owners can't infer ownership state from the placeholder alone (the explicit owner field already conveys ownership; the placeholder must not leak more).

### Phase 4 — Tests

- [ ] Task 20. Add `convex/treasonGrants.test.ts` mirroring the structure of `convex/notes.test.ts`. Cover (minimum):
    - **Create**: GM can create; non-GM (Player or non-participant) cannot; invalid keyword length rejected; non-positive POWER rejected; duplicate keyword (case-insensitive) within a game rejected; same keyword across two different games allowed.
    - **Update**: GM can edit keyword/description on owned grant; GM **cannot** edit `power` on owned grant (asserts the exact error); non-GM cannot edit; uniqueness on rename respects exclusion of self.
    - **Delete**: GM can delete owned and unowned grants; deleting an owned grant does **not** write a ledger entry and does **not** change `players.power`; non-GM cannot delete; archived game blocks delete.
    - **Clear owner**: GM clears owner; no ledger reversal; previous owner's `power` unchanged; the grant is now takeable; a different player can take it and receives the POWER again (asserts the "double-payout-on-clear" semantics from the question above).
    - **Take**: only Players in `playing` can take; GM cannot take (no `players` row → `requireGamePlayer` rejects); taking an owned grant is rejected; take in `ready` and `archived` is rejected; take writes exactly one ledger entry with `source: "treason_grant"` and updates `players.power` (rule 25 reconciliation: `sum(deltas where playerId=X) === players.power[X]` after the operation).
    - **Visibility**: `listGrantsForGame` returns descriptions to GM and to the owner only; non-owner Players see `description: null`; non-participants are rejected outright.
- [ ] Task 21. Update the existing rule-25 reconciliation test (search for the assertion in `convex/`) to also exercise a `treason_grant` ledger source if not already generic. Rationale: protects rule 25 across the new source enum.

### Phase 5 — Documentation

- [ ] Task 22. Add a brief paragraph to `plans/2026-04-20-init-v4.md` under "Confirmed Rules" introducing **Rule 26 — Treason Grants** that succinctly restates Decisions 1–13 above, so the rule numbers stay the canonical authority. Cross-reference this plan file from there.

## Verification Criteria

- The GM can create a Grant with a 1–40 char keyword, a POWER ≥ 1, and an optional description; duplicate (case-insensitive) keyword within the same game is rejected.
- The GM can edit any Grant's keyword and description at any time outside `archived`; attempting to edit POWER on a taken Grant is rejected with a clear error message.
- The GM can delete any Grant outside `archived`. Deleting a taken Grant does **not** alter `players.power` or write any ledger entry.
- The GM can clear ownership of a taken Grant via the confirmation dialog. No POWER is reversed. The Grant becomes takeable again and a take by a different player adds POWER again.
- A Player can see every Grant in the game with its keyword, POWER, and owner. The description is visible only on Grants they own.
- A Player can take an unowned Grant only while the game is `playing`, only via the confirmation dialog. The take atomically (a) sets `ownerPlayerId` and `takenAt`, (b) writes a ledger entry with `source: "treason_grant"`, `delta = +power`, (c) updates `players.power` (rule 25 invariant holds).
- The GM cannot take a Grant — there is no UI affordance and the server-side check rejects any attempt.
- Archived games are read-only with respect to Grants: no create/update/delete/clear/take.
- All mutations and queries reject non-participants outright (rule 24).
- After every test scenario, `sum(ledger.delta where playerId = X) === players.power[X]` for every Player.

## Potential Risks and Mitigations

1. **Description leaks via timing or placeholder text.** A casual implementation might render a different placeholder for "owned by someone else" vs "unowned", letting non-owners infer state changes.
   Mitigation: Task 19 — render an identical placeholder regardless; ownership state is conveyed exclusively by the structured owner field.
2. **Rule 19 source enum drift.** If the schema literal is added but the TypeScript `LedgerSource` union or any switch statement (e.g. ledger pretty-printers) is not updated, runtime values won't match types.
   Mitigation: Task 2 updates the union; the reconciliation test (Task 21) exercises the new source end-to-end.
3. **Race on take.** Two players hitting `Take` concurrently could in principle both succeed.
   Mitigation: Convex mutations are single-document transactions; the `ownerPlayerId === undefined` guard inside the transaction ensures only one wins. The losing client surfaces the "already taken" error inline.
4. **Race on uniqueness.** Two GM browsers creating the same keyword concurrently.
   Mitigation: same single-transaction guard via the `by_game_keywordLower` index lookup (Task 7); whichever commits first wins, the other gets a clear error.
5. **GM forgets POWER is locked after take.** A surprise validation error on edit is confusing.
   Mitigation: Task 18 disables the POWER input client-side and shows a tooltip; the server still enforces the rule for defence in depth.
6. **Re-take after clear-owner is unintuitive.** A GM might expect clearing to also "consume" the grant.
   Mitigation: confirmation copy in Task 17 spells out "POWER is NOT refunded; the grant becomes takeable again." Documented in Task 22.
7. **N+1 in `listGrantsForGame`** when there are many owned grants.
   Mitigation: bulk-resolve unique owner player ids → user display names with the same hydration pattern as `convex/ledger.ts:234-256`.
8. **Lifecycle drift.** Future code paths might transition states without considering Grants.
   Mitigation: every Grant mutation goes through `assertGrantWritable`, which loads the live game state and rejects on `archived`. No `played`-style flag on grants — state is read fresh every mutation.

## Alternative Approaches

1. **Reuse `bank_out` instead of a new ledger source.** Less audit fidelity (Treason Grants and arbitrary GM bank-outs would be indistinguishable in the ledger), but no schema migration. Rejected per Decision 6 — auditability matters more than the one-line schema diff.
2. **Lock all fields once a Grant is taken (option A from clarification).** Simpler, but blocks legitimate typo fixes. Rejected per Decision 8 (B).
3. **Reverse POWER on delete or clear-owner.** Would write compensating ledger entries (e.g. `bank_in` with `delta = -power`). Rejected per Decision 8/9 — owner's already-received POWER is treated as theirs to keep; ledger remains a faithful history of what actually transpired.
4. **Surface Grants in the right rail next to the Call Queue.** Rejected per Decision 14 — descriptions can be long and benefit from full-width main column rendering; the right rail is for compact, frequently-changing summaries.
5. **Allow GM to assign an owner.** Rejected per Decision 9 — the only legitimate path to ownership is a Player's own take action. GM intervention is limited to the inverse (clearing).
6. **Single global pool of Grants, reusable across games.** Rejected per Decision 1 — taking is intrinsically a per-game action and would require additional join state. Per-game keeps the model simple and consistent with `calls`, `gamePlayerMinions`, `notes`.

## Status

Not Started.
