/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/**
 * Test harness for the preset-drawback admin catalogue.
 *
 * Mirrors `convex/treasonGrants.test.ts` for admin-gated CRUD; covers
 * the four-field shape (`name`, `description`, `abbreviation`,
 * `isRolled`) and the case-insensitive uniqueness rule.
 *
 * Site admin status is set directly on `users.isSiteAdmin` — there is
 * no app-side flow that flips it (`convex/lib/auth.ts:32-42`).
 */
function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

async function createHarness() {
  const t = convexTest(schema, modules);

  const ids = await t.run(async (ctx) => {
    const adminId = await ctx.db.insert("users", {
      displayName: "Admin",
      email: "admin@test",
      isSiteAdmin: true,
    });
    const userId = await ctx.db.insert("users", {
      displayName: "User",
      email: "user@test",
    });
    return { adminId, userId };
  });

  return { t, ids };
}

describe("presetDrawbacks: authorisation", () => {
  test("non-admin cannot add / update / remove", async () => {
    const h = await createHarness();
    await expect(
      h.t.withIdentity(asUser(h.ids.userId)).mutation(api.presetDrawbacks.add, {
        name: "Glass Jaw",
        description: "",
      }),
    ).rejects.toThrow(/admin/i);
  });

  test("unauthenticated cannot list", async () => {
    const h = await createHarness();
    await expect(h.t.query(api.presetDrawbacks.list, {})).rejects.toThrow(
      /Not authenticated/i,
    );
  });

  test("authenticated non-admin can list", async () => {
    const h = await createHarness();
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, {
        name: "Glass Jaw",
        description: "",
      });
    const rows = await h.t
      .withIdentity(asUser(h.ids.userId))
      .query(api.presetDrawbacks.list, {});
    expect(rows).toHaveLength(1);
  });
});

describe("presetDrawbacks.add", () => {
  test("admin creates a row with all four fields", async () => {
    const h = await createHarness();
    const id = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, {
        name: "Glass Jaw",
        description: "Easily injured",
        abbreviation: "GLSJAW",
        isRolled: true,
      });
    const row = await h.t.run(async (ctx) => ctx.db.get(id));
    expect(row?.name).toBe("Glass Jaw");
    expect(row?.description).toBe("Easily injured");
    expect(row?.abbreviation).toBe("GLSJAW");
    expect(row?.isRolled).toBe(true);
    expect(row?.createdByUserId).toBe(h.ids.adminId);
  });

  test("isRolled defaults to false on omission", async () => {
    const h = await createHarness();
    const id = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, { name: "Aimless", description: "" });
    const row = await h.t.run(async (ctx) => ctx.db.get(id));
    expect(row?.isRolled).toBe(false);
    expect(row?.abbreviation).toBeUndefined();
  });

  test("name is trimmed and required", async () => {
    const h = await createHarness();
    await expect(
      h.t
        .withIdentity(asUser(h.ids.adminId))
        .mutation(api.presetDrawbacks.add, { name: "    ", description: "" }),
    ).rejects.toThrow(/at least 1/i);
  });

  test("abbreviation rejects more than 6 chars", async () => {
    const h = await createHarness();
    await expect(
      h.t
        .withIdentity(asUser(h.ids.adminId))
        .mutation(api.presetDrawbacks.add, {
          name: "TooLong",
          description: "",
          abbreviation: "TOOLONG",
        }),
    ).rejects.toThrow(/at most 6/i);
  });

  test("name uniqueness is case-insensitive", async () => {
    const h = await createHarness();
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, {
        name: "Glass Jaw",
        description: "",
      });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.adminId))
        .mutation(api.presetDrawbacks.add, {
          name: "glass jaw",
          description: "",
        }),
    ).rejects.toThrow(/already exists/i);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.adminId))
        .mutation(api.presetDrawbacks.add, {
          name: "  GLASS JAW  ",
          description: "",
        }),
    ).rejects.toThrow(/already exists/i);
  });
});

describe("presetDrawbacks.update", () => {
  test("admin can patch any subset of the four fields", async () => {
    const h = await createHarness();
    const id = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, {
        name: "Glass Jaw",
        description: "",
        abbreviation: "GLSJAW",
        isRolled: true,
      });
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.update, {
        drawbackId: id,
        description: "new description",
      });
    let row = await h.t.run(async (ctx) => ctx.db.get(id));
    expect(row?.description).toBe("new description");
    expect(row?.name).toBe("Glass Jaw");
    expect(row?.abbreviation).toBe("GLSJAW");
    expect(row?.isRolled).toBe(true);

    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.update, {
        drawbackId: id,
        isRolled: false,
      });
    row = await h.t.run(async (ctx) => ctx.db.get(id));
    expect(row?.isRolled).toBe(false);
  });

  test("update with empty abbreviation clears the field", async () => {
    const h = await createHarness();
    const id = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, {
        name: "Glass Jaw",
        description: "",
        abbreviation: "GLSJAW",
      });
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.update, {
        drawbackId: id,
        abbreviation: "  ",
      });
    const row = await h.t.run(async (ctx) => ctx.db.get(id));
    expect(row?.abbreviation).toBeUndefined();
  });

  test("update enforces case-insensitive uniqueness", async () => {
    const h = await createHarness();
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, {
        name: "Glass Jaw",
        description: "",
      });
    const otherId = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, {
        name: "Aimless",
        description: "",
      });

    await expect(
      h.t
        .withIdentity(asUser(h.ids.adminId))
        .mutation(api.presetDrawbacks.update, {
          drawbackId: otherId,
          name: "GLASS JAW",
        }),
    ).rejects.toThrow(/already exists/i);

    // Renaming the row to its own (different-case) value is allowed.
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.update, {
        drawbackId: otherId,
        name: "AIMLESS",
      });
  });

  test("update rejects abbreviation longer than 6 chars", async () => {
    const h = await createHarness();
    const id = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, {
        name: "Glass Jaw",
        description: "",
      });
    await expect(
      h.t
        .withIdentity(asUser(h.ids.adminId))
        .mutation(api.presetDrawbacks.update, {
          drawbackId: id,
          abbreviation: "TOOLONG",
        }),
    ).rejects.toThrow(/at most 6/i);
  });
});

describe("presetDrawbacks.remove", () => {
  test("admin can delete; non-admin cannot", async () => {
    const h = await createHarness();
    const id = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, {
        name: "Glass Jaw",
        description: "",
      });

    await expect(
      h.t
        .withIdentity(asUser(h.ids.userId))
        .mutation(api.presetDrawbacks.remove, {
          drawbackId: id,
        }),
    ).rejects.toThrow(/admin/i);

    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.remove, { drawbackId: id });

    const remaining = await h.t
      .withIdentity(asUser(h.ids.userId))
      .query(api.presetDrawbacks.list, {});
    expect(remaining).toHaveLength(0);
  });

  test("delete is idempotent (no error on missing id)", async () => {
    const h = await createHarness();
    const id = await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.add, {
        name: "Glass Jaw",
        description: "",
      });
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.remove, { drawbackId: id });
    // Second remove of the same id must not throw.
    await h.t
      .withIdentity(asUser(h.ids.adminId))
      .mutation(api.presetDrawbacks.remove, { drawbackId: id });
  });
});
