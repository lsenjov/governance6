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
  drawbacks: defineTable({
    syndicateId: v.id("syndicates"),
    name: v.string(),
    description: v.string(),
    order: v.number(),
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

  // Rules 18, 19: append-only ledger.
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
  calls: defineTable({
    gameId: v.id("games"),
    playerId: v.id("players"),
    minionId: v.id("minions"),
    createdAt: v.number(),
    isActive: v.boolean(), // kept in sync with removedAt
    removedAt: v.optional(v.number()),
    removedByGmId: v.optional(v.id("users")),
  })
    .index("by_game_active_time", ["gameId", "isActive", "createdAt"])
    .index("by_game_removed_time", ["gameId", "removedAt"])
    .index("by_game_player_active", ["gameId", "playerId", "isActive"]),

  // Notes — per-game textual annotations on the game, a syndicate, or a
  // minion. Immutable once created. GM-only delete. Visibility: private
  // (author + GM) or public (all participants).
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
});
