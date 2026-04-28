import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

/**
 * Governance schema.
 *
 * Rule numbers below reference the authoritative rules in
 * `plans/2026-04-20-init-v4.md`.
 */
export default defineSchema({
  // Convex Auth built-in tables (users, authAccounts, authSessions, ...).
  // We augment `users` with a `displayName` field.
  ...authTables,
  users: defineTable({
    // From Convex Auth base fields:
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    // App-specific:
    displayName: v.optional(v.string()), // Rule 1
    // Site admin flag. Manageable only directly via the Convex database
    // (no in-app UI grants this). A site admin can manage the preset
    // skill list used when authoring Minions.
    isSiteAdmin: v.optional(v.boolean()),
  }).index("email", ["email"]),

  // Preset skill catalogue. Used by the Minion editor's autocomplete.
  // Writeable only by site admins; readable by any authenticated user.
  // Users may still enter free-form skills that are not in this list.
  presetSkills: defineTable({
    name: v.string(),
    createdByUserId: v.id("users"),
    createdAt: v.number(),
  }).index("by_name", ["name"]),

  // Preset drawback catalogue. Used by the Syndicate editor's drawback
  // autocomplete. Writeable only by site admins; readable by any
  // authenticated user.
  //
  // Picking a preset in the Syndicate editor copies all four fields
  // (name, description, abbreviation, isRolled) onto the per-Syndicate
  // `drawbacks` row at insert time — there is NO foreign key from
  // `drawbacks` to `presetDrawbacks`. This keeps Played syndicates
  // immutable even if an admin later edits the catalogue, and allows
  // free-form drawback names that are not in the catalogue.
  presetDrawbacks: defineTable({
    name: v.string(),
    description: v.string(),
    abbreviation: v.optional(v.string()),
    isRolled: v.optional(v.boolean()),
    createdByUserId: v.id("users"),
    createdAt: v.number(),
  }).index("by_name", ["name"]),

  // Rule 2: Syndicate.
  syndicates: defineTable({
    name: v.string(),
    leader: v.string(),
    description: v.string(),
    played: v.boolean(), // Rule 7
    isShared: v.boolean(), // Rule 6
    ownerId: v.id("users"),
  })
    .index("by_owner", ["ownerId"])
    .index("by_shared", ["isShared"]),

  // Rule 3: Drawbacks (0-5 per Syndicate).
  //
  // `abbreviation` and `isRolled` are admin-managed via the
  // `presetDrawbacks` catalogue. They are populated only by the
  // editor's preset-prefill pipeline at row-creation time (or directly
  // via the Convex dashboard); the Syndicate editor does NOT expose
  // them for direct editing.
  //
  // Toggling `isRolled` only affects future roll sets — existing
  // `callRollSets` rows are immutable (append-only), so the boolean
  // cannot retroactively rewrite history. See dice-rolls v3 plan
  // (`plans/2026-04-28-2026-04-28-dice-rolls-v3.md` Key finding 3).
  drawbacks: defineTable({
    syndicateId: v.id("syndicates"),
    name: v.string(),
    description: v.string(),
    order: v.number(),
    // Short caption (≤6 chars after trim) used as the die-cell label
    // when this drawback rolls. Optional so legacy rows remain valid.
    abbreviation: v.optional(v.string()),
    // When `true`, this drawback contributes a d6 to every
    // becoming-the-head roll set for any minion in this syndicate.
    // `undefined` projects to `false` for downstream consumers.
    isRolled: v.optional(v.boolean()),
  }).index("by_syndicate", ["syndicateId"]),

  // Rule 4: Minions (<=8 per Syndicate, 1-5 skills). In addition, the
  // union of skills across all Minions within a Syndicate is capped at
  // 13 distinct skill names (case-insensitive).
  minions: defineTable({
    syndicateId: v.id("syndicates"),
    name: v.string(),
    accent: v.optional(v.string()),
    description: v.optional(v.string()),
    skills: v.array(v.string()),
    order: v.number(),
  }).index("by_syndicate", ["syndicateId"]),

  // Rule 10: Game.
  games: defineTable({
    name: v.optional(v.string()),
    gmId: v.id("users"),
    state: v.union(
      v.literal("ready"),
      v.literal("playing"),
      v.literal("archived"),
    ),
    startedAt: v.optional(v.number()),
    archivedAt: v.optional(v.number()),
  })
    .index("by_gm", ["gmId"])
    .index("by_state", ["state"]),

  // Rules 11, 12: Player (roster row).
  players: defineTable({
    gameId: v.id("games"),
    userId: v.id("users"),
    selectedSyndicateId: v.optional(v.id("syndicates")),
    power: v.number(), // materialised cache, Rule 25
    joinedAt: v.number(),
  })
    .index("by_game", ["gameId"])
    .index("by_game_user", ["gameId", "userId"])
    .index("by_user", ["userId"])
    .index("by_selected_syndicate", ["selectedSyndicateId"]),

  // Rules 18, 19 + Rule 26 (Treason Grants) + Rule 27 (Public Bids):
  // append-only ledger.
  // The `treason_grant` source is added by the Treason Grants feature
  // (`plans/2026-04-27-treason-grants-v1.md`) to keep grant payouts
  // distinguishable from arbitrary GM bank actions.
  // The `bid` source is added by the Public Bids feature
  // (`plans/2026-04-27-public-bids-v1.md`) to keep public-bid
  // settlements distinguishable from arbitrary GM bank actions.
  powerLedgerEntries: defineTable({
    gameId: v.id("games"),
    playerId: v.id("players"),
    delta: v.number(),
    reason: v.optional(v.string()),
    source: v.union(
      v.literal("transfer_in"),
      v.literal("transfer_out"),
      v.literal("bank_in"),
      v.literal("bank_out"),
      v.literal("minion_buy"),
      v.literal("treason_grant"),
      v.literal("bid"),
    ),
    counterpartyPlayerId: v.optional(v.id("players")),
    createdByUserId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_game_time", ["gameId", "createdAt"])
    .index("by_game_player_time", ["gameId", "playerId", "createdAt"]),

  // Rule 21: per-game Minion buy state.
  gamePlayerMinions: defineTable({
    gameId: v.id("games"),
    playerId: v.id("players"),
    minionId: v.id("minions"),
    bought: v.boolean(),
    boughtAt: v.optional(v.number()),
    pricePaid: v.optional(v.number()),
  })
    .index("by_game_player", ["gameId", "playerId"])
    .index("by_game_player_minion", ["gameId", "playerId", "minionId"]),

  // Rule 22: Call Queue.
  //
  // Discriminated by `kind`:
  //   - `"minion"` (default; legacy rows with `kind === undefined` project
  //     to this kind for back-compat) — `minionId` is required, `label`
  //     absent. Generates dice rolls per the dice-rolls v3 plan.
  //   - `"custom"` — free-form text label call. `label` is required,
  //     `minionId` absent. Does NOT generate dice rolls. The Private
  //     Call button is a client-side shortcut for a custom call with
  //     the literal label `"Private Call"`; the server has no concept
  //     of "private" — call visibility is unchanged.
  // See `plans/2026-04-28-private-and-custom-calls-v2.md`.
  calls: defineTable({
    gameId: v.id("games"),
    playerId: v.id("players"),
    // Optional: required when kind === "minion", absent when "custom".
    // `undefined` is also valid for legacy rows written before the
    // kind discriminator existed; readers project them as "minion".
    minionId: v.optional(v.id("minions")),
    // `undefined` projects to `"minion"` for back-compat with rows
    // written before this field existed.
    kind: v.optional(
      v.union(v.literal("minion"), v.literal("custom")),
    ),
    // Required when kind === "custom"; absent when "minion". Trimmed
    // and validated server-side (≤ 80 chars; non-empty after trim).
    label: v.optional(v.string()),
    createdAt: v.number(),
    isActive: v.boolean(), // kept in sync with removedAt
    removedAt: v.optional(v.number()),
    removedByGmId: v.optional(v.id("users")),
  })
    .index("by_game_active_time", ["gameId", "isActive", "createdAt"])
    .index("by_game_removed_time", ["gameId", "removedAt"])
    .index("by_game_player_active", ["gameId", "playerId", "isActive"]),

  // Rule (dice rolls v1, plans/2026-04-28-2026-04-28-dice-rolls-v3.md):
  // GM-only roll set generated whenever a Call reaches the head of the
  // FIFO queue, or when the head call's minion is replaced in place.
  // Each row is immutable once written and addressable by id so Notes
  // can freeze the live roll set at note-creation time. Future
  // conditional rolls go into the `extras` array — the schema does not
  // need to change to add new die kinds.
  callRollSets: defineTable({
    gameId: v.id("games"),
    callId: v.id("calls"),
    // Snapshot of the called minion at roll time. A subsequent
    // replace-in-place writes a new row with a different `minionId`,
    // leaving older rows (and the Notes attached to them) intact.
    minionId: v.id("minions"),
    skillRoll: v.number(),
    skillCount: v.number(),
    // Derived once at write time via the natural-1-aware rule:
    //   (skillRoll === 1 || skillRoll <= skillCount) ? "failure" : "success"
    skillResult: v.union(v.literal("success"), v.literal("failure")),
    chaosRoll: v.number(),
    // Set to "failure" exactly when chaosRoll === 1 (the natural-1
    // rule). Otherwise omitted; the chaos cell renders neutrally.
    // "success" is reserved for future use and v1 never writes it.
    chaosResult: v.optional(
      v.union(v.literal("success"), v.literal("failure")),
    ),
    // Empty for v1; reserved for future conditional rolls. `name` is
    // mandatory (1–24 chars after trim) so every die has a UI caption.
    // `result` is coerced to "failure" by the helper whenever
    // value === 1, regardless of caller input.
    extras: v.array(
      v.object({
        kind: v.string(),
        name: v.string(),
        value: v.number(),
        result: v.optional(
          v.union(v.literal("success"), v.literal("failure")),
        ),
      }),
    ),
    createdAt: v.number(),
    createdReason: v.union(
      v.literal("became_head"),
      v.literal("minion_replaced"),
    ),
  })
    .index("by_call_created", ["callId", "createdAt"])
    .index("by_game_call", ["gameId", "callId"]),

  // Notes — per-game textual annotations on the game, a syndicate, or a
  // minion. Immutable once created. GM-only delete. Visibility: private
  // (author + GM) or public (all participants).
  //
  // `attachedRollSetId` (dice rolls v1) is set on minion-target notes
  // authored while that minion was the head of the call queue,
  // freezing the live roll set onto the note. Players never see the
  // field — `listNotesForTarget` strips it for non-GM viewers.
  notes: defineTable({
    gameId: v.id("games"),
    targetKind: v.union(
      v.literal("game"),
      v.literal("syndicate"),
      v.literal("minion"),
    ),
    targetSyndicateId: v.optional(v.id("syndicates")),
    targetMinionId: v.optional(v.id("minions")),
    authorUserId: v.id("users"),
    visibility: v.union(v.literal("private"), v.literal("public")),
    body: v.string(),
    createdAt: v.number(),
    attachedRollSetId: v.optional(v.id("callRollSets")),
  })
    .index("by_game_kind_created", ["gameId", "targetKind", "createdAt"])
    .index("by_game_syndicate_created", [
      "gameId",
      "targetSyndicateId",
      "createdAt",
    ])
    .index("by_game_minion_created", ["gameId", "targetMinionId", "createdAt"])
    .index("by_syndicate", ["targetSyndicateId"])
    .index("by_minion", ["targetMinionId"])
    .index("by_author_game", ["authorUserId", "gameId"]),

  // Rule 26: Treason Grants — per-game GM-authored bundles of
  // (keyword, POWER, description, optional player owner). Players may
  // take an unowned grant while the game is `playing`, paying out the
  // listed POWER and revealing the description to the taker.
  // See `plans/2026-04-27-treason-grants-v1.md`.
  treasonGrants: defineTable({
    gameId: v.id("games"),
    keyword: v.string(),
    // Lowercased, trimmed form of `keyword` used to enforce
    // case-insensitive uniqueness within a game (Convex has no schema-
    // level unique constraint).
    keywordLower: v.string(),
    power: v.number(),
    description: v.string(),
    ownerPlayerId: v.optional(v.id("players")),
    takenAt: v.optional(v.number()),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
  })
    .index("by_game", ["gameId"])
    .index("by_game_keywordLower", ["gameId", "keywordLower"])
    .index("by_game_owner", ["gameId", "ownerPlayerId"]),

  // Rule 27: Public Bids — per-game GM-driven ceremony. The GM opens a
  // bid round; every Player simultaneously submits a non-negative
  // integer POWER amount; non-zero amounts must be unique within the
  // round; on close, every non-zero bid is paid to the bank atomically
  // (one ledger entry per bidder, source `"bid"`).
  // See `plans/2026-04-27-public-bids-v1.md`.
  bidRounds: defineTable({
    gameId: v.id("games"),
    status: v.union(
      v.literal("open"),
      v.literal("closed"),
      v.literal("archived"),
    ),
    // Trimmed at insert time, ≤120 chars; absent ↔ "Public bid".
    label: v.optional(v.string()),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
    // Set on `open → closed`. Remains undefined for `open → archived`
    // (cancellation), preserving the audit signature.
    closedAt: v.optional(v.number()),
    closedByUserId: v.optional(v.id("users")),
    archivedAt: v.optional(v.number()),
    archivedByUserId: v.optional(v.id("users")),
  })
    // Used to assert at-most-one-non-archived-round and to fetch the
    // current active round in O(1).
    .index("by_game_status", ["gameId", "status"])
    // Used by the Game Log drawer's history list (most recent N
    // archived rounds, ordered desc).
    .index("by_game_archivedAt", ["gameId", "archivedAt"]),

  // Rule 28: Goals — per-game GM-authored bundles of
  // (keyword, description, type, fromPlayerId?, toPlayerId?, carrot?, stick?).
  // The GM authors and curates the list; only the GM may set, change, or
  // clear `fromPlayerId` (no Player-driven self-claim flow in v1). The
  // current `fromPlayerId` (when set) may assign `toPlayerId` once,
  // while `toPlayerId === undefined` and the game is not `archived`;
  // afterwards only the GM may change it. Both `fromPlayerId` and
  // `toPlayerId` are optional — a Goal can exist with neither, only
  // from, only to, or both. Description visibility is gated on the
  // viewer's identity (GM, current from, or current to); to everyone
  // else it is redacted server-side.
  // Carrot / stick are descriptive labels; v1 writes NO ledger entries
  // for goals (the GM applies POWER changes via the standard rule-20
  // flow). See `plans/2026-04-27-2026-04-27-goals-v2.md`.
  goals: defineTable({
    gameId: v.id("games"),
    keyword: v.string(),
    // Lowercased, trimmed form of `keyword` used to enforce
    // case-insensitive uniqueness within a game (Convex has no schema-
    // level unique constraint).
    keywordLower: v.string(),
    description: v.string(),
    type: v.union(
      v.literal("regular"),
      v.literal("shared"),
      v.literal("competitive"),
    ),
    // Both player refs are optional (v2 design — see the plan).
    fromPlayerId: v.optional(v.id("players")),
    toPlayerId: v.optional(v.id("players")),
    // Non-negative integer when present (≥0, ≤1000). Undefined ↔ "no
    // carrot". `0` is permitted but rendered identically to undefined.
    carrot: v.optional(v.number()),
    // Non-positive integer when present (≤0, ≥-1000). Symmetric to
    // `carrot`.
    stick: v.optional(v.number()),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
  })
    .index("by_game", ["gameId"])
    .index("by_game_keywordLower", ["gameId", "keywordLower"])
    .index("by_game_from", ["gameId", "fromPlayerId"])
    .index("by_game_to", ["gameId", "toPlayerId"]),

  // Rule 27: per-Player bid rows attached to a `bidRounds` row. One
  // row per (round, player). `amount === 0` is a valid "explicit opt-
  // out" bid distinct from "not yet bid" (no row). Non-zero amounts
  // are unique within a round, enforced by an index-backed `.unique()`
  // lookup at mutation time (Convex has no schema-level unique
  // constraint). See `plans/2026-04-27-public-bids-v1.md`.
  bids: defineTable({
    roundId: v.id("bidRounds"),
    // Denormalised from the parent round for cheap per-game scoping;
    // matches the pattern in `notes`, `calls`, `treasonGrants`.
    gameId: v.id("games"),
    playerId: v.id("players"),
    // Non-negative integer; validated at mutation time.
    amount: v.number(),
    updatedAt: v.number(),
    // Always the Player's user id. The GM cannot place bids
    // (`requireGamePlayer` rejects them).
    updatedByUserId: v.id("users"),
  })
    // Used to load every bid in the round for visibility + settlement.
    .index("by_round", ["roundId"])
    // Used by `placeBid` to upsert the caller's existing bid via
    // `.unique()`.
    .index("by_round_player", ["roundId", "playerId"])
    // Used by the uniqueness `.unique()` lookup in `placeBid`.
    .index("by_round_amount", ["roundId", "amount"]),
});
