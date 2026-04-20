# Notes Feature

## Objective

Add a per-game **notes** feature so any authenticated game participant (GM or Player) can attach short textual notes to:

- a specific **minion** (any minion surfaced inside the game — typically those belonging to any selected syndicate),
- a specific **syndicate** (any syndicate selected by a player in the game, including the viewer's own),
- the **game** itself.

Notes are **game-scoped** — they never carry across games, even when the same minion/syndicate appears in a future game. Each note has a visibility flag (`private` default, or `public`). Private notes are visible only to the author and the GM; public notes are visible to every participant. The GM always sees every note (private and public) in their game.

Notes surface via a small icon (with an unread/count indicator) that opens a popover listing existing visible notes and an add/edit form.

## Project Structure Summary

- Convex backend: `convex/schema.ts:1-131`, with per-feature modules (`convex/games.ts:1-297`, `convex/minions.ts:1-154`, `convex/syndicates.ts:1-236`, `convex/calls.ts`, `convex/ledger.ts`, `convex/minionBuys.ts`). Auth/authorization helpers are centralised in `convex/lib/auth.ts:1-117` (rule 24 — server-side enforcement).
- React client: `src/pages/GameDetailPage.tsx:1-947` renders the entire game view (header, roster, power panel, minion buy panel, call queue). All game state flows from `api.games.getGameView` and sibling reactive queries.
- Authoritative rules live in `plans/2026-04-20-init-v4.md:1-219`. The notes feature is additive and must not weaken any existing rule (especially rule 24 authorization and rule 23 ledger visibility isolation).

## Relevant Files Examination

- `convex/schema.ts:48-56` — `minions` table definition. Note attachment target.
- `convex/schema.ts:28-38` — `syndicates` table. Note attachment target; notes are still game-scoped even though syndicates are global.
- `convex/schema.ts:58-71` — `games` table. Note attachment target (whole-game notes).
- `convex/games.ts:238-297` — `getGameView` query. The place to add a per-target note-count summary or an unread-count summary without hammering extra queries.
- `convex/minions.ts:125-141` — `minions.remove` cascade. Must also cascade notes bound to the minion once notes exist.
- `convex/syndicates.ts:94-141` — `syndicates.remove` cascade (rule 9). Syndicate delete today only happens when `played=false`; for every game still in `ready`, the selection is cleared. Notes attached to that syndicate in any game remain orphaned unless we cascade — plan cascades per-game.
- `src/pages/GameDetailPage.tsx:21-125` — header + section layout. Primary integration point for note icons on game/roster/syndicate/minion rows.
- `src/pages/GameDetailPage.tsx:263-333` — `RosterList` where per-player selected-syndicate rows live; candidate integration point for syndicate note icons.
- `src/pages/GameDetailPage.tsx:756-861` — `MinionBuyPanel` row rendering; candidate integration point for per-minion note icons.
- `convex/lib/auth.ts:58-87` — `requireGamePlayer` + `getOptionalGamePlayer` helpers. New helper needed: `requireGameParticipant` (GM **or** Player) because both roles can author and (for public notes) view notes.

## Design Decisions & Assumptions

1. **Single `notes` table with a discriminator** — one `notes` table carrying `gameId`, `targetKind: "game" | "syndicate" | "minion"`, optional `targetSyndicateId`, optional `targetMinionId`, `authorUserId`, `visibility: "private" | "public"`, `body`, `createdAt`, `updatedAt`. Target-kind specific indexes give cheap per-target fetches and avoid scanning the whole game's notes.
2. **Scope** — notes are keyed by `gameId`. They are never surfaced or copied into any other game, even when the same syndicate/minion appears there (rule: notes do not carry across).
3. **Authoring eligibility** — any participant (GM or current Player of this game) may author a note on any target within that game. Non-participants are rejected (parallels rule 24 for everything else in the game).
4. **Visibility** — `private` is the default. Private visibility means author + GM only. Public means every participant in the game. The GM always sees every note regardless of visibility (as the rules already let the GM see all ledgers, rule 23; this extends the pattern to notes).
5. **Editing / deletion** — only the author may edit their note body and flip its visibility. Only the author or the GM may delete a note. Editing a note updates `updatedAt`. Edits do not change the author or `createdAt`.
6. **Target validity** — a note can only be created on a target that currently exists and is valid in this game:
    - `game` — `gameId` exists.
    - `syndicate` — syndicate exists (no requirement that it currently be selected; once a syndicate has been selected by a player in the game it is relevant; we still require any user to know the id, which they will only if the game view surfaces it — i.e. selected syndicates in the roster, plus the viewer's own). To keep scope simple, allow the mutation when the `syndicateId` is either (a) currently selected by some player in the game or (b) the viewer has access to it (owns it or `isShared`). This preserves live updates if the selection changes without losing existing notes.
    - `minion` — minion exists and belongs to a syndicate that satisfies the syndicate-visibility rule above for this game. Practically: the minion's syndicate must be selected by some player in this game (so the minion is surfaced to the game at all), or owned/shared with the viewer.
7. **Note body constraints** — trimmed, 1–2000 characters. No rich text in v1. Authorization is server-side (rule 24).
8. **Cascade on entity deletion** — when a minion is deleted (only possible while its syndicate's `played=false`) and when a syndicate is deleted (rule 9), cascade-delete every note that targets it. Game archiving does **not** delete notes (they are game history). No separate "delete game" flow exists today.
9. **UI placement** — a consistent `<NoteIcon kind=… id=… />` component, sized ~16px, with a small count badge when visible notes exist. Clicking opens an anchored popover with the list + add form. For v1 we add icons to:
    - the game header next to the game name,
    - each roster row's selected-syndicate line,
    - each minion row in the minion buy panel.
    Call queue rows are **out of scope** for v1 (the underlying minion already has a note icon in the buy panel).
10. **Reactivity** — the notes popover fetches via `useQuery` so open popovers live-update across all viewers when another user adds/edits notes. Convex reactivity already drives the rest of the page.
11. **No pagination in v1** — note counts per target are expected to be small (tens). Return sorted notes for a target directly; paginate only if we later see large note counts.
12. **No unread tracking in v1** — the icon badge shows visible-note count, not an unread count.

## Implementation Plan

### Phase 1 — Schema & Authorization Helper

- [ ] Task 1. Add a `notes` table to `convex/schema.ts` with fields `gameId: v.id("games")`, `targetKind: v.union(v.literal("game"), v.literal("syndicate"), v.literal("minion"))`, `targetSyndicateId: v.optional(v.id("syndicates"))`, `targetMinionId: v.optional(v.id("minions"))`, `authorUserId: v.id("users")`, `visibility: v.union(v.literal("private"), v.literal("public"))`, `body: v.string()`, `createdAt: v.number()`, `updatedAt: v.number()`. Rationale: one discriminated table serves all three attachment targets and keeps visibility rules uniform.
- [ ] Task 2. Add indexes to `notes`: `by_game_kind_created` on `(gameId, targetKind, createdAt)` for game-level note queries, `by_game_syndicate_created` on `(gameId, targetSyndicateId, createdAt)` for syndicate-target queries, `by_game_minion_created` on `(gameId, targetMinionId, createdAt)` for minion-target queries, and `by_author_game` on `(authorUserId, gameId)` for future "my notes" views and author-scoped deletes. Rationale: every listing query must hit an index (guideline: no `filter` in queries).
- [ ] Task 3. Extend `convex/lib/auth.ts` with `requireGameParticipant(ctx, gameId)` returning `{ game, role: "gm" | "player", userId, playerId?: Id<"players"> }`. Throws when the caller is neither GM nor a Player in the game. Rationale: notes need a role that admits both GM and Player; no existing helper covers this combined role.
- [ ] Task 4. Add a helper `canViewNote(note, viewer)` (pure function, co-located with note logic) encoding the visibility rule: author sees all own notes; GM sees all; otherwise only `public`. Rationale: one source of truth for visibility, reused in every query and mutation.

### Phase 2 — Convex Backend (`convex/notes.ts`)

- [ ] Task 5. Create `convex/notes.ts` with the mutation `createNote({ gameId, targetKind, targetSyndicateId?, targetMinionId?, body, visibility? })`. Steps: `requireGameParticipant(ctx, gameId)`; validate that the target fields are consistent with `targetKind` (exactly one of `targetSyndicateId`/`targetMinionId` is set when applicable, both absent when `targetKind === "game"`); validate `body` trimmed length 1–2000; validate target existence + visibility per the assumptions (for `syndicate`/`minion`, walk up to the syndicate and confirm it is either selected in this game or accessible to the viewer); default `visibility = "private"`; insert with `createdAt = updatedAt = Date.now()` and `authorUserId = viewer`. Rationale: authorable by any participant; server-side validation (rule 24).
- [ ] Task 6. Add mutation `updateNote({ noteId, body?, visibility? })`. Loads the note, `requireGameParticipant` for `note.gameId`, rejects unless viewer is the author, applies patch with validation, stamps `updatedAt`. Rationale: only authors edit their own content; GM is not an editor (GM moderation is via delete).
- [ ] Task 7. Add mutation `deleteNote({ noteId })`. Loads the note, `requireGameParticipant`, allows delete when viewer is author **or** GM of `note.gameId`. Rationale: GM moderation; authors always control their own notes.
- [ ] Task 8. Add query `listNotesForTarget({ gameId, targetKind, targetSyndicateId?, targetMinionId? })` returning notes for that target filtered by `canViewNote` for the viewer. Notes are ordered `createdAt` descending. Each returned note includes `authorDisplayName`, `canEdit` (author-only), `canDelete` (author or GM). Uses the matching compound index. Rationale: drives the popover list.
- [ ] Task 9. Add query `getNoteCountsForGameView({ gameId })` returning, for each target the viewer can see, a visible-note count: `{ gameNotes: number; bySyndicate: Record<Id<"syndicates">, number>; byMinion: Record<Id<"minions">, number> }`. This runs once per game detail render, so icons can show a badge without per-icon queries. It must apply `canViewNote` during aggregation. Rationale: avoid N+1 queries for badge counts across roster rows and minion rows.
- [ ] Task 10. Extend `convex/minions.ts:125-141` `minions.remove` to cascade-delete every note with `targetMinionId === minionId` (use `by_game_minion_created` or a dedicated `by_minion` index if cheaper). Rationale: prevents orphan notes referencing a deleted minion. Consider adding `by_minion` (`targetMinionId`) index to `notes` to keep cascade O(notes on minion).
- [ ] Task 11. Extend `convex/syndicates.ts:94-141` `syndicates.remove` cascade to delete every note with `targetSyndicateId === syndicateId` **and** every note targeting a minion that belonged to this syndicate. Rationale: completes rule 9 semantics for the note feature; prevents dangling notes when a syndicate is deleted while still editable. Add a `by_syndicate` (`targetSyndicateId`) index if cascade volume requires it.
- [ ] Task 12. (Optional but recommended for completeness) In `convex/games.ts`, if/when a game is ever hard-deleted, cascade-delete its notes. Today no `deleteGame` mutation exists, so this is a defensive-doc TODO only. Rationale: document the invariant even when not yet enforced.

### Phase 3 — Shared UI Components

- [ ] Task 13. Create `src/components/NoteIcon.tsx`: a small button showing a chat/note glyph with an optional numeric badge. Props: `{ gameId, targetKind, targetSyndicateId?, targetMinionId?, count }`. Clicking toggles a `NotesPopover` anchored to the icon. Include ARIA attributes (`aria-haspopup`, `aria-expanded`) and keyboard activation (Enter/Space), plus Escape-to-close in the popover. Rationale: reusable across all three attachment surfaces, accessible by default (rule 43 in `plans/2026-04-20-init-v4.md:135`).
- [ ] Task 14. Create `src/components/NotesPopover.tsx`: uses `api.notes.listNotesForTarget` to render the notes list (newest first), each item showing author display name, timestamp, visibility badge, body, and edit/delete controls gated on `canEdit`/`canDelete`. Provides an "Add note" form with a textarea (1–2000 chars), a visibility toggle (`private` default, `public` opt-in), and submit via `api.notes.createNote`. Edit inline via `api.notes.updateNote`; delete with confirm via `api.notes.deleteNote`. Rationale: single popover UI covers create/read/update/delete uniformly.
- [ ] Task 15. Style the popover as a floating card with simple positioning (CSS `position: absolute` relative to the icon's wrapper; a click-outside listener closes it). Avoid pulling a new dependency for v1; if positioning complexity grows, revisit. Rationale: keep the dependency surface minimal; match existing card styling in `src/index.css`.
- [ ] Task 16. Add a helper hook `useNotesCountMap(gameId)` that wraps `api.notes.getNoteCountsForGameView` to feed badge counts to every `NoteIcon` on the page with a single reactive subscription. Rationale: prevents fan-out of subscriptions; keeps game detail snappy (rule 11 in risks).

### Phase 4 — Page Integration

- [ ] Task 17. In `src/pages/GameDetailPage.tsx:27-47` (game header area), render a `NoteIcon` with `targetKind="game"` next to the game title. Feed its `count` from `useNotesCountMap(gameId)`. Rationale: whole-game notes surface.
- [ ] Task 18. In `src/pages/GameDetailPage.tsx:301-331` (`RosterList` row rendering), when a row has a `selectedSyndicate`, render a `NoteIcon` with `targetKind="syndicate"` + the syndicate id next to the syndicate line. The icon is shown to every viewer; count comes from the shared counts map. Rationale: syndicate notes are scoped to the game and live on the roster row; players can annotate any syndicate in play.
- [ ] Task 19. In `src/pages/GameDetailPage.tsx:802-858` (`MinionBuyPanel` row), render a `NoteIcon` with `targetKind="minion"` + the minion id on each minion row. Rationale: per-minion notes surface directly on the minion card players interact with.
- [ ] Task 20. (Stretch) In the Call Queue row rendering (`src/pages/GameDetailPage.tsx:892-917`), consider adding a minion-note icon reusing the same component. Left optional for v1 per assumption 9. Rationale: minion notes are already reachable through the buy panel.

### Phase 5 — Tests & Verification

- [ ] Task 21. `convex-test` authorization matrix for `notes`:
    - non-participant cannot create/read/update/delete any note in the game,
    - participant Player can create on all three target kinds,
    - participant Player can edit and delete **own** notes only,
    - GM can delete any note but cannot edit a note whose author is someone else,
    - private notes are invisible to other Players via `listNotesForTarget` and `getNoteCountsForGameView`,
    - private notes are visible to GM.
- [ ] Task 22. `convex-test` game-scoping: creating two games with the same syndicate selected in both; notes created in game A do **not** appear when listing notes for the same syndicate id in game B. Rationale: enforces "notes do not carry across games".
- [ ] Task 23. `convex-test` cascade: deleting a minion removes its notes; deleting a syndicate (only possible while `played=false`) removes notes on that syndicate and on all minions belonging to it; non-cascade deletions (e.g. removing a Player row in `ready`) leave notes intact. Rationale: enforce Task 10/Task 11 invariants.
- [ ] Task 24. `convex-test` edit flow: `updatedAt` moves forward on body change; visibility flip is persisted; editing by non-author is rejected; editing a note in an archived game is still allowed (notes remain editable after archive in v1) — confirm this matches design intent or restrict if stakeholder prefers otherwise.
- [ ] Task 25. Count-query correctness: `getNoteCountsForGameView` returns counts that exactly match what `listNotesForTarget` returns for each target under the same viewer. Rationale: badge/list consistency.
- [ ] Task 26. Manual smoke test across two browser contexts (GM + Player) to confirm Convex reactivity pushes new/edited/deleted notes into open popovers without manual refresh (parallels rule 16 elapsed-time and rule 22 call-queue live updates).

## Verification Criteria

- The `notes` table exists with fields and indexes as specified; all new queries avoid `.filter()` in favour of `withIndex` (Convex guideline).
- A participant can create a note on the game, on any syndicate currently selected in that game or accessible to them, and on any minion of such syndicates. A non-participant is rejected by the server regardless of UI state.
- Default visibility on create is `private`. The author can toggle between `private` and `public` via `updateNote`.
- Private notes are visible only to their author and to the GM. Public notes are visible to every participant. The GM sees every note, including private notes authored by others.
- Notes never cross game boundaries: creating a note on a syndicate in game A does not cause it to surface on the same syndicate in game B.
- The game header, each roster row's selected syndicate, and each minion in the buy panel each show a note icon with a visible-note count badge. Clicking any icon opens a popover anchored to it, listing visible notes newest-first and offering an add-note form.
- The popover lets authors edit and delete their own notes; GMs can delete any note; nobody else can edit or delete notes that are not theirs.
- Deleting a minion (while its syndicate is still editable) deletes all notes attached to that minion. Deleting a syndicate (rule 9) deletes all notes targeting that syndicate and any of its minions.
- Opening the popover on one browser reflects a note added in another browser without a manual refresh (Convex reactivity).
- All bodies are trimmed and rejected unless 1–2000 characters.
- Existing rules and tests are unchanged in behaviour: notes are strictly additive.

## Potential Risks and Mitigations

1. **Visibility leak** — a participant accidentally sees another player's private note.
   Mitigation: single `canViewNote` helper (Task 4) used by every query and every count aggregation; dedicated authorization test (Task 21) asserting cross-player invisibility of private notes; never expose raw `notes` rows from any other pathway.
2. **Cascade gaps on entity deletion** — orphan notes after minion/syndicate deletion.
   Mitigation: extend `minions.remove` and `syndicates.remove` cascades with dedicated tests (Task 23); add `by_minion` / `by_syndicate` indexes if cascade cost grows.
3. **N+1 badge queries across many minion rows** — one `useQuery` per icon would spam the backend.
   Mitigation: single `getNoteCountsForGameView` query feeding a shared counts map (Task 9, Task 16).
4. **Cross-game contamination** — reusing a syndicate id or minion id in a different game surfaces the wrong game's notes.
   Mitigation: every query/index is keyed by `(gameId, target*)`; explicit test (Task 22).
5. **Popover positioning and accessibility regressions** — custom popover without a library can be fiddly.
   Mitigation: keep positioning simple (anchored absolutely relative to icon wrapper), add ARIA attributes and Escape handling (Task 13), manual keyboard and screen-reader smoke test.
6. **Note-body abuse** — very long notes or flooding.
   Mitigation: 1–2000-char server-side limit; consider a future per-game per-user rate limit if abuse emerges (out of scope for v1).
7. **Archived-game editability** — unclear whether edits should be locked once archived.
   Mitigation: v1 assumption is that notes remain mutable after archive (games remain readable; this is consistent with archive being a display-only state). Document in Task 24 and flag for stakeholder confirmation before finalising.
8. **Scope creep onto call queue and ledger entries** — temptation to add notes on every entity.
   Mitigation: explicit v1 scope of three targets; call-queue/ledger left as future work.

## Alternative Approaches

1. **Per-target tables** (`gameNotes`, `syndicateNotes`, `minionNotes`) instead of one `notes` table with a discriminator. Trade-off: simpler indexes, at the cost of three near-identical CRUD surfaces and triplicated visibility logic. Rejected because the discriminator pattern keeps visibility/authorization in one place and the total number of notes per game is expected to be small.
2. **Notes stored as JSON blobs on the parent document** (e.g. an array on `games`, `syndicates`, `minions`). Rejected: violates the Convex guideline against unbounded arrays on documents and breaks the "notes are game-scoped" requirement for syndicates/minions (which are global, not per-game).
3. **Soft delete with `deletedAt`** to preserve an audit trail of notes. Rejected for v1 to keep scope small; notes are informational, not audit-grade. Revisit if product wants history.
4. **Unread tracking per viewer** using a `noteReads` table. Rejected for v1; the badge shows current visible-note count instead. Adding unread tracking later is mechanical.
5. **Rich-text / markdown rendering**. Deferred to a later iteration; v1 stores and renders plain text only to avoid an XSS surface and a new dependency.
6. **Real-time typing indicators / collaborative editing** on the notes popover. Out of scope — each note is a single-author artifact.
