import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

/**
 * Dice roll generation — see `plans/2026-04-28-2026-04-28-dice-rolls-v3.md`.
 *
 * Every "becoming-the-head" event on the FIFO call queue must produce a
 * single immutable `callRollSets` row that bundles a skill roll + chaos
 * roll (and any future conditional `extras`). The same helper handles
 * both trigger paths in `convex/calls.ts` (empty-queue insert,
 * replace-in-place on the head, and head removal advancing the next
 * call) so the natural-1 rule and extras validation live in one place.
 *
 * This module is mutation-only — it relies on `Math.random()`, which
 * Convex queries cannot use deterministically.
 */

/** Inclusive d6: 1..6. */
function rollD6(): number {
  return 1 + Math.floor(Math.random() * 6);
}

/**
 * Universal natural-1 rule for the skill die.
 *
 * Skill failure is `roll === 1 OR roll <= skillCount`. The `=== 1`
 * branch is currently redundant because Minions are required to carry
 * 1–5 skills (see `convex/schema.ts` minions comment), so `skillCount`
 * is always ≥ 1 and `roll === 1` already implies `roll <= skillCount`.
 * The branch is included unconditionally so the rule is self-documenting
 * and survives any future relaxation of the minion-skill invariant.
 */
export function deriveSkillResult(
  skillRoll: number,
  skillCount: number,
): "success" | "failure" {
  return skillRoll === 1 || skillRoll <= skillCount ? "failure" : "success";
}

/**
 * Universal natural-1 rule for the chaos die. Chaos is intentionally
 * unscored except for the natural-1 case; promoting `chaosResult` to
 * a required field would force every chaos cell to carry a pass/fail
 * marker, which is more than the user asked for.
 */
export function deriveChaosResult(
  chaosRoll: number,
): "failure" | undefined {
  return chaosRoll === 1 ? "failure" : undefined;
}

export type ExtraRollInput = {
  kind: string;
  name: string;
  value: number;
  result?: "success" | "failure";
};

export type ExtraRoll = {
  kind: string;
  name: string;
  value: number;
  result?: "success" | "failure";
};

const EXTRA_NAME_MAX = 24;

/**
 * Validate and normalise a single extras item.
 *
 *  - `kind` and `name` are trimmed; both must be non-empty.
 *  - `name` must be ≤ 24 chars after trim — every die has to fit a
 *    brutalist square cell caption without truncation.
 *  - `value` must be an integer in [1, 6].
 *  - **Natural-1 coercion:** if `value === 1`, the persisted `result`
 *    is forced to `"failure"` regardless of what the caller passed.
 *    This guarantees the universal "any 1 is a failure" rule cannot
 *    be bypassed by a future caller.
 */
export function normaliseExtraRoll(input: ExtraRollInput): ExtraRoll {
  const kind = input.kind.trim();
  const name = input.name.trim();
  if (kind.length === 0) {
    throw new Error("Extra roll `kind` must be a non-empty string.");
  }
  if (name.length === 0) {
    throw new Error("Extra roll `name` must be a non-empty string.");
  }
  if (name.length > EXTRA_NAME_MAX) {
    throw new Error(
      `Extra roll \`name\` must be at most ${EXTRA_NAME_MAX} characters.`,
    );
  }
  if (!Number.isInteger(input.value) || input.value < 1 || input.value > 6) {
    throw new Error("Extra roll `value` must be an integer in [1, 6].");
  }

  // Natural-1 rule: any die showing 1 is a failure. Override even
  // when the caller passed an explicit `"success"`.
  const result =
    input.value === 1 ? ("failure" as const) : input.result ?? undefined;

  const out: ExtraRoll = { kind, name, value: input.value };
  if (result !== undefined) out.result = result;
  return out;
}

/**
 * Returns the FIFO head of the active call queue for a game (or `null`).
 * Mirrors the ordering used by `api.calls.activeCalls` and
 * `api.calls.getCurrentCallDetails` so trigger sites can ask "is this
 * call the head?" without re-implementing the index call.
 */
export async function getHeadCallId(
  ctx: MutationCtx,
  gameId: Id<"games">,
): Promise<Id<"calls"> | null> {
  const head = await ctx.db
    .query("calls")
    .withIndex("by_game_active_time", (q) =>
      q.eq("gameId", gameId).eq("isActive", true),
    )
    .order("asc")
    .take(1);
  return head.length === 0 ? null : head[0]._id;
}

/**
 * Brutalist square-cell budget for drawback-die captions. Six chars
 * fits between Skill and Chaos at the right-rail size without
 * wrapping. The dice-roll helper's own `EXTRA_NAME_MAX = 24` is a
 * defensive upper bound shared by all extras kinds; drawbacks are
 * intentionally stricter.
 */
const DRAWBACK_CAPTION_MAX = 6;

/**
 * Compute the drawback-die extras for a given Call.
 *
 * Returns one `ExtraRollInput` per `isRolled === true` drawback on the
 * called Minion's syndicate, in `order` ascending (so dice appear in
 * the same order the Syndicate editor and the GM Current Call section
 * show them).
 *
 *  - Returns `[]` for custom calls (no `minionId`), for calls whose
 *    `minionId` resolves to a deleted minion, and for syndicates with
 *    no rolled drawbacks.
 *  - Caption is `(abbreviation ?? "").trim() || drawback.name`,
 *    truncated to 6 chars after trim. The truncate happens BEFORE the
 *    helper's validator sees the string so a 120-char drawback name
 *    cannot trip the validator's length check.
 *  - `value` is rolled here (not inside `generateRollSetForCall`) so
 *    the helper's input shape stays generic and all drawback-aware
 *    logic lives in one place. `result` is omitted; the helper's
 *    natural-1 coercion sets it to `"failure"` when `value === 1`.
 */
export async function getDrawbackExtrasForCall(
  ctx: MutationCtx,
  call: Doc<"calls">,
): Promise<ExtraRollInput[]> {
  // Defence in depth — trigger sites already gate on minion-kind, but
  // this helper's contract should be safe to invoke for any call.
  if (call.kind === "custom" || !call.minionId) {
    return [];
  }
  const minion = await ctx.db.get(call.minionId);
  if (!minion) return [];

  const drawbacks = await ctx.db
    .query("drawbacks")
    .withIndex("by_syndicate", (q) => q.eq("syndicateId", minion.syndicateId))
    .collect();
  drawbacks.sort((a, b) => a.order - b.order);

  const extras: ExtraRollInput[] = [];
  for (const d of drawbacks) {
    if (d.isRolled !== true) continue;
    const abbrev = (d.abbreviation ?? "").trim();
    const rawCaption = abbrev.length > 0 ? abbrev : d.name;
    const caption = rawCaption.trim().slice(0, DRAWBACK_CAPTION_MAX);
    // The validator at `normaliseExtraRoll` rejects empty captions —
    // skip silently if both abbreviation and name are blank after
    // trim/truncate (an impossible state given `DRAWBACK_NAME_MAX`,
    // but defended here).
    if (caption.length === 0) continue;
    extras.push({
      kind: "drawback",
      name: caption,
      value: rollD6(),
      // `result` intentionally omitted — `normaliseExtraRoll` will
      // coerce to `"failure"` whenever `value === 1`.
    });
  }
  return extras;
}

/**
 * Generate a fresh `callRollSets` row for the given call.
 *
 * Callers MUST only invoke this when the call is at the head of the
 * queue. Trigger sites (`addOrReplaceCall`, `removeCall`) handle the
 * head-detection guard themselves so this helper stays focused on the
 * roll math.
 *
 *  - Loads the call and minion. If the call is inactive or the minion
 *    has been deleted (a deletion race), returns `null` without
 *    inserting; the queue is in a broken state and the caller has
 *    already done what it can.
 *  - Rolls two d6 (skill + chaos), derives both results via the
 *    natural-1-aware rules above.
 *  - Validates and normalises any caller-supplied `extras`, applying
 *    natural-1 coercion to each.
 *  - Inserts the row and returns its id.
 */
export async function generateRollSetForCall(
  ctx: MutationCtx,
  args: {
    callId: Id<"calls">;
    reason: "became_head" | "minion_replaced";
    extras?: ExtraRollInput[];
  },
): Promise<Id<"callRollSets"> | null> {
  const call = await ctx.db.get(args.callId);
  if (!call) {
    console.warn(
      `generateRollSetForCall: call ${args.callId} not found; skipping.`,
    );
    return null;
  }
  if (!call.isActive) {
    // Defensive: rolling for an inactive call would attach rolls to
    // a queue position that is already gone. Trigger sites must call
    // this helper before soft-deleting any call.
    console.warn(
      `generateRollSetForCall: call ${args.callId} is inactive; skipping.`,
    );
    return null;
  }

  // Defensive: custom calls (kind === "custom") have no minionId and
  // do not roll dice. Trigger sites in `convex/calls.ts` already gate
  // on kind, but we double-check here so a future caller that forgets
  // the gate fails closed (no row written) rather than crashing on
  // `ctx.db.get(undefined)`.
  if (!call.minionId) {
    console.warn(
      `generateRollSetForCall: call ${args.callId} has no minionId (custom call?); skipping.`,
    );
    return null;
  }

  const minion = await ctx.db.get(call.minionId);
  if (!minion) {
    console.warn(
      `generateRollSetForCall: minion ${call.minionId} for call ${args.callId} not found; skipping.`,
    );
    return null;
  }

  const skillRoll = rollD6();
  const chaosRoll = rollD6();
  const skillCount = minion.skills.length;
  const skillResult = deriveSkillResult(skillRoll, skillCount);
  const chaosResult = deriveChaosResult(chaosRoll);

  const normalisedExtras: ExtraRoll[] = (args.extras ?? []).map(
    normaliseExtraRoll,
  );

  return await ctx.db.insert("callRollSets", {
    gameId: call.gameId,
    callId: call._id,
    minionId: minion._id,
    skillRoll,
    skillCount,
    skillResult,
    chaosRoll,
    chaosResult,
    extras: normalisedExtras,
    createdAt: Date.now(),
    createdReason: args.reason,
  });
}

/**
 * Fetch the most recent roll set for a call (newest first by
 * `createdAt`), or `null` if none exists. Used by query handlers and
 * by `createNote` to freeze the live roll set onto a new note.
 */
export async function getLatestRollSetForCall(
  ctx: QueryCtx | MutationCtx,
  callId: Id<"calls">,
): Promise<Doc<"callRollSets"> | null> {
  const rows = await ctx.db
    .query("callRollSets")
    .withIndex("by_call_created", (q) => q.eq("callId", callId))
    .order("desc")
    .take(1);
  return rows.length === 0 ? null : rows[0];
}

/**
 * Project a `callRollSets` row to the GM-only wire-format shape that
 * UI components consume. Centralised so every query that exposes
 * rolls (current call, active calls, notes) ships an identical shape.
 */
export type RollSetView = {
  skillRoll: number;
  skillCount: number;
  skillResult: "success" | "failure";
  chaosRoll: number;
  chaosResult: "success" | "failure" | null;
  extras: ExtraRoll[];
};

export function projectRollSet(row: Doc<"callRollSets">): RollSetView {
  return {
    skillRoll: row.skillRoll,
    skillCount: row.skillCount,
    skillResult: row.skillResult,
    chaosRoll: row.chaosRoll,
    chaosResult: row.chaosResult ?? null,
    extras: row.extras.map((e) => ({
      kind: e.kind,
      name: e.name,
      value: e.value,
      ...(e.result !== undefined ? { result: e.result } : {}),
    })),
  };
}
