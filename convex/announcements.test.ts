/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

function asUser(userId: Id<"users">) {
  return { subject: `${userId}|test-session`, issuer: "test" };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const gmId = await ctx.db.insert("users", { displayName: "GM" });
    const playerId = await ctx.db.insert("users", { displayName: "Player" });
    const outsiderId = await ctx.db.insert("users", {
      displayName: "Outsider",
    });
    const syndicateId = await ctx.db.insert("syndicates", {
      name: "Test Syndicate",
      leader: "Leader",
      description: "",
      played: false,
      isShared: false,
      ownerId: playerId,
    });
    const gameId = await ctx.db.insert("games", {
      name: "Test Game",
      gmId,
      state: "ready",
    });
    await ctx.db.insert("players", {
      gameId,
      userId: playerId,
      selectedSyndicateId: syndicateId,
      power: 0,
      joinedAt: 1,
    });
    return { gmId, playerId, outsiderId, gameId };
  });
  return { t, ids };
}

async function createAnnouncement(
  h: Harness,
  body: string,
): Promise<Id<"announcements">> {
  return await h.t
    .withIdentity(asUser(h.ids.gmId))
    .mutation(api.announcements.createAnnouncement, {
      gameId: h.ids.gameId,
      body,
    });
}

async function startGame(h: Harness) {
  await h.t
    .withIdentity(asUser(h.ids.gmId))
    .mutation(api.games.transitionState, {
      gameId: h.ids.gameId,
      target: "playing",
    });
}

async function archiveGame(h: Harness) {
  await h.t
    .withIdentity(asUser(h.ids.gmId))
    .mutation(api.games.transitionState, {
      gameId: h.ids.gameId,
      target: "archived",
    });
}

describe("announcements: writes", () => {
  test("GM can create in ready and playing", async () => {
    const h = await createHarness();
    await expect(createAnnouncement(h, "Ready bulletin")).resolves.toBeTruthy();
    await startGame(h);
    await expect(
      createAnnouncement(h, "Playing bulletin"),
    ).resolves.toBeTruthy();
  });

  test("non-GMs cannot create, update, or delete", async () => {
    const h = await createHarness();
    const announcementId = await createAnnouncement(h, "Original");

    for (const userId of [h.ids.playerId, h.ids.outsiderId]) {
      const actor = h.t.withIdentity(asUser(userId));
      await expect(
        actor.mutation(api.announcements.createAnnouncement, {
          gameId: h.ids.gameId,
          body: "Unauthorized",
        }),
      ).rejects.toThrow(/Game Master|participant/i);
      await expect(
        actor.mutation(api.announcements.updateAnnouncement, {
          announcementId,
          body: "Unauthorized",
        }),
      ).rejects.toThrow(/Game Master/i);
      await expect(
        actor.mutation(api.announcements.deleteAnnouncement, {
          announcementId,
        }),
      ).rejects.toThrow(/Game Master/i);
    }
  });

  test("bodies are trimmed and constrained to 1–2000 characters", async () => {
    const h = await createHarness();
    const announcementId = await createAnnouncement(h, "  Bulletin body  ");
    const stored = await h.t.run((ctx) => ctx.db.get(announcementId));
    expect(stored?.body).toBe("Bulletin body");

    await expect(createAnnouncement(h, "   ")).rejects.toThrow(/empty/i);
    await expect(createAnnouncement(h, "x".repeat(2001))).rejects.toThrow(
      /2000/,
    );
    await expect(
      h.t
        .withIdentity(asUser(h.ids.gmId))
        .mutation(api.announcements.updateAnnouncement, {
          announcementId,
          body: "\n\t",
        }),
    ).rejects.toThrow(/empty/i);
  });

  test("update preserves creation order and deletion removes the row", async () => {
    const h = await createHarness();
    const firstId = await createAnnouncement(h, "First");
    const secondId = await createAnnouncement(h, "Second");
    await h.t.run(async (ctx) => {
      await ctx.db.patch(firstId, { createdAt: 10 });
      await ctx.db.patch(secondId, { createdAt: 20 });
    });

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.announcements.updateAnnouncement, {
        announcementId: firstId,
        body: "First, revised",
      });

    const listed = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.announcements.listAnnouncementsForGame, {
        gameId: h.ids.gameId,
      });
    expect(listed.announcements.map(({ body }) => body)).toEqual([
      "First, revised",
      "Second",
    ]);

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.announcements.deleteAnnouncement, {
        announcementId: firstId,
      });
    expect(await h.t.run((ctx) => ctx.db.get(firstId))).toBeNull();
  });

  test("archived games reject create, update, and delete", async () => {
    const h = await createHarness();
    const announcementId = await createAnnouncement(h, "Preserved");
    await archiveGame(h);
    const gm = h.t.withIdentity(asUser(h.ids.gmId));

    await expect(
      gm.mutation(api.announcements.createAnnouncement, {
        gameId: h.ids.gameId,
        body: "Too late",
      }),
    ).rejects.toThrow(/archived/i);
    await expect(
      gm.mutation(api.announcements.updateAnnouncement, {
        announcementId,
        body: "Too late",
      }),
    ).rejects.toThrow(/archived/i);
    await expect(
      gm.mutation(api.announcements.deleteAnnouncement, {
        announcementId,
      }),
    ).rejects.toThrow(/archived/i);
  });
});

describe("announcements: visibility", () => {
  test("ready announcements are GM-only", async () => {
    const h = await createHarness();
    await createAnnouncement(h, "Secret until play");

    const gmView = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.announcements.listAnnouncementsForGame, {
        gameId: h.ids.gameId,
      });
    expect(gmView.announcements).toHaveLength(1);
    expect(gmView.canManage).toBe(true);

    await expect(
      h.t
        .withIdentity(asUser(h.ids.playerId))
        .query(api.announcements.listAnnouncementsForGame, {
          gameId: h.ids.gameId,
        }),
    ).rejects.toThrow(/only visible.*Game Master/i);
  });

  test("participants can read during playing and archived", async () => {
    const h = await createHarness();
    await createAnnouncement(h, "Public during play");
    await startGame(h);

    const player = h.t.withIdentity(asUser(h.ids.playerId));
    const playing = await player.query(
      api.announcements.listAnnouncementsForGame,
      { gameId: h.ids.gameId },
    );
    expect(playing.announcements[0]?.body).toBe("Public during play");
    expect(playing.canManage).toBe(false);

    await archiveGame(h);
    const archived = await player.query(
      api.announcements.listAnnouncementsForGame,
      { gameId: h.ids.gameId },
    );
    expect(archived.announcements).toHaveLength(1);
    expect(archived.canManage).toBe(false);

    const gmArchived = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.announcements.listAnnouncementsForGame, {
        gameId: h.ids.gameId,
      });
    expect(gmArchived.canManage).toBe(false);
  });

  test("non-participants cannot list announcements", async () => {
    const h = await createHarness();
    await startGame(h);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.outsiderId))
        .query(api.announcements.listAnnouncementsForGame, {
          gameId: h.ids.gameId,
        }),
    ).rejects.toThrow(/participant/i);
  });
});
