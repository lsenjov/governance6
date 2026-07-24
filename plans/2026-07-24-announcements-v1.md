# Announcements v1

## Goal

Add per-game announcements that the GM can prepare and maintain while a game is
`ready` or `playing`. Players cannot discover announcements during `ready`;
all game participants can read them during `playing` and `archived`.
Announcements remain visible but become immutable after archiving.

Each announcement is a single plain-text body and can receive the existing
private/public notes. The section appears below Goals and uses the existing
per-game management-controls toggle.

## Decisions

- A game may contain zero or more announcements.
- Bodies are trimmed plain text, 1–2000 characters.
- Rows are displayed in creation order, oldest first. Editing does not move a
  row.
- The GM can create, edit, and delete announcements in `ready` and `playing`.
  The backend rejects all announcement writes in `archived`.
- Only the GM can read announcements in `ready`. In `playing` and `archived`,
  the GM and rostered Players can read them.
- Announcement notes use the existing note rules. Participants may continue
  adding notes after archiving.
- An announcement accepts at most 100 notes. This keeps its note cascade within
  one bounded Convex transaction when the GM deletes it.
- A Player cannot create, list, count, or discover announcement notes while the
  game is `ready`, including through the Notes drawer.
- Deleting an announcement deletes its attached notes in the same transaction.
- The Notes drawer labels an announcement target with the first 80 characters
  of its body, adding an ellipsis when truncated.
- The empty section is hidden from Players and remains available to the GM.
- The existing “Hide management controls” setting hides announcement create,
  edit, and delete controls, but never hides announcement text or note icons.

## Step 1 — Announcement data and lifecycle

- Add an `announcements` table with `gameId`, `body`, `createdAt`, and
  `createdByUserId`, indexed by `(gameId, createdAt)`.
- Add `convex/announcements.ts` with:
  - `createAnnouncement({ gameId, body })`
  - `updateAnnouncement({ announcementId, body })`
  - `deleteAnnouncement({ announcementId })`
  - `listAnnouncementsForGame({ gameId })`
- Enforce GM-only writes and the archived lock server-side.
- Enforce ready-state read secrecy server-side.
- Return oldest-first rows and capability flags for the client.
- Cover role/state authorization, trimming/length, stable ordering, update,
  deletion, and archived behavior with Convex tests.

## Step 2 — Notes integration

- Add `"announcement"` and `targetAnnouncementId` to the note schema,
  validators, target consistency checks, target indexes, wire types, and client
  target union.
- Validate that the target announcement belongs to the supplied game.
- Block Player access to announcement notes during `ready` in create, target
  list, count, and whole-game drawer queries.
- Add announcement counts to the shared note-count map.
- Resolve announcement excerpts for Notes drawer rows.
- Cascade announcement-target notes on announcement deletion.
- Cover note authorization, game scoping, ready-state secrecy, playing and
  archived access, drawer projection, counts, and deletion cascade.

## Step 3 — Game screen

- Add an `AnnouncementsSection` below Goals.
- Give each row a bulletin-like ordinal, body, and note icon.
- Add compact create/edit forms using the existing textarea and button
  vocabulary.
- Confirm before deletion and show mutation failures inline.
- Respect `hideManagementControls` and the archived capability flags.
- Update the GM Tools explanation to include announcement controls.
- Add focused pure UI tests where practical.

## Step 4 — Verification and review

- Run formatting, lint, typecheck/build, and the complete test suite.
- Smoke-test the relevant states in the shared browser preview when an
  authenticated local game is available.
- Request an independent code review. Resolve every high- or medium-severity
  finding and repeat review until none remain; report any low-severity findings
  before proceeding.

## Commit boundaries

1. Plan.
2. Announcement data, lifecycle, and backend tests.
3. Notes integration and tests.
4. UI integration and tests.
5. Verification fixes, if any.
