import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Call Queue helpers — see `plans/2026-04-28-private-and-custom-calls-v2.md`.
 *
 * `upsertActiveCall` centralises the "one active Call per Player; preserve
 * `_id` and `createdAt` on replace" invariant that Rule 22 codifies, plus
 * the kind/content drift defence introduced for custom calls. Both
 * `addOrReplaceCall` and `addOrReplaceCustomCall` funnel through this
 * helper so a row can never end up with both `minionId` and `label`
 * populated, or neither.
 *
 * Roll-set generation is intentionally NOT performed here. The trigger
 * sites in `convex/calls.ts` decide whether to fire `generateRollSetForCall`
 * based on the helper's `prevKind`/`changed` return and the post-upsert
 * head id. Custom calls never roll dice; minion calls follow the
 * dice-rolls v3 rule:
 *   - `prevKind === null` (fresh insert into empty queue) → `became_head`
 *   - `prevKind === "custom"` (cross-kind upgrade)        → `became_head`
 *   - `prevKind === "minion"` with different `minionId`   → `minion_replaced`
 * The rule-of-thumb: `minion_replaced` requires a prior minion roll set on
 * the *same* row; everything else is `became_head`.
 */

/**
 * Discriminated union of the kind-specific payload accepted by
 * `upsertActiveCall`. `label` MUST be already trimmed and validated by
 * the calling mutation; the helper does no further trimming and only
 * does direct string equality on the value.
 */
export type CallContent =
  | { kind: "minion"; minionId: Id<"minions"> }
  | { kind: "custom"; label: string };

/**
 * Result of an upsert. `prevKind` is `null` for a fresh insert, or the
 * (back-compat-projected) kind of the row that was patched. `changed`
 * is `false` for the idempotent same-content no-op branch.
 */
export type UpsertResult = {
  id: Id<"calls">;
  prevKind: "minion" | "custom" | null;
  changed: boolean;
};

/**
 * Insert a fresh active call OR patch the caller's existing active call
 * in place, preserving `_id` and `createdAt` so queue position is held.
 *
 * Idempotency: a same-kind same-payload resubmit is a zero-write no-op
 * (the caller observes unchanged `createdAt`).
 *
 * Cross-kind switches always rewrite the kind-discriminator AND clear
 * the unused payload field via an explicit `undefined` patch — this
 * guarantees a row is never simultaneously labelled "minion" and
 * carrying a `label`, or "custom" and carrying a `minionId`. The
 * `: undefined` idiom is the project-standard way to clear an optional
 * field on a Convex `patch` (see e.g. `convex/games.ts:105`).
 */
export async function upsertActiveCall(
  ctx: MutationCtx,
  args: {
    gameId: Id<"games">;
    player: Doc<"players">;
    content: CallContent;
  },
): Promise<UpsertResult> {
  const { gameId, player, content } = args;

  const existing = await ctx.db
    .query("calls")
    .withIndex("by_game_player_active", (q) =>
      q.eq("gameId", gameId).eq("playerId", player._id).eq("isActive", true),
    )
    .unique();

  if (existing) {
    // Project the legacy `kind === undefined` row as `"minion"`.
    const existingKind: "minion" | "custom" = existing.kind ?? "minion";

    // Idempotent same-content no-op: kind matches AND payload field
    // matches byte-for-byte.
    if (existingKind === content.kind) {
      if (content.kind === "minion" && existing.minionId === content.minionId) {
        return { id: existing._id, prevKind: existingKind, changed: false };
      }
      if (content.kind === "custom" && existing.label === content.label) {
        return { id: existing._id, prevKind: existingKind, changed: false };
      }
    }

    // Patch in place. Always set `kind` (this performs a one-time
    // idempotent kind-stamping on legacy rows whose `kind` was
    // undefined). Always clear the unused payload field with an
    // explicit `undefined`. `createdAt` is untouched, preserving
    // queue position.
    if (content.kind === "minion") {
      await ctx.db.patch(existing._id, {
        kind: "minion",
        minionId: content.minionId,
        label: undefined,
      });
    } else {
      await ctx.db.patch(existing._id, {
        kind: "custom",
        label: content.label,
        minionId: undefined,
      });
    }

    return { id: existing._id, prevKind: existingKind, changed: true };
  }

  // Fresh insert.
  const newId =
    content.kind === "minion"
      ? await ctx.db.insert("calls", {
          gameId,
          playerId: player._id,
          kind: "minion",
          minionId: content.minionId,
          createdAt: Date.now(),
          isActive: true,
        })
      : await ctx.db.insert("calls", {
          gameId,
          playerId: player._id,
          kind: "custom",
          label: content.label,
          createdAt: Date.now(),
          isActive: true,
        });

  return { id: newId, prevKind: null, changed: true };
}
