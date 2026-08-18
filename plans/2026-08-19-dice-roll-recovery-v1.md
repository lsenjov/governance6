# Dice Roll Recovery — v1

## Objective

Prevent a minion call at the head of the active queue from remaining without a
roll set. Preserve the existing append-only roll history and never reroll a
healthy, unchanged call.

## Assessment

Call writes and roll writes share a Convex mutation, so a missing roll is not a
normal loading state. The recoverable gap is an active head row with no matching
`callRollSets` row. In particular, `addOrReplaceCall` currently skips roll logic
when the caller resubmits the same minion, which means that retry cannot repair a
legacy or otherwise incomplete head.

The existing trigger sites are:

- `addOrReplaceCall`, when a minion call is inserted or replaced at the head;
- `removeCall`, when the next active call becomes the head, including the
  next-minion auto-promotion path.

The GM current-call query already exposes a missing roll as `rolls: null`, which
provides a narrow recovery signal without adding schema state.

## Implementation Plan

### Task 1: Make head roll creation idempotent and recoverable

- Add an `ensureHeadRollSet` helper in `convex/lib/rolls.ts` that:
  - verifies the call is the active minion head;
  - returns the latest existing roll-set id unless a fresh roll is explicitly
    required;
  - otherwise computes drawback extras and creates one roll set.
- Route `addOrReplaceCall` and `removeCall` through the helper.
  - Same-minion retries and newly promoted heads only fill a missing roll.
  - A genuine head minion replacement and a custom-to-minion replacement still
    force a fresh immutable roll set.
- Add a GM-authorized `repairHeadRollSet` mutation for the current game head.
  It is safe to retry and returns without writing for an empty/custom head or a
  healthy minion head.
- In the GM current-call UI, invoke the repair mutation once per call when the
  query reports `rolls: null`. Show an explicit unavailable state and surface a
  failed repair with a manual retry action instead of presenting an endless
  pending state.
- Add regression coverage for missing-roll repair, idempotent retry, auth,
  healthy-call no-reroll behavior, and the unavailable display.

## Verification

- `npm test -- convex/calls.test.ts src/components/RollSetDisplay.test.tsx`
- `npm run typecheck`
- `npm run lint`
- `npx prettier --check plans/2026-08-19-dice-roll-recovery-v1.md
convex/lib/rolls.ts convex/calls.ts src/components/RollSetDisplay.tsx
src/components/RollSetDisplay.test.tsx src/pages/GameDetailPage.tsx`
- `npm test`
- `npm run build`

## Non-goals

- Do not rewrite or delete historical roll sets.
- Do not backfill inactive calls or non-head queue entries.
- Do not add a scheduled repair job or schema migration.
