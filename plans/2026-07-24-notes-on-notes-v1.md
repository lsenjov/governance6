# Notes on Notes v1

## Goal

Allow any game participant to attach a note to another note they can see. Reply
notes keep the existing immutable body, private/public visibility, optional
GM-only timer, newest-first ordering, and GM-only deletion rules.

## Decisions

- Add `"note"` as a normal note target with a self-referential
  `targetNoteId`.
- A reply target must exist in the same game and be visible to its author.
- A reply is visible only when both the reply and every note in its parent chain
  are visible to the viewer. This prevents a public reply from exposing a
  private parent.
- Threads may nest to any depth. Cycles cannot be created through the API
  because a new row can only target an existing row; readers still reject
  malformed cyclic data defensively.
- Every rendered note card exposes a compact Reply control with its direct
  visible-reply count. It opens the existing notes popover for that note.
- Nested note popovers remain open as a stack while interacting with the
  deepest popover. Clicking outside closes the stack.
- Deleting a note with direct replies is rejected. The GM must delete replies
  leaf-first, which avoids dangling targets and unbounded recursive deletion in
  one Convex mutation.
- Deleting an entity that would cascade its direct notes is likewise rejected
  while any of those notes has replies.
- A system-maintained direct-reply counter keeps both deletion checks bounded.
  It is optional so pre-feature notes safely read as zero without a backfill.
- The Notes drawer describes reply targets with a short parent-note excerpt and
  author name.

## Step 1 — Data model and backend

- Extend the notes schema, indexes, validators, target consistency checks, and
  target projection with `targetNoteId`.
- Enforce same-game target existence and full parent-chain visibility for
  create, target listing, whole-game listing, and counts.
- Expose direct visible-reply counts through the shared game count query and
  drawer rows while keeping each target-list query on its target index.
- Reject deletion while direct replies exist.
- Cover creation, cross-game rejection, privacy-chain behavior, nesting,
  counts, drawer projection, and deletion safety with Convex tests.

## Step 2 — Client integration

- Extend `NoteTarget`, query argument construction, create arguments, and count
  resolution for note targets.
- Add Reply controls to shared note cards and Notes drawer rows.
- Preserve ancestor popovers while a nested reply popover is active.
- Add focused component/helper tests and matching styles.

## Step 3 — Verification and review

- Run formatting, lint, typecheck/build, and the full test suite.
- Smoke-test nested reply creation in the shared preview when a usable local
  authenticated game is available.
- Request an independent review. Resolve every high- or medium-severity finding
  and repeat until none remain. Report low-severity findings before proceeding.

## Commit boundaries

1. Plan.
2. Data model, backend behavior, and backend tests.
3. Client integration and client tests.
4. Verification or review fixes, if needed.
