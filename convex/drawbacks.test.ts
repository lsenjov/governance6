/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/**
 * Test harness for the per-Syndicate drawback CRUD module.
 *
 * Drawbacks are owned by Syndicates and only their owner (while the
 * Syndicate is unplayed) can mutate them. The new `abbreviation` and
 * `isRolled` fields are the focus of this suite — see
 * `plans/2026-04-28-drawback-rolls-v1.md` Task 18.
 *
 * Mirrors the structural pattern of `convex/treasonGrants.test.ts`.
 */
function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

async function createHarness() {
  const t = convexTest(schema, modules);

  const ids = await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("users", {
      displayName: "Owner",
      email: "owner@test",
    });
    const otherId = await ctx.db.insert("users", {
      displayName: "Other",
      email: "other@test",
    });
    const syndicateId = await ctx.db.insert("syndicates", {
      name: "Owner's Syndicate",
      leader: "Cap",
      description: "",
      played: false,
      isShared: false,
      ownerId,
    });
    return { ownerId, otherId, syndicateId };
  });

  return { t, ids };
}

describe("drawbacks.create: optional abbreviation and isRolled", () => {
  test("create accepts and persists abbreviation + isRolled", async () => {
    const h = await createHarness();
    const drawbackId = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.create, {
        syndicateId: h.ids.syndicateId,
        name: "Glass Jaw",
        description: "Easily injured",
        abbreviation: "GLSJAW",
        isRolled: true,
      });

    const row = await h.t.run(async (ctx) => ctx.db.get(drawbackId));
    expect(row?.name).toBe("Glass Jaw");
    expect(row?.description).toBe("Easily injured");
    expect(row?.abbreviation).toBe("GLSJAW");
    expect(row?.isRolled).toBe(true);
  });

  test("create defaults isRolled to false and leaves abbreviation undefined", async () => {
    const h = await createHarness();
    const drawbackId = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.create, {
        syndicateId: h.ids.syndicateId,
        name: "Aimless",
        description: "no plan",
      });

    const row = await h.t.run(async (ctx) => ctx.db.get(drawbackId));
    expect(row?.abbreviation).toBeUndefined();
    expect(row?.isRolled).toBe(false);
  });

  test("create rejects abbreviation longer than 6 chars", async () => {
    const h = await createHarness();
    await expect(
      h.t.withIdentity(asUser(h.ids.ownerId)).mutation(api.drawbacks.create, {
        syndicateId: h.ids.syndicateId,
        name: "TooLong",
        description: "",
        abbreviation: "TOOLONG",
      }),
    ).rejects.toThrow(/at most 6/i);
  });

  test("create treats empty-after-trim abbreviation as undefined", async () => {
    const h = await createHarness();
    const drawbackId = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.create, {
        syndicateId: h.ids.syndicateId,
        name: "Blanky",
        description: "",
        abbreviation: "    ",
      });
    const row = await h.t.run(async (ctx) => ctx.db.get(drawbackId));
    expect(row?.abbreviation).toBeUndefined();
  });

  test("create rejects when caller is not the syndicate owner", async () => {
    const h = await createHarness();
    await expect(
      h.t.withIdentity(asUser(h.ids.otherId)).mutation(api.drawbacks.create, {
        syndicateId: h.ids.syndicateId,
        name: "Sneaky",
        description: "",
      }),
    ).rejects.toThrow(/owner/i);
  });
});

describe("drawbacks.update: optional abbreviation and isRolled", () => {
  test("update patches abbreviation and isRolled independently", async () => {
    const h = await createHarness();
    const drawbackId = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.create, {
        syndicateId: h.ids.syndicateId,
        name: "Slow",
        description: "",
        abbreviation: "SLOW",
        isRolled: false,
      });

    // Patch only isRolled.
    await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.update, { drawbackId, isRolled: true });
    const afterFlip = await h.t.run(async (ctx) => ctx.db.get(drawbackId));
    expect(afterFlip?.isRolled).toBe(true);
    expect(afterFlip?.abbreviation).toBe("SLOW");

    // Patch only abbreviation.
    await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.update, { drawbackId, abbreviation: "MOLAS" });
    const afterAbbrev = await h.t.run(async (ctx) => ctx.db.get(drawbackId));
    expect(afterAbbrev?.abbreviation).toBe("MOLAS");
    expect(afterAbbrev?.isRolled).toBe(true);
  });

  test("update with explicit empty abbreviation clears the field", async () => {
    const h = await createHarness();
    const drawbackId = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.create, {
        syndicateId: h.ids.syndicateId,
        name: "Slow",
        description: "",
        abbreviation: "SLOW",
      });
    await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.update, { drawbackId, abbreviation: "   " });
    const row = await h.t.run(async (ctx) => ctx.db.get(drawbackId));
    expect(row?.abbreviation).toBeUndefined();
  });

  test("update rejects abbreviation longer than 6 chars", async () => {
    const h = await createHarness();
    const drawbackId = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.create, {
        syndicateId: h.ids.syndicateId,
        name: "Slow",
        description: "",
      });
    await expect(
      h.t.withIdentity(asUser(h.ids.ownerId)).mutation(api.drawbacks.update, {
        drawbackId,
        abbreviation: "TOOLONG",
      }),
    ).rejects.toThrow(/at most 6/i);
  });

  test("update preserves abbreviation/isRolled when omitted", async () => {
    const h = await createHarness();
    const drawbackId = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.create, {
        syndicateId: h.ids.syndicateId,
        name: "Slow",
        description: "old",
        abbreviation: "SLOW",
        isRolled: true,
      });
    await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.update, { drawbackId, description: "new" });
    const row = await h.t.run(async (ctx) => ctx.db.get(drawbackId));
    expect(row?.description).toBe("new");
    expect(row?.abbreviation).toBe("SLOW");
    expect(row?.isRolled).toBe(true);
  });
});

describe("drawbacks.listForSyndicate", () => {
  test("returns the new fields for any authenticated user", async () => {
    const h = await createHarness();
    await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .mutation(api.drawbacks.create, {
        syndicateId: h.ids.syndicateId,
        name: "Loud",
        description: "",
        abbreviation: "LOUD",
        isRolled: true,
      });

    // Owner can see them.
    const ownerView = await h.t
      .withIdentity(asUser(h.ids.ownerId))
      .query(api.drawbacks.listForSyndicate, {
        syndicateId: h.ids.syndicateId,
      });
    expect(ownerView).toHaveLength(1);
    expect(ownerView[0].abbreviation).toBe("LOUD");
    expect(ownerView[0].isRolled).toBe(true);

    // Any authenticated user can read.
    const otherView = await h.t
      .withIdentity(asUser(h.ids.otherId))
      .query(api.drawbacks.listForSyndicate, {
        syndicateId: h.ids.syndicateId,
      });
    expect(otherView).toHaveLength(1);
    expect(otherView[0].abbreviation).toBe("LOUD");
    expect(otherView[0].isRolled).toBe(true);
  });
});
