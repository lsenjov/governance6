/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

/**
 * Minion admin-parity tests
 * (`plans/2026-05-15-admin-syndicate-access-v1.md`).
 *
 * A site admin (`users.isSiteAdmin === true`) can CRUD minions on any
 * non-played syndicate, even one they don't own. Played syndicates
 * remain frozen for everyone, including admins.
 */
const modules = import.meta.glob("./**/*.ts");

function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

async function createAdminHarness() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", {
      displayName: "Owner",
      email: "owner@minion-admin",
    });
    const adminId = await ctx.db.insert("users", {
      displayName: "Admin",
      email: "admin@minion-admin",
      isSiteAdmin: true,
    });
    const otherId = await ctx.db.insert("users", {
      displayName: "Other",
      email: "other@minion-admin",
    });
    const unplayedId = await ctx.db.insert("syndicates", {
      name: "Owner Unplayed",
      leader: "Cap",
      description: "",
      played: false,
      isShared: false,
      ownerId,
    });
    const playedId = await ctx.db.insert("syndicates", {
      name: "Owner Played",
      leader: "Cap",
      description: "",
      played: true,
      isShared: false,
      ownerId,
    });
    return { ownerId, adminId, otherId, unplayedId, playedId };
  });
  return { t, ids };
}

describe("minions: admin parity", () => {
  test("admin can create a minion on a non-owned unplayed syndicate", async () => {
    const h = await createAdminHarness();
    const minionId = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.minions.create, {
        syndicateId: h.ids.unplayedId,
        name: "Henchperson",
        skills: ["Lurking"],
      });
    const row = await h.t.run(async (ctx) => ctx.db.get(minionId));
    expect(row?.name).toBe("Henchperson");
    expect(row?.syndicateId).toBe(h.ids.unplayedId);
  });

  test("admin can update someone else's minion", async () => {
    const h = await createAdminHarness();
    const minionId = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.minions.create, {
        syndicateId: h.ids.unplayedId,
        name: "Old Name",
        skills: ["Slouching"],
      });
    await h.t.withIdentity(asUser(h.ids.adminId)).mutation(api.minions.update, {
      minionId,
      name: "Renamed by Admin",
    });
    const row = await h.t.run(async (ctx) => ctx.db.get(minionId));
    expect(row?.name).toBe("Renamed by Admin");
  });

  test("admin can remove someone else's minion (cascades intact)", async () => {
    const h = await createAdminHarness();
    const minionId = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.minions.create, {
        syndicateId: h.ids.unplayedId,
        name: "Doomed",
        skills: ["Vanishing"],
      });
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.minions.remove, { minionId });
    const row = await h.t.run(async (ctx) => ctx.db.get(minionId));
    expect(row).toBeNull();
  });

  test("non-admin non-owner still cannot create", async () => {
    const h = await createAdminHarness();
    await expect(
      h.t.withIdentity(asUser(h.ids.otherId)).mutation(api.minions.create, {
        syndicateId: h.ids.unplayedId,
        name: "Sneak",
        skills: ["Sneaking"],
      }),
    ).rejects.toThrow(/owner/i);
  });

  test("admin is still locked out of a played syndicate (create)", async () => {
    const h = await createAdminHarness();
    await expect(
      h.t.withIdentity(asUser(h.ids.adminId)).mutation(api.minions.create, {
        syndicateId: h.ids.playedId,
        name: "Frozen",
        skills: ["Static"],
      }),
    ).rejects.toThrow(/played|frozen/i);
  });

  test("admin is still locked out of a played syndicate (update)", async () => {
    const h = await createAdminHarness();
    // Seed via direct insert so we can target a minion on a played
    // syndicate without going through `create` (which the played lock
    // would reject for everyone, including the owner).
    const minionId = await h.t.run(async (ctx) =>
      ctx.db.insert("minions", {
        syndicateId: h.ids.playedId,
        name: "Sealed",
        skills: ["Loitering"],
        order: 0,
      }),
    );
    await expect(
      h.t
        .withIdentity(asUser(h.ids.adminId))
        .mutation(api.minions.update, { minionId, name: "Try edit" }),
    ).rejects.toThrow(/played|frozen/i);
  });

  test("admin is still locked out of a played syndicate (remove)", async () => {
    const h = await createAdminHarness();
    const minionId = await h.t.run(async (ctx) =>
      ctx.db.insert("minions", {
        syndicateId: h.ids.playedId,
        name: "Sealed",
        skills: ["Loitering"],
        order: 0,
      }),
    );
    await expect(
      h.t
        .withIdentity(asUser(h.ids.adminId))
        .mutation(api.minions.remove, { minionId }),
    ).rejects.toThrow(/played|frozen/i);
  });
});

describe("minions: ordering", () => {
  test("listForSyndicate returns minions alphabetically by name (case-insensitive)", async () => {
    const h = await createAdminHarness();
    // Insert in non-alphabetical order with `order` values that would
    // surface a different sequence under the legacy `order` sort. The
    // new contract is name-alphabetical with case-insensitive
    // comparison, so the expected order is [alice, Bob, Charlie].
    await h.t.run(async (ctx) => {
      await ctx.db.insert("minions", {
        syndicateId: h.ids.unplayedId,
        name: "Charlie",
        skills: [],
        order: 0,
      });
      await ctx.db.insert("minions", {
        syndicateId: h.ids.unplayedId,
        name: "alice",
        skills: [],
        order: 1,
      });
      await ctx.db.insert("minions", {
        syndicateId: h.ids.unplayedId,
        name: "Bob",
        skills: [],
        order: 2,
      });
    });
    const rows = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .query(api.minions.listForSyndicate, { syndicateId: h.ids.unplayedId });
    expect(rows.map((m) => m.name)).toEqual(["alice", "Bob", "Charlie"]);
  });
});
