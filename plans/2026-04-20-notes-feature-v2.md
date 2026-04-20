# Notes Feature

## Objective

Add a per-game **notes** feature so any authenticated game participant (GM or Player) can attach short textual notes to:

- a specific **minion** (any minion surfaced inside the game — typically those belonging to any selected syndicate),
- a specific **syndicate** (any syndicate selected by a player in the game, including the viewer's own),
- the **game** itself.

Notes are **game-scoped** — they never carry across games, even when the same minion/syndicate appears in a future game. Each note has a visibility flag (`private` default, or `public`). Private notes are visible only to the author and the GM; public notes are visible to every participant. The GM always sees every note (private and public) in their game.

Notes are **immutable once created** — there is no edit flow. Only the **GM** may delete a note; authors cannot delete their own notes. Notes are displayed **newest first**.

Notes surface via a small icon (with a count indicator) that opens a popover listing visible notes and an add-note form.

## Project Structure Summary

- Convex backend: `convex/schema.ts:1-131`, with per-feature modules (`convex/games.ts:1-297`, `convex/minions.ts:1-154`, `convex/syndicates.ts:1-236`, `convex/calls.ts`, `convex/ledger.ts`, `convex/minionBuys.ts`). Auth/authorization helpers are centralised in `convex/lib/auth.ts:1-117` (rule 24 — server-side enforcement).
- React client: `src/pages/GameDetailPage.tsx:1-947` renders the entire game view (header, roster, power panel, minion buy panel, call queue). All game state flows from `api.games.getGameView` and sibling reactive queries.
- Authoritative rules live in `plans/2026-04-20-init-v4.md:1-219`. The notes feature is additive and must not weaken any existing rule (especially rule 24 authorization and rule 23 ledger visibility isolation).

## Relevant Files Examination

- `convex/schema.ts:48-56` — `minions` table definition. Note attachment target.
- `convex/schema.ts:28-38` — `syndicates` table. Note attachment target; notes are still game-scoped even though syndicates are global.
- `convex/schema.ts:58-71` — `games` table. Note attachment target (whole-game notes).
- `convex/games.ts:238-297` — `getGameView` query. The place to add a per-target note-count summary without hammering extra queries.
- `convex/minions.ts:125-141` — `minions.remove` cascade. Must also cascade notes bound to the minion once notes exist.
- `convex/syndicates.ts:94-141` — `syndicates.remove` cascade (rule 9). Notes attached to that syndicate in any game remain orphaned unless we cascade — plan cascades per-game.
- `src/pages/GameDetailPage.tsx:21-125` — header + section layout. Primary integration point for note icons on game/roster/syndicate/minion rows.
- `src/pages/GameDetailPage.tsx:263-333` — `RosterList` where per-player selected-syndicate rows live; candidate integration point for syndicate note icons.
- `src/pages/GameDetailPage.tsx:756-861` — `MinionBuyPanel` row rendering; candidate integration point for per-minion note icons.
- `convex/lib/auth.ts:58-87` — `requireGamePlayer` + `getOptionalGamePlayer` helpers. New helper needed: `requireGameParticipant` (GM **or** Player) because both roles can author and (for public notes) view notes.

## Design Decisions & Assumptions

1. **Single `notes` table with a discriminator** — one `notes` table carrying `gameId`, `targetKind: "game" | "syndicate" | "minion"`, optional `targetSyndicateId`, optional `targetMinionId`, `authorUserId`, `visibility: "private" | "public"`, `body`, `createdAt`. Target-kind specific indexes give cheap per-target fetches and avoid scanning the whole game's notes.
2. **Scope** — notes are keyed by `gameId`. They are never surfaced or copied into any other game, even when the same syndicate/minion appears there.
3. **Authoring eligibility** — any participant (GM or current Player of this game) may author a note on any target within that game. Non-participants are rejected (parallels rule 24 for everything else in the game).
4. **Visibility** — `private` is the default. Private visibility means author + GM only. Public means every participant in the game. The GM always sees every note regardless of visibility (parallels rule 23 for ledgers).
5. **Immutability** — there is **no** note-edit flow. Once posted, a note's body, visibility, author, and `createdAt` are fixed. If the author wants to change what a note says, they post a new note and (if undesirable) ask the GM to delete the old one. Rationale: game-play notes act as a chat-like record; immutability prevents retroactive tampering and simplifies trust boundaries. No `updatedAt` field is required.
6. **Deletion** — **only the GM of the game** may delete a note. Authors cannot delete their own notes. Non-GM participants cannot delete any note. Rationale: concentrates moderation in the GM role and removes one class of self-edit via delete-and-repost racing.
7. **Target validity** — a note can only be created on a target that currently exists and is valid in this game:
    - `game` — `gameId` exists.
    - `syndicate` — syndicate exists and is either (a) currently selected by some Player in this game, or (b) accessible to the viewer (owned or `isShared`).
    - `minion` — minion exists and belongs to a syndicate that satisfies the syndicate-visibility rule above for this game.
8. **Note body constraints** — trimmed, 1–2000 characters. No rich text in v1. All validation is server-side (rule 24).
9. **Cascade on entity deletion** — when a minion is deleted (only possible while its syndicate's `played=false`) and when a syndicate is deleted (rule 9), cascade-delete every note that targets it. Game archiving does **not** delete notes (they are game history). No separate "delete game" flow exists today.
10. **Ordering** — notes are **sorted newest first** (`createdAt` descending) everywhere they are listed.
11. **UI placement** — a consistent `<NoteIcon kind=… id=… />` component, sized ~16px, with a small count badge when visible notes exist. Clicking opens an anchored popover listing visible notes (newest first) and an add-note form. For v1 we add icons to:
    - the game header next to the game name,
    - each roster row's selected-syndicate line,
    - each minion row in the minion buy panel.
    Call queue rows are **out of scope** for v1 (the underlying minion already has a note icon in the buy panel).
12. **Reactivity** — the notes popover fetches via `useQuery` so open popovers live-update across all viewers when another user adds/deletes notes.
13. **No pagination in v1** — note counts per target are expected to be small (tens). Return sorted notes for a target directly; paginate only if we later see large note counts.
14. **No unread tracking in v1** — the icon badge shows visible-note count, not an unread count.

## Implementation Plan

### Phase 1 — Schema & Authorization Helper

- [ ] Task 1. Add a `notes` table to `convex/schema.ts` with fields `gameId: v.id("games")`, `targetKind: v.union(v.literal("game"), v.literal("syndicate"), v.literal("minion"))`, `targetSyndicateId: v.optional(v.id("syndicates"))`, `targetMinionId: v.optional(v.id("minions"))`, `authorUserId: v.id("users")`, `visibility: v.union(v.literal("private"), v.literal("public"))`, `body: v.string()`, `createdAt: v.number()`. No `updatedAt` — notes are immutable. Rationale: one discriminated table serves all three attachment targets and keeps visibility rules uniform.
- [ ] Task 2. Add indexes to `notes`: `by_game_kind_created` on `(gameId, targetKind, createdAt)` for game-level note queries, `by_game_syndicate_created` on `(gameId, targetSyndicateId, createdAt)` for syndicate-target queries, `by_game_minion_created` on `(gameId, targetMinionId, createdAt)` for minion-target queries, and `by_author_game` on `(authorUserId, gameId)` for author-scoped reads and future "my notes" views. Rationale: every listing query must hit an index (Convex guideline: no `filter` in queries) and all listings use descending order on `createdAt`.
- [ ] Task 3. Extend `convex/lib/auth.ts` with `requireGameParticipant(ctx, gameId)` returning `{ game, role: "gm" | "player", userId, playerId?: Id<"players"> }`. Throws when the caller is neither GM nor a Player in the game. Rationale: notes need a role that admits both GM and Player; no existing helper covers this combined role.
- [ ] Task 4. Add a helper `canViewNote(note, viewer)` (pure function, co-located with note logic) encoding the visibility rule: author sees all own notes; GM sees all; otherwise only `public`. Rationale: one source of truth for visibility, reused in every query and cascade.

### Phase 2 — Convex Backend (`convex/notes.ts`)

- [ ] Task 5. Create `convex/notes.ts` with the mutation `createNote({ gameId, targetKind, targetSyndicateId?, targetMinionId?, body, visibility? })`. Steps: `requireGameParticipant(ctx, gameId)`; validate that the target fields are consistent with `targetKind` (exactly one of `targetSyndicateId`/`targetMinionId` is set when applicable, both absent when `targetKind === "game"`); validate `body` trimmed length 1–2000; validate target existence + visibility per the assumptions (for `syndicate`/`minion`, walk up to the syndicate and confirm it is either selected in this game or accessible to the viewer); default `visibility = "private"`; insert with `createdAt = Date.now()` and `authorUserId = viewer`. Rationale: authorable by any participant; server-side validation (rule 24).
- [ ] Task 6. Add mutation `deleteNote({ noteId })`. Loads the note, resolves `note.gameId`, requires the caller to be the **GM** of that game. Reject with a clear authorization error for authors and other participants. Rationale: deletion is a GM-only moderation action per the feedback.
- [ ] Task 7. **No `updateNote` mutation** exists. This is intentional — notes are immutable. Rationale: prevents retroactive edits; simplifies visibility/audit reasoning.
- [ ] Task 8. Add query `listNotesForTarget({ gameId, targetKind, targetSyndicateId?, targetMinionId? })` returning notes for that target filtered by `canViewNote` for the viewer, ordered `createdAt` descending (newest first) via the matching compound index with `.order("desc")`. Each returned note includes `authorDisplayName`, `canDelete` (true iff viewer is GM). Rationale: drives the popover list; enforces both visibility and ordering server-side.
- [ ] Task 9. Add query `getNoteCountsForGameView({ gameId })` returning, for each target the viewer can see, a visible-note count: `{ gameNotes: number; bySyndicate: Record<Id<"syndicates">, number>; byMinion: Record<Id<"minions">, number> }`. It must apply `canViewNote` during aggregation. Rationale: avoid N+1 queries for badge counts across roster rows and minion rows.
- [ ] Task 10. Extend `convex/minions.ts:125-141` `minions.remove` to cascade-delete every note with `targetMinionId === minionId` (add a dedicated `by_minion` index on `notes` if cascade volume becomes relevant). Rationale: prevents orphan notes referencing a deleted minion.
- [ ] Task 11. Extend `convex/syndicates.ts:94-141` `syndicates.remove` cascade to delete every note with `targetSyndicateId === syndicateId` **and** every note targeting a minion that belonged to this syndicate. Rationale: completes rule 9 semantics for the note feature; prevents dangling notes when a syndicate is deleted while still editable. Add a `by_syndicate` index on `notes` if cascade volume requires it.
- [ ] Task 12. (Defensive documentation) In `convex/games.ts`, leave a TODO comment noting that any future `deleteGame` mutation must cascade-delete its notes. Today no such mutation exists. Rationale: documents the invariant even when not yet enforced.

### Phase 3 — Shared UI Components

- [ ] Task 13. Create `src/components/NoteIcon.tsx`: a small button showing a chat/note glyph with an optional numeric badge. Props: `{ gameId, targetKind, targetSyndicateId?, targetMinionId?, count }`. Clicking toggles a `NotesPopover` anchored to the icon. Include ARIA attributes (`aria-haspopup`, `aria-expanded`) and keyboard activation (Enter/Space), plus Escape-to-close in the popover. Rationale: reusable across all three attachment surfaces, accessible by default (rule 43 in `plans/2026-04-20-init-v4.md:135`).
- [ ] Task 14. Create `src/components/NotesPopover.tsx`: uses `api.notes.listNotesForTarget` to render the notes list newest-first, each item showing author display name, timestamp, visibility badge, and body. A delete button is rendered per item only when `canDelete` is true (i.e. the viewer is the GM); it prompts for confirmation before calling `api.notes.deleteNote`. **No edit affordance is rendered for any viewer.** Provides an "Add note" form with a textarea (1–2000 chars), a visibility toggle (`private` default, `public` opt-in), and submit via `api.notes.createNote`. Rationale: single popover UI covers create / read / delete uniformly; immutability is reflected in the UI by the absence of an edit control.
- [ ] Task 15. Style the popover as a floating card with simple positioning (CSS `position: absolute` relative to the icon's wrapper; a click-outside listener closes it). Avoid pulling a new dependency for v1. Rationale: keep the dependency surface minimal; match existing card styling in `src/index.css`.
- [ ] Task 16. Add a helper hook `useNotesCountMap(gameId)` that wraps `api.notes.getNoteCountsForGameView` to feed badge counts to every `NoteIcon` on the page with a single reactive subscription. Rationale: prevents fan-out of subscriptions; keeps game detail snappy.

### Phase 4 — Page Integration

- [ ] Task 17. In `src/pages/GameDetailPage.tsx:27-47` (game header area), render a `NoteIcon` with `targetKind="game"` next to the game title. Feed its `count` from `useNotesCountMap(gameId)`. Rationale: whole-game notes surface.
- [ ] Task 18. In `src/pages/GameDetailPage.tsx:301-331` (`RosterList` row rendering), when a row has a `selectedSyndicate`, render a `NoteIcon` with `targetKind="syndicate"` + the syndicate id next to the syndicate line. The icon is shown to every viewer; count comes from the shared counts map. Rationale: syndicate notes are scoped to the game and live on the roster row.
- [ ] Task 19. In `src/pages/GameDetailPage.tsx:802-858` (`MinionBuyPanel` row), render a `NoteIcon` with `targetKind="minion"` + the minion id on each minion row. Rationale: per-minion notes surface directly on the minion card players interact with.
- [ ] Task 20. (Stretch) In the Call Queue row rendering (`src/pages/GameDetailPage.tsx:892-917`), consider adding a minion-note icon reusing the same component. Left optional for v1. Rationale: minion notes are already reachable through the buy panel.

### Phase 5 — Tests & Verification

- [ ] Task 21. `convex-test` authorization matrix for `notes`:
    - non-participant cannot create, read, or delete any note in the game,
    - participant Player can create on all three target kinds,
    - participant Player **cannot** delete any note, including their own,
    - GM can delete any note (own-authored, author-authored, private, public),
    - private notes are invisible to other Players via `listNotesForTarget` and `getNoteCountsForGameView`,
    - private notes are visible to the GM.
- [ ] Task 22. `convex-test` absence of edit surface: assert that no `updateNote`-style mutation exists in `api.notes`, and that `notes` documents have no `updatedAt` field. Rationale: locks the immutability decision into the test suite.
- [ ] Task 23. `convex-test` ordering: creating three notes on the same target at distinct timestamps returns them newest-first from `listNotesForTarget`. Rationale: enforces the "sorted newest first" requirement.
- [ ] Task 24. `convex-test` game-scoping: creating two games with the same syndicate selected in both; notes created in game A do **not** appear when listing notes for the same syndicate id in game B. Rationale: enforces "notes do not carry across games".
- [ ] Task 25. `convex-test` cascade: deleting a minion removes its notes; deleting a syndicate (only possible while `played=false`) removes notes on that syndicate and on all minions belonging to it; unrelated deletions (e.g. removing a Player row in `ready`) leave notes intact. Rationale: enforce Task 10 / Task 11 invariants.
- [ ] Task 26. Count-query correctness: `getNoteCountsForGameView` returns counts that exactly match what `listNotesForTarget` returns for each target under the same viewer. Rationale: badge/list consistency.
- [ ] Task 27. Manual smoke test across two browser contexts (GM + Player) to confirm Convex reactivity pushes new/deleted notes into open popovers without manual refresh.

## Verification Criteria

- The `notes` table exists with fields and indexes as specified and **no `updatedAt` field**; all new queries avoid `.filter()` in favour of `withIndex` (Convex guideline).
- A participant can create a note on the game, on any syndicate currently selected in that game or accessible to them, and on any minion of such syndicates. A non-participant is rejected by the server regardless of UI state.
- Default visibility on create is `private`. Visibility is fixed at creation time — there is no mechanism to change it afterwards.
- **Notes cannot be edited** — no `updateNote` mutation exists and the UI renders no edit affordance.
- **Only the GM** of the owning game can delete a note. Authors and other Players cannot delete any note. The server enforces this regardless of the UI.
- Private notes are visible only to their author and to the GM. Public notes are visible to every participant. The GM sees every note, including private notes authored by others.
- Notes never cross game boundaries.
- Every notes listing, including the popover, renders notes sorted by `createdAt` descending (newest first).
- The game header, each roster row's selected syndicate, and each minion in the buy panel each show a note icon with a visible-note count badge. Clicking any icon opens a popover anchored to it, listing visible notes newest-first and offering an add-note form.
- Deleting a minion deletes all notes attached to that minion. Deleting a syndicate (rule 9) deletes all notes targeting that syndicate and any of its minions.
- Opening the popover on one browser reflects a note added (or deleted by the GM) in another browser without a manual refresh.
- All bodies are trimmed and rejected unless 1–2000 characters.
- Existing rules and tests are unchanged in behaviour: notes are strictly additive.

## Potential Risks and Mitigations

1. **Visibility leak** — a participant accidentally sees another player's private note.
   Mitigation: single `canViewNote` helper (Task 4) used by every query and every count aggregation; dedicated authorization test (Task 21) asserting cross-player invisibility of private notes; never expose raw `notes` rows from any other pathway.
2. **Cascade gaps on entity deletion** — orphan notes after minion/syndicate deletion.
   Mitigation: extend `minions.remove` and `syndicates.remove` cascades with dedicated tests (Task 25); add `by_minion` / `by_syndicate` indexes on `notes` if cascade cost grows.
3. **N+1 badge queries across many minion rows** — one `useQuery` per icon would spam the backend.
   Mitigation: single `getNoteCountsForGameView` query feeding a shared counts map (Task 9, Task 16).
4. **Cross-game contamination** — reusing a syndicate id or minion id in a different game surfaces the wrong game's notes.
   Mitigation: every query/index is keyed by `(gameId, target*)`; explicit test (Task 24).
5. **Popover positioning and accessibility regressions** — custom popover without a library can be fiddly.
   Mitigation: keep positioning simple (anchored absolutely relative to icon wrapper), add ARIA attributes and Escape handling (Task 13), manual keyboard and screen-reader smoke test.
6. **Author remorse with no edit or self-delete path** — once posted, a note is permanent unless the GM removes it. This is the intended trade-off, but can frustrate authors who make typos.
   Mitigation: surface a confirmation dialog on the "Post note" submit step so the author must explicitly confirm; document in in-UI help text that notes are immutable and only the GM can delete.
7. **Note-body abuse** — very long notes or flooding, especially given no self-deletion.
   Mitigation: 1–2000-char server-side limit; GM delete acts as the moderation lever; consider a future per-game per-user rate limit if abuse emerges (out of scope for v1).
8. **Scope creep onto call queue and ledger entries** — temptation to add notes on every entity.
   Mitigation: explicit v1 scope of three targets; call-queue/ledger left as future work.

## Alternative Approaches

1. **Per-target tables** (`gameNotes`, `syndicateNotes`, `minionNotes`) instead of one `notes` table with a discriminator. Trade-off: simpler indexes, at the cost of three near-identical CRUD surfaces and triplicated visibility logic. Rejected because the discriminator pattern keeps visibility/authorization in one place and the total number of notes per game is expected to be small.
2. **Notes stored as JSON blobs on the parent document** (e.g. an array on `games`, `syndicates`, `minions`). Rejected: violates the Convex guideline against unbounded arrays on documents and breaks the "notes are game-scoped" requirement for syndicates/minions (which are global, not per-game).
3. **Allow authors to delete their own notes.** Rejected per explicit feedback — deletion is a GM-only moderation lever. Keeps moderation concentrated and closes a "delete-and-repost" editing loophole.
4. **Allow authors to edit their own notes.** Rejected per explicit feedback — notes are immutable; to change content, post a new note and ask the GM to delete the old one.
5. **Soft delete with `deletedAt`** to preserve an audit trail of GM-removed notes. Rejected for v1 to keep scope small; can be added later without breaking the schema because no `updatedAt`/`deletedAt` fields exist yet and adding one is additive.
6. **Unread tracking per viewer** using a `noteReads` table. Rejected for v1; the badge shows current visible-note count instead.
7. **Rich-text / markdown rendering**. Deferred to a later iteration; v1 stores and renders plain text only to avoid an XSS surface and a new dependency.
