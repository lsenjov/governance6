/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { Scrypt } from "lucia";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

/**
 * Tests for the admin-triggered password reset flow.
 *
 * - `consumePasswordResetFlag` (internal mutation): seeded by inserting
 *   `users` rows directly; called via `t.mutation(internal.auth...)`.
 * - `resetFlaggedPassword` (public action): exercised end-to-end. The
 *   action runs through `ctx.runMutation("auth:store", ...)` (see
 *   `modifyAccount.js:29-35`), which `convex-test` routes to the
 *   `store` mutation export at `convex/auth.ts` produced by
 *   `convexAuth()`.
 *
 * See `plans/2026-05-16-admin-password-reset-flag-v1.md`.
 */

async function seedUserWithFlag(
  t: ReturnType<typeof convexTest>,
  opts: {
    email: string;
    displayName?: string;
    isSiteAdmin?: boolean;
    passwordResetPending?: true;
  },
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      email: opts.email,
      displayName: opts.displayName,
      isSiteAdmin: opts.isSiteAdmin,
      passwordResetPending: opts.passwordResetPending,
    }),
  );
}

/**
 * Seed a Password-provider `authAccounts` row for the given user. The
 * `secret` is a real Scrypt hash so the assertion that the action rewrote
 * it is meaningful (we compare against the seeded hash for inequality).
 */
async function seedPasswordAccount(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  email: string,
  plaintext: string,
): Promise<{ accountId: Id<"authAccounts">; seededSecret: string }> {
  const seededSecret = await new Scrypt().hash(plaintext);
  const accountId = await t.run(async (ctx) =>
    ctx.db.insert("authAccounts", {
      userId,
      provider: "password",
      providerAccountId: email,
      secret: seededSecret,
    }),
  );
  return { accountId, seededSecret };
}

describe("consumePasswordResetFlag", () => {
  test("throws 'No reset pending.' when no user matches the email", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(internal.auth.consumePasswordResetFlag, {
        email: "ghost@example.com",
      }),
    ).rejects.toThrow(/no reset pending/i);
  });

  test("throws 'No reset pending.' when the flag is unset", async () => {
    const t = convexTest(schema, modules);
    await seedUserWithFlag(t, { email: "u@example.com" });
    await expect(
      t.mutation(internal.auth.consumePasswordResetFlag, {
        email: "u@example.com",
      }),
    ).rejects.toThrow(/no reset pending/i);
  });

  test("throws 'No reset pending.' when two users share the email", async () => {
    const t = convexTest(schema, modules);
    await seedUserWithFlag(t, {
      email: "dup@example.com",
      passwordResetPending: true,
    });
    await seedUserWithFlag(t, {
      email: "dup@example.com",
      passwordResetPending: true,
    });
    await expect(
      t.mutation(internal.auth.consumePasswordResetFlag, {
        email: "dup@example.com",
      }),
    ).rejects.toThrow(/no reset pending/i);
  });

  test("clears the flag, returns the userId, and preserves other fields", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUserWithFlag(t, {
      email: "u@example.com",
      displayName: "Alice",
      isSiteAdmin: true,
      passwordResetPending: true,
    });

    const returned = await t.mutation(internal.auth.consumePasswordResetFlag, {
      email: "u@example.com",
    });
    expect(returned).toBe(userId);

    const after = await t.run(async (ctx) => ctx.db.get(userId));
    expect(after).not.toBeNull();
    expect(after?.passwordResetPending).toBeUndefined();
    // Other fields must survive the patch untouched.
    expect(after?.email).toBe("u@example.com");
    expect(after?.displayName).toBe("Alice");
    expect(after?.isSiteAdmin).toBe(true);
  });

  test("is single-use: a second call after success throws", async () => {
    const t = convexTest(schema, modules);
    await seedUserWithFlag(t, {
      email: "u@example.com",
      passwordResetPending: true,
    });
    await t.mutation(internal.auth.consumePasswordResetFlag, {
      email: "u@example.com",
    });
    await expect(
      t.mutation(internal.auth.consumePasswordResetFlag, {
        email: "u@example.com",
      }),
    ).rejects.toThrow(/no reset pending/i);
  });
});

describe("resetFlaggedPassword", () => {
  test("rejects passwords shorter than 8 chars without consuming the flag", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUserWithFlag(t, {
      email: "u@example.com",
      passwordResetPending: true,
    });
    const { accountId, seededSecret } = await seedPasswordAccount(
      t,
      userId,
      "u@example.com",
      "originalpass",
    );

    await expect(
      t.action(api.auth.resetFlaggedPassword, {
        email: "u@example.com",
        newPassword: "short",
      }),
    ).rejects.toThrow(/at least 8/i);

    // Flag must NOT have been consumed; admin shouldn't have to re-flip
    // after a typo'd password.
    const after = await t.run(async (ctx) => ctx.db.get(userId));
    expect(after?.passwordResetPending).toBe(true);
    // Defence-in-depth: the password hash on disk must also be untouched.
    const account = await t.run(async (ctx) => ctx.db.get(accountId));
    expect(account?.secret).toBe(seededSecret);
  });

  test("rejects when no reset is pending (generic error, no user)", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.action(api.auth.resetFlaggedPassword, {
        email: "ghost@example.com",
        newPassword: "validpassword",
      }),
    ).rejects.toThrow(/no reset pending/i);
  });

  test("rejects when no reset is pending (flag absent on existing user)", async () => {
    const t = convexTest(schema, modules);
    await seedUserWithFlag(t, { email: "u@example.com" });
    await expect(
      t.action(api.auth.resetFlaggedPassword, {
        email: "u@example.com",
        newPassword: "validpassword",
      }),
    ).rejects.toThrow(/no reset pending/i);
  });

  test("masks library 'account does not exist' error when authAccounts row is missing", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUserWithFlag(t, {
      email: "u@example.com",
      passwordResetPending: true,
    });
    // Intentionally do NOT seed an authAccounts row.

    await expect(
      t.action(api.auth.resetFlaggedPassword, {
        email: "u@example.com",
        newPassword: "validpassword",
      }),
    ).rejects.toThrow(/no reset pending/i);

    // The flag IS consumed in this branch (admin must re-flip). The
    // library's underlying error message ("Cannot modify account with
    // ID u@example.com because it does not exist") is masked.
    const after = await t.run(async (ctx) => ctx.db.get(userId));
    expect(after?.passwordResetPending).toBeUndefined();
  });

  test("succeeds when flag is set and password is valid: flag cleared, secret rewritten", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUserWithFlag(t, {
      email: "u@example.com",
      passwordResetPending: true,
    });
    const { accountId, seededSecret } = await seedPasswordAccount(
      t,
      userId,
      "u@example.com",
      "originalpass",
    );

    const result = await t.action(api.auth.resetFlaggedPassword, {
      email: "u@example.com",
      newPassword: "brandnewpass",
    });
    expect(result).toBeNull();

    const updatedAccount = await t.run(async (ctx) => ctx.db.get(accountId));
    if (updatedAccount === null) {
      throw new Error("expected authAccounts row to exist post-reset");
    }
    const newSecret = updatedAccount.secret;
    if (newSecret === undefined) {
      throw new Error("expected authAccounts.secret to be set post-reset");
    }
    expect(newSecret).not.toBe(seededSecret);

    // The new secret must verify against the new plaintext but NOT against
    // the old plaintext — i.e. the library actually re-hashed via Scrypt
    // rather than storing the plaintext.
    const verifiedNew = await new Scrypt().verify(newSecret, "brandnewpass");
    expect(verifiedNew).toBe(true);
    const verifiedOld = await new Scrypt().verify(newSecret, "originalpass");
    expect(verifiedOld).toBe(false);

    const updatedUser = await t.run(async (ctx) => ctx.db.get(userId));
    expect(updatedUser?.passwordResetPending).toBeUndefined();
  });

  test("invalidates existing sessions for the user on success", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUserWithFlag(t, {
      email: "u@example.com",
      passwordResetPending: true,
    });
    await seedPasswordAccount(t, userId, "u@example.com", "originalpass");

    // Seed an unrelated session for the user and one for a different user
    // to assert scoping.
    const otherUserId = await seedUserWithFlag(t, {
      email: "other@example.com",
    });
    const [keptForOther, killedForUser] = await t.run(async (ctx) => {
      const a = await ctx.db.insert("authSessions", {
        userId: otherUserId,
        expirationTime: Date.now() + 60_000,
      });
      const b = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 60_000,
      });
      return [a, b];
    });

    await t.action(api.auth.resetFlaggedPassword, {
      email: "u@example.com",
      newPassword: "brandnewpass",
    });

    const sessions = await t.run(async (ctx) => ({
      forUser: await ctx.db.get(killedForUser),
      forOther: await ctx.db.get(keptForOther),
    }));
    expect(sessions.forUser).toBeNull();
    expect(sessions.forOther).not.toBeNull();
  });

  test("is single-use: a second valid attempt after success throws", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUserWithFlag(t, {
      email: "u@example.com",
      passwordResetPending: true,
    });
    await seedPasswordAccount(t, userId, "u@example.com", "originalpass");

    await t.action(api.auth.resetFlaggedPassword, {
      email: "u@example.com",
      newPassword: "brandnewpass",
    });

    await expect(
      t.action(api.auth.resetFlaggedPassword, {
        email: "u@example.com",
        newPassword: "yetanotherpass",
      }),
    ).rejects.toThrow(/no reset pending/i);
  });
});
