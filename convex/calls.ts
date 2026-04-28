import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import {
  requireGame,
  requireGameGm,
  requireGamePlayer,
  requireUserId,
} from "./lib/auth";
import {
  generateRollSetForCall,
  getDrawbackExtrasForCall,
  getHeadCallId,
  getLatestRollSetForCall,
  projectRollSet,
  type RollSetView,
} from "./lib/rolls";
import { upsertActiveCall } from "./lib/calls";
import type { Doc, Id } from "./_generated/dataModel";

/**
 * Call Queue — Rule 22.
 *
 * FIFO by `createdAt` ascending. At most one active Call per Player.
 * Adding a new Call while one exists REPLACES the existing Call's content
 * in place via `upsertActiveCall`, preserving `createdAt` and document id
 * (queue position preserved). Same-content resubmits are no-ops.
 *
 * Two call kinds:
 *   - `"minion"` — bought-Minion calls. Generate dice rolls per the
 *     dice-rolls v3 plan whenever the call is at the FIFO head.
 *   - `"custom"` — free-form text label calls. The "Private Call"
 *     button in `YouStrip` is purely a client-side shortcut for a
 *     custom call whose `label === "Private Call"`; the server has no
 *     concept of "private" — every active call remains visible to
 *     every game participant. Custom calls do NOT generate roll sets;
 *     the natural-1 / dice-rolls invariants from v3 only apply to
 *     minion calls.
 *
 * Removed Calls are soft-deleted (`isActive=false`, `removedAt` set);
 * the last 10 are visible in a history panel.
 */

export const addOrReplaceCall = mutation({
  args: { gameId: v.id("games"), minionId: v.id("minions") },
  handler: async (ctx, args) => {
    const { game, player } = await requireGamePlayer(ctx, args.gameId);
    if (game.state !== "playing") {
      throw new Error("Calls can only be added while the game is playing.");
    }

    // Rule 22: Minion must be bought in this (game, player).
    const gpm = await ctx.db
      .query("gamePlayerMinions")
      .withIndex("by_game_player_minion", (q) =>
        q
          .eq("gameId", args.gameId)
          .eq("playerId", player._id)
          .eq("minionId", args.minionId),
      )
      .unique();
    if (!gpm || !gpm.bought) {
      throw new Error("You must buy this Minion before calling it.");
    }

    const result = await upsertActiveCall(ctx, {
      gameId: args.gameId,
      player,
      content: { kind: "minion", minionId: args.minionId },
    });

    // Roll-set generation per the dice-rolls v3 rule:
    //   `minion_replaced` requires a prior minion roll set on the same row;
    //   everything else is `became_head`.
    if (result.changed) {
      const headId = await getHeadCallId(ctx, args.gameId);
      if (headId === result.id) {
        // The upserted call is the head. Pick the reason:
        //   - prevKind === "minion" → in-place minion-to-minion swap on
        //     the head; the helper only returns `changed: true` here when
        //     the minionId actually differs (same-minion is a no-op),
        //     so this is always a genuine replace → "minion_replaced".
        //   - prevKind === "custom" → cross-kind upgrade; the row had no
        //     prior minion roll set to "replace" → "became_head".
        //   - prevKind === null → fresh insert into an empty queue (or
        //     into a position that became the head between insert and
        //     re-read; treat the same way) → "became_head".
        const reason: "became_head" | "minion_replaced" =
          result.prevKind === "minion" ? "minion_replaced" : "became_head";
        // Drawback extras: re-read the head call AFTER the queue
        // mutation so any concurrent toggle of `isRolled` is reflected
        // in the new roll set (drawback rolls v1).
        const headCall = await ctx.db.get(result.id);
        const extras = headCall
          ? await getDrawbackExtrasForCall(ctx, headCall)
          : [];
        await generateRollSetForCall(ctx, {
          callId: result.id,
          reason,
          extras,
        });
      }
    }

    return result.id;
  },
});

/**
 * Player-only mutation: enqueue (or replace in place) a custom call with a
 * free-form text label. The Private Call button is a client-side shortcut
 * that simply calls this mutation with `label = "Private Call"`.
 *
 * Validation:
 *   - `label` is trimmed; must be non-empty after trim.
 *   - `label.length` must be ≤ 80 after trim.
 *
 * Custom calls do not generate dice roll sets. If this upsert turned a
 * previous minion head into a custom head, the previous minion call's
 * existing roll set remains in `callRollSets` (the table is append-only)
 * but is no longer surfaced because the row's `kind` is now `"custom"`.
 */
export const addOrReplaceCustomCall = mutation({
  args: { gameId: v.id("games"), label: v.string() },
  handler: async (ctx, args) => {
    const { game, player } = await requireGamePlayer(ctx, args.gameId);
    if (game.state !== "playing") {
      throw new Error("Calls can only be added while the game is playing.");
    }

    // Trim once at the mutation boundary; the helper trusts the value.
    const trimmedLabel = args.label.trim();
    if (trimmedLabel.length === 0) {
      throw new Error("Custom call label cannot be empty.");
    }
    if (trimmedLabel.length > 80) {
      throw new Error(
        "Custom call label must be at most 80 characters.",
      );
    }

    const result = await upsertActiveCall(ctx, {
      gameId: args.gameId,
      player,
      content: { kind: "custom", label: trimmedLabel },
    });

    // Custom calls never roll dice — no `generateRollSetForCall` here.
    return result.id;
  },
});

/**
 * Rule 22: GM may remove any Call. Soft-deletes: sets `isActive=false`,
 * `removedAt=Date.now()`, `removedByGmId=gmId`.
 *
 * Dice rolls: if the removed call WAS the head, the next-oldest active
 * call inherits the head slot. A fresh roll set is generated ONLY when
 * the new head is `kind === "minion"` (custom heads do not roll). Removing
 * a mid-queue call leaves the head unchanged and fires no rolls.
 */
export const removeCall = mutation({
  args: { callId: v.id("calls") },
  handler: async (ctx, args) => {
    const call = await ctx.db.get(args.callId);
    if (!call) throw new Error("Call not found.");
    const game = await requireGameGm(ctx, call.gameId);
    if (!call.isActive) {
      // Idempotent.
      return;
    }

    // Snapshot the head BEFORE the patch so we can detect whether the
    // removed call was the head. If it wasn't, no rolls need to fire
    // (the head is still the same call, which already has a roll set).
    const headBefore = await getHeadCallId(ctx, call.gameId);
    const removedWasHead = headBefore === call._id;

    await ctx.db.patch(args.callId, {
      isActive: false,
      removedAt: Date.now(),
      removedByGmId: game.gmId,
    });

    if (removedWasHead) {
      const newHeadId = await getHeadCallId(ctx, call.gameId);
      if (newHeadId !== null) {
        // Gate roll generation on the new head's kind. Custom heads do
        // not roll. Reason is unconditionally `became_head` here — a
        // fresh roll on a *different* row is always `became_head`;
        // `minion_replaced` is reserved for in-place edits to the
        // *same* row (handled in `addOrReplaceCall`).
        const newHead = await ctx.db.get(newHeadId);
        const newHeadKind: "minion" | "custom" = newHead?.kind ?? "minion";
        if (newHeadKind === "minion") {
          // Drawback extras for the newly-promoted head (drawback
          // rolls v1).
          const extras = newHead
            ? await getDrawbackExtrasForCall(ctx, newHead)
            : [];
          await generateRollSetForCall(ctx, {
            callId: newHeadId,
            reason: "became_head",
            extras,
          });
        }
      }
    }
  },
});

/**
 * Active Calls (FIFO by `createdAt` ascending). Any game viewer.
 *
 * Returns a discriminated union per row keyed off `kind`:
 *   - `kind: "minion"` rows (including legacy `kind === undefined`
 *     projected forward) carry `minionId` + `minionName`.
 *   - `kind: "custom"` rows carry `label`. They never carry `minionId`
 *     or `minionName`.
 *
 * Dice rolls: GM viewers receive a `rolls: RollSetView | null` field on
 * each minion-kind entry; non-GM viewers receive the existing shape
 * unchanged. The field is OMITTED ENTIRELY (not set to `null`) for
 * non-GMs and for ALL custom rows (no roll set ever exists for a custom
 * call) so the wire format never lies about the presence of rolls.
 */

/**
 * Public TypeScript types for the active-queue payload. Clients can
 * `switch (row.kind)` exhaustively. `rolls` only appears on the GM
 * minion-row variant.
 */
export type ActiveCallSharedFields = {
  _id: Id<"calls">;
  playerId: Id<"players">;
  createdAt: number;
  playerName: string;
};

export type ActiveCallRow =
  | (ActiveCallSharedFields & {
      kind: "minion";
      minionId: Id<"minions">;
      minionName: string;
      rolls?: RollSetView | null;
    })
  | (ActiveCallSharedFields & {
      kind: "custom";
      label: string;
    });

export const activeCalls = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args): Promise<ActiveCallRow[]> => {
    const userId = await requireUserId(ctx);
    const game = await requireGame(ctx, args.gameId);
    const isGm = game.gmId === userId;
    if (!isGm) {
      // Ensure participant.
      const meRow = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) =>
          q.eq("gameId", args.gameId).eq("userId", userId),
        )
        .unique();
      if (!meRow) throw new Error("You are not a participant in this game.");
    }

    const rows = await ctx.db
      .query("calls")
      .withIndex("by_game_active_time", (q) =>
        q.eq("gameId", args.gameId).eq("isActive", true),
      )
      .order("asc")
      .collect();

    // For GMs, bulk-load roll sets in a single per-game query and
    // index them by callId so we don't fan out N point reads.
    let rollsByCallId: Map<Id<"calls">, Doc<"callRollSets">> | null = null;
    if (isGm) {
      rollsByCallId = new Map();
      const allRolls = await ctx.db
        .query("callRollSets")
        .withIndex("by_game_call", (q) => q.eq("gameId", args.gameId))
        .collect();
      // Newest-first per call: iterate and only keep the latest by
      // `createdAt` for each callId.
      for (const r of allRolls) {
        const existing = rollsByCallId.get(r.callId);
        if (!existing || existing.createdAt < r.createdAt) {
          rollsByCallId.set(r.callId, r);
        }
      }
    }

    return await Promise.all(
      rows.map(async (c): Promise<ActiveCallRow> => {
        const player = await ctx.db.get(c.playerId);
        const user = player ? await ctx.db.get(player.userId) : null;
        const playerName = user?.displayName ?? user?.email ?? "Unknown";
        const shared: ActiveCallSharedFields = {
          _id: c._id,
          playerId: c.playerId,
          createdAt: c.createdAt,
          playerName,
        };

        // Project legacy `kind === undefined` rows as minion. Defence
        // in depth: the discriminator wins; we never read `label` on
        // a `kind: "minion"` projection or `minionId` on a `kind: "custom"` projection.
        const kind: "minion" | "custom" = c.kind ?? "minion";

        if (kind === "custom") {
          // Custom rows: no minion lookup, no `rolls` key (GM or not).
          return {
            ...shared,
            kind: "custom",
            label: c.label ?? "",
          };
        }

        // Minion branch: load the minion. `c.minionId` should be set
        // for any `kind === "minion"` row (the schema permits it as
        // optional only because custom rows omit it); a legacy row
        // with no `kind` and no `minionId` would be malformed and is
        // not believed to exist in production data, but we still
        // tolerate it gracefully via `minionName: "Unknown Minion"`.
        const minion = c.minionId ? await ctx.db.get(c.minionId) : null;
        const minionRow: ActiveCallRow = {
          ...shared,
          kind: "minion",
          // Non-null assertion is safe at the type boundary because
          // we only enter this branch when `kind === "minion"`; in
          // the malformed legacy case we still hand back the row's
          // (possibly absent) minionId rather than fabricate one.
          minionId: c.minionId as Id<"minions">,
          minionName: minion?.name ?? "Unknown Minion",
        };

        if (isGm && rollsByCallId) {
          const row = rollsByCallId.get(c._id) ?? null;
          // GM payload for minion rows: include `rolls` (possibly null
          // while the helper is mid-flight in a race; the UI handles
          // null).
          return {
            ...minionRow,
            rolls: row ? projectRollSet(row) : null,
          };
        }
        // Player payload: no `rolls` key at all. Tests assert via
        // hasOwnProperty that the key is genuinely absent.
        return minionRow;
      }),
    );
  },
});

/**
 * GM-only deep-dive on the head of the FIFO call queue.
 *
 * Returns a discriminated union:
 *   - `null` when the queue is empty (or, for minion heads, when the
 *     called minion or its syndicate has been removed — defensive nulls
 *     match today's behaviour).
 *   - `{ kind: "custom", call, label }` when the head call is custom.
 *     Skips every minion / syndicate / drawback / roll-set fetch.
 *   - `{ kind: "minion", call, minion, syndicate, rolls }` when the
 *     head call is minion-kind. Joins the called minion (with
 *     skills/accent/description), the minion's owning syndicate, that
 *     syndicate's drawbacks (sorted by `order` ascending, matching
 *     `drawbacks.listForSyndicate`), and the latest roll set for that
 *     head call.
 */
export type CurrentCallDetails =
  | {
      kind: "minion";
      call: {
        _id: Id<"calls">;
        createdAt: number;
        playerId: Id<"players">;
        playerName: string;
      };
      minion: {
        _id: Id<"minions">;
        name: string;
        accent: string | null;
        description: string | null;
        skills: string[];
      };
      syndicate: {
        _id: Id<"syndicates">;
        name: string;
        leader: string;
        drawbacks: { _id: Id<"drawbacks">; name: string; description: string }[];
      };
      rolls: RollSetView | null;
    }
  | {
      kind: "custom";
      call: {
        _id: Id<"calls">;
        createdAt: number;
        playerId: Id<"players">;
        playerName: string;
      };
      label: string;
    };

export const getCurrentCallDetails = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args): Promise<CurrentCallDetails | null> => {
    // GM-only — Rule 24, enforced server-side regardless of UI.
    await requireGameGm(ctx, args.gameId);

    // FIFO head: oldest active call, mirroring `activeCalls`'s ordering.
    const head = await ctx.db
      .query("calls")
      .withIndex("by_game_active_time", (q) =>
        q.eq("gameId", args.gameId).eq("isActive", true),
      )
      .order("asc")
      .take(1);
    if (head.length === 0) return null;
    const call = head[0];

    const player = await ctx.db.get(call.playerId);
    const user = player ? await ctx.db.get(player.userId) : null;
    const playerName = user?.displayName ?? user?.email ?? "Unknown";

    const callShared = {
      _id: call._id,
      createdAt: call.createdAt,
      playerId: call.playerId,
      playerName,
    };

    // Project legacy `kind === undefined` as `"minion"`.
    const kind: "minion" | "custom" = call.kind ?? "minion";

    if (kind === "custom") {
      return {
        kind: "custom",
        call: callShared,
        label: call.label ?? "",
      };
    }

    // Minion branch: defensive nulls match today's contract.
    if (!call.minionId) return null;
    const minion = await ctx.db.get(call.minionId);
    if (!minion) return null;

    const syndicate = await ctx.db.get(minion.syndicateId);
    if (!syndicate) return null;

    const drawbackRows = await ctx.db
      .query("drawbacks")
      .withIndex("by_syndicate", (q) => q.eq("syndicateId", syndicate._id))
      .collect();
    drawbackRows.sort((a, b) => a.order - b.order);

    const rollRow = await getLatestRollSetForCall(ctx, call._id);
    const rolls: RollSetView | null = rollRow ? projectRollSet(rollRow) : null;

    return {
      kind: "minion",
      call: callShared,
      minion: {
        _id: minion._id,
        name: minion.name,
        accent: minion.accent ?? null,
        description: minion.description ?? null,
        skills: minion.skills,
      },
      syndicate: {
        _id: syndicate._id,
        name: syndicate.name,
        leader: syndicate.leader,
        drawbacks: drawbackRows.map((d) => ({
          _id: d._id,
          name: d.name,
          description: d.description,
        })),
      },
      rolls,
    };
  },
});

/**
 * Recently removed Calls — up to 10, ordered by `removedAt` descending.
 *
 * Returns a discriminated union per row keyed off `kind`, matching the
 * `activeCalls` projection: minion rows carry `minionId` + `minionName`,
 * custom rows carry `label`. The discriminator-irrelevant field is
 * genuinely absent from the wire payload (asserted via
 * `Object.prototype.hasOwnProperty.call` in tests).
 */
export type RemovedCallSharedFields = {
  _id: Id<"calls">;
  playerId: Id<"players">;
  createdAt: number;
  removedAt: number;
  playerName: string;
};

export type RemovedCallRow =
  | (RemovedCallSharedFields & {
      kind: "minion";
      minionId: Id<"minions">;
      minionName: string;
    })
  | (RemovedCallSharedFields & {
      kind: "custom";
      label: string;
    });

export const recentlyRemovedCalls = query({
  args: { gameId: v.id("games") },
  handler: async (ctx, args): Promise<RemovedCallRow[]> => {
    const userId = await requireUserId(ctx);
    const game = await requireGame(ctx, args.gameId);
    const isGm = game.gmId === userId;
    if (!isGm) {
      const meRow = await ctx.db
        .query("players")
        .withIndex("by_game_user", (q) =>
          q.eq("gameId", args.gameId).eq("userId", userId),
        )
        .unique();
      if (!meRow) throw new Error("You are not a participant in this game.");
    }
    const rows = await ctx.db
      .query("calls")
      .withIndex("by_game_removed_time", (q) => q.eq("gameId", args.gameId))
      .order("desc")
      .take(20); // over-fetch because some rows have removedAt=undefined
    const removed = rows.filter((r) => !r.isActive && r.removedAt).slice(0, 10);
    return await Promise.all(
      removed.map(async (c): Promise<RemovedCallRow> => {
        const player = await ctx.db.get(c.playerId);
        const user = player ? await ctx.db.get(player.userId) : null;
        const playerName = user?.displayName ?? user?.email ?? "Unknown";
        const shared: RemovedCallSharedFields = {
          _id: c._id,
          playerId: c.playerId,
          createdAt: c.createdAt,
          removedAt: c.removedAt!,
          playerName,
        };

        const kind: "minion" | "custom" = c.kind ?? "minion";
        if (kind === "custom") {
          return {
            ...shared,
            kind: "custom",
            label: c.label ?? "",
          };
        }

        const minion = c.minionId ? await ctx.db.get(c.minionId) : null;
        return {
          ...shared,
          kind: "minion",
          minionId: c.minionId as Id<"minions">,
          minionName: minion?.name ?? "Unknown Minion",
        };
      }),
    );
  },
});
