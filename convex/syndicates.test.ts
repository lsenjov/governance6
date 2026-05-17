/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

/**
 * Site admin parity tests for the syndicates module
 * (`plans/2026-05-15-admin-syndicate-access-v1.md`).
 *
 * Covers:
 *   - `syndicates.update` and `setIsShared` succeed for an admin on a
 *     non-owned unplayed syndicate.
 *   - `syndicates.remove` succeeds for an admin on a non-owned
 *     unplayed syndicate and cascades drawbacks / minions /
 *     gamePlayerMinions / player selection clearing in `ready` games.
 *   - `getWithChildren` returns the syndicate (with
 *     `isAdminView: true`, `canEdit: true`, owner display name) when
 *     an admin queries a private non-owned unplayed syndicate.
 *   - `listAll` returns rows authored by other users, sorted
 *     unplayed-first then most-recent-first.
 *   - `listSelectable` does NOT widen for admins (scope-creep
 *     negative test).
 *   - Played syndicates remain frozen for admins via every write path.
 */
const modules = import.meta.glob("./**/*.ts");

function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

async function createHarness() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", {
      displayName: "Owner",
      email: "owner@syn-admin",
    });
    const adminId = await ctx.db.insert("users", {
      displayName: "Admin",
      email: "admin@syn-admin",
      isSiteAdmin: true,
    });
    const strangerId = await ctx.db.insert("users", {
      displayName: "Stranger",
      email: "stranger@syn-admin",
    });
    const privateUnplayedId = await ctx.db.insert("syndicates", {
      name: "Owner Private Unplayed",
      leader: "Cap",
      description: "private",
      played: false,
      isShared: false,
      ownerId,
    });
    const playedId = await ctx.db.insert("syndicates", {
      name: "Owner Played",
      leader: "Cap",
      description: "played",
      played: true,
      isShared: false,
      ownerId,
    });
    return {
      ownerId,
      adminId,
      strangerId,
      privateUnplayedId,
      playedId,
    };
  });
  return { t, ids };
}

describe("syndicates.update / setIsShared: admin parity", () => {
  test("admin can update a non-owned unplayed syndicate", async () => {
    const h = await createHarness();
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.syndicates.update, {
        syndicateId: h.ids.privateUnplayedId,
        name: "Admin Renamed",
      });
    const row = await h.t.run(async (ctx) =>
      ctx.db.get(h.ids.privateUnplayedId),
    );
    expect(row?.name).toBe("Admin Renamed");
  });

  test("admin can toggle share on a non-owned unplayed syndicate", async () => {
    const h = await createHarness();
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.syndicates.setIsShared, {
        syndicateId: h.ids.privateUnplayedId,
        value: true,
      });
    const row = await h.t.run(async (ctx) =>
      ctx.db.get(h.ids.privateUnplayedId),
    );
    expect(row?.isShared).toBe(true);
  });

  test("admin is still locked out of a played syndicate (update)", async () => {
    const h = await createHarness();
    await expect(
      h.t.withIdentity(asUser(h.ids.adminId)).mutation(api.syndicates.update, {
        syndicateId: h.ids.playedId,
        name: "Try edit",
      }),
    ).rejects.toThrow(/played|frozen/i);
  });

  test("admin is still locked out of a played syndicate (setIsShared)", async () => {
    const h = await createHarness();
    await expect(
      h.t
        .withIdentity(asUser(h.ids.adminId))
        .mutation(api.syndicates.setIsShared, {
          syndicateId: h.ids.playedId,
          value: true,
        }),
    ).rejects.toThrow(/played|frozen/i);
  });

  test("non-admin non-owner is still rejected", async () => {
    const h = await createHarness();
    await expect(
      h.t
        .withIdentity(asUser(h.ids.strangerId))
        .mutation(api.syndicates.update, {
          syndicateId: h.ids.privateUnplayedId,
          name: "Sneak",
        }),
    ).rejects.toThrow(/owner/i);
  });
});

describe("syndicates.remove: admin parity + cascade", () => {
  test("admin can delete a non-owned unplayed syndicate and cascades fire", async () => {
    const h = await createHarness();

    // Seed drawback, minion, gamePlayerMinion, ready-game player with
    // selectedSyndicateId pointing at the target, plus syndicate-target
    // and minion-target notes so the cascade's notes branches
    // (`convex/syndicates.ts:148-152, 156-163` and
    // `convex/minions.ts:194-198`) are exercised by the assertion below.
    const seeded = await h.t.run(async (ctx) => {
      await ctx.db.insert("drawbacks", {
        syndicateId: h.ids.privateUnplayedId,
        name: "Loud",
        description: "",
        order: 0,
      });
      const minionId = await ctx.db.insert("minions", {
        syndicateId: h.ids.privateUnplayedId,
        name: "Henchperson",
        skills: ["Lurking"],
        order: 0,
      });
      const gameId = await ctx.db.insert("games", {
        gmId: h.ids.ownerId,
        state: "ready",
      });
      const playerId = await ctx.db.insert("players", {
        gameId,
        userId: h.ids.strangerId,
        selectedSyndicateId: h.ids.privateUnplayedId,
        power: 0,
        joinedAt: Date.now(),
      });
      await ctx.db.insert("gamePlayerMinions", {
        gameId,
        playerId,
        minionId,
        bought: false,
      });
      const syndicateNoteId = await ctx.db.insert("notes", {
        gameId,
        targetKind: "syndicate",
        targetSyndicateId: h.ids.privateUnplayedId,
        authorUserId: h.ids.ownerId,
        visibility: "public",
        body: "syndicate note",
        createdAt: Date.now(),
      });
      const minionNoteId = await ctx.db.insert("notes", {
        gameId,
        targetKind: "minion",
        targetMinionId: minionId,
        authorUserId: h.ids.ownerId,
        visibility: "public",
        body: "minion note",
        createdAt: Date.now(),
      });
      return { syndicateNoteId, minionNoteId };
    });

    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.syndicates.remove, {
        syndicateId: h.ids.privateUnplayedId,
      });

    // Syndicate gone.
    const synAfter = await h.t.run(async (ctx) =>
      ctx.db.get(h.ids.privateUnplayedId),
    );
    expect(synAfter).toBeNull();

    // Drawbacks and minions cleared.
    const drawbacks = await h.t.run(async (ctx) =>
      ctx.db
        .query("drawbacks")
        .withIndex("by_syndicate", (q) =>
          q.eq("syndicateId", h.ids.privateUnplayedId),
        )
        .collect(),
    );
    expect(drawbacks).toHaveLength(0);
    const minions = await h.t.run(async (ctx) =>
      ctx.db
        .query("minions")
        .withIndex("by_syndicate", (q) =>
          q.eq("syndicateId", h.ids.privateUnplayedId),
        )
        .collect(),
    );
    expect(minions).toHaveLength(0);

    // gamePlayerMinions cleared.
    const gpms = await h.t.run(async (ctx) =>
      ctx.db.query("gamePlayerMinions").collect(),
    );
    expect(gpms).toHaveLength(0);

    // The ready-game player's selectedSyndicateId is cleared.
    const players = await h.t.run(async (ctx) =>
      ctx.db.query("players").collect(),
    );
    expect(players).toHaveLength(1);
    expect(players[0].selectedSyndicateId).toBeUndefined();

    // Notes targeting the syndicate AND the cascaded minion are cleared.
    const syndicateNote = await h.t.run(async (ctx) =>
      ctx.db.get(seeded.syndicateNoteId),
    );
    expect(syndicateNote).toBeNull();
    const minionNote = await h.t.run(async (ctx) =>
      ctx.db.get(seeded.minionNoteId),
    );
    expect(minionNote).toBeNull();
  });

  test("admin cannot delete a played syndicate (bespoke error preserved)", async () => {
    const h = await createHarness();
    // Locks the bespoke "Games reference its content" copy at
    // `convex/syndicates.ts:124-128` so a future refactor cannot
    // silently route this through the generic frozen-syndicate message.
    await expect(
      h.t
        .withIdentity(asUser(h.ids.adminId))
        .mutation(api.syndicates.remove, { syndicateId: h.ids.playedId }),
    ).rejects.toThrow(/Games reference its content/i);
  });
});

describe("syndicates.getWithChildren: admin view", () => {
  test("admin can read a private non-owned unplayed syndicate", async () => {
    const h = await createHarness();
    const result = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .query(api.syndicates.getWithChildren, {
        syndicateId: h.ids.privateUnplayedId,
      });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.isOwner).toBe(false);
    expect(result.isAdminView).toBe(true);
    expect(result.canEdit).toBe(true);
    expect(result.ownerName).toBe("Owner");
  });

  test("non-admin stranger cannot read a private non-owned syndicate", async () => {
    const h = await createHarness();
    const result = await h.t
      .withIdentity(asUser(h.ids.strangerId))
      .query(api.syndicates.getWithChildren, {
        syndicateId: h.ids.privateUnplayedId,
      });
    expect(result).toBeNull();
  });

  test("admin viewing their OWN syndicate is not flagged as admin view", async () => {
    const h = await createHarness();
    const adminOwnedId = await h.t.run(async (ctx) =>
      ctx.db.insert("syndicates", {
        name: "Admin's Own",
        leader: "Me",
        description: "",
        played: false,
        isShared: false,
        ownerId: h.ids.adminId,
      }),
    );
    const result = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .query(api.syndicates.getWithChildren, { syndicateId: adminOwnedId });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.isOwner).toBe(true);
    expect(result.isAdminView).toBe(false);
    expect(result.canEdit).toBe(true);
    expect(result.ownerName).toBeUndefined();
  });

  test("played syndicate has canEdit=false even for admin", async () => {
    const h = await createHarness();
    const result = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .query(api.syndicates.getWithChildren, { syndicateId: h.ids.playedId });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.isAdminView).toBe(true);
    expect(result.canEdit).toBe(false);
  });
});

describe("syndicates.listAll", () => {
  test("admin gets every syndicate with owner attribution (incl. admin-authored)", async () => {
    const h = await createHarness();
    // Seed a syndicate authored by the admin themselves so we lock in
    // that "every syndicate" really means every syndicate — admins are
    // not silently filtered out of their own list.
    const adminOwnedId = await h.t.run(async (ctx) =>
      ctx.db.insert("syndicates", {
        name: "Admin's Own Syndicate",
        leader: "Self",
        description: "",
        played: false,
        isShared: false,
        ownerId: h.ids.adminId,
      }),
    );
    const rows = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .query(api.syndicates.listAll, {});
    const ids = rows.map((r) => r._id);
    expect(ids).toContain(h.ids.privateUnplayedId);
    expect(ids).toContain(h.ids.playedId);
    expect(ids).toContain(adminOwnedId);
    for (const r of rows) {
      expect(r.ownerName).toBeDefined();
      expect(r.ownerEmail).toBeDefined();
    }
    // The admin-authored row carries the admin's own email.
    const adminRow = rows.find((r) => r._id === adminOwnedId);
    expect(adminRow?.ownerEmail).toBe("admin@syn-admin");
    expect(adminRow?.ownerName).toBe("Admin");
  });

  test("rows are sorted unplayed-first, then most-recent-first", async () => {
    const h = await createHarness();
    // Insert a second unplayed row newer than the original to verify the
    // recency tiebreaker. The seed `privateUnplayedId` was inserted first.
    const newerUnplayedId = await h.t.run(async (ctx) =>
      ctx.db.insert("syndicates", {
        name: "Newer Unplayed",
        leader: "Two",
        description: "",
        played: false,
        isShared: false,
        ownerId: h.ids.strangerId,
      }),
    );
    const rows = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .query(api.syndicates.listAll, {});
    // All unplayed before any played.
    let sawPlayed = false;
    for (const r of rows) {
      if (r.played) sawPlayed = true;
      else expect(sawPlayed).toBe(false);
    }
    // Unplayed: newer first.
    const unplayed = rows.filter((r) => !r.played);
    const newerIdx = unplayed.findIndex((r) => r._id === newerUnplayedId);
    const olderIdx = unplayed.findIndex(
      (r) => r._id === h.ids.privateUnplayedId,
    );
    expect(newerIdx).toBeGreaterThanOrEqual(0);
    expect(olderIdx).toBeGreaterThan(newerIdx);
  });

  test("non-admin is rejected", async () => {
    const h = await createHarness();
    await expect(
      h.t
        .withIdentity(asUser(h.ids.strangerId))
        .query(api.syndicates.listAll, {}),
    ).rejects.toThrow(/admin/i);
  });
});

describe("syndicates.listSelectable: NOT widened for admin", () => {
  test("admin acting as a player sees only own + shared, not other-private", async () => {
    const h = await createHarness();
    const rows = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .query(api.syndicates.listSelectable, {});
    const ids = rows.map((r) => r._id);
    // The owner's private syndicate must NOT appear.
    expect(ids).not.toContain(h.ids.privateUnplayedId);
  });
});
