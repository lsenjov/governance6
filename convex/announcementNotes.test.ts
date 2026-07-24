/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { MAX_ANNOUNCEMENT_NOTES } from "./lib/announcements";

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
    return { gmId, playerId, outsiderId, syndicateId, gameId };
  });
  const announcementId = await t
    .withIdentity(asUser(ids.gmId))
    .mutation(api.announcements.createAnnouncement, {
      gameId: ids.gameId,
      body: "The first decree",
    });
  return { t, ids: { ...ids, announcementId } };
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

async function createAnnouncementNote(
  h: Harness,
  actor: Id<"users">,
  body: string,
  visibility: "private" | "public" = "public",
): Promise<Id<"notes">> {
  return await h.t.withIdentity(asUser(actor)).mutation(api.notes.createNote, {
    gameId: h.ids.gameId,
    targetKind: "announcement",
    targetAnnouncementId: h.ids.announcementId,
    body,
    visibility,
  });
}

describe("announcement notes: lifecycle visibility", () => {
  test("only the GM can create or target-list announcement notes in ready", async () => {
    const h = await createHarness();
    await createAnnouncementNote(h, h.ids.gmId, "GM preparation note");

    const gmRows = await h.t
      .withIdentity(asUser(h.ids.gmId))
      .query(api.notes.listNotesForTarget, {
        gameId: h.ids.gameId,
        targetKind: "announcement",
        targetAnnouncementId: h.ids.announcementId,
      });
    expect(gmRows.map(({ body }) => body)).toEqual(["GM preparation note"]);

    await expect(
      createAnnouncementNote(h, h.ids.playerId, "Premature note"),
    ).rejects.toThrow(/only visible.*Game Master/i);
    await expect(
      h.t
        .withIdentity(asUser(h.ids.playerId))
        .query(api.notes.listNotesForTarget, {
          gameId: h.ids.gameId,
          targetKind: "announcement",
          targetAnnouncementId: h.ids.announcementId,
        }),
    ).rejects.toThrow(/only visible.*Game Master/i);
  });

  test("ready Players receive the same secrecy error for every announcement id", async () => {
    const h = await createHarness();
    const { deletedId, foreignId } = await h.t.run(async (ctx) => {
      const deletedId = await ctx.db.insert("announcements", {
        gameId: h.ids.gameId,
        body: "Deleted",
        createdAt: 2,
        createdByUserId: h.ids.gmId,
      });
      await ctx.db.delete(deletedId);
      const otherGameId = await ctx.db.insert("games", {
        gmId: h.ids.gmId,
        state: "ready",
      });
      const foreignId = await ctx.db.insert("announcements", {
        gameId: otherGameId,
        body: "Foreign",
        createdAt: 3,
        createdByUserId: h.ids.gmId,
      });
      return { deletedId, foreignId };
    });
    const player = h.t.withIdentity(asUser(h.ids.playerId));
    const ids = [h.ids.announcementId, deletedId, foreignId];

    for (const targetAnnouncementId of ids) {
      await expect(
        player.mutation(api.notes.createNote, {
          gameId: h.ids.gameId,
          targetKind: "announcement",
          targetAnnouncementId,
          body: "Probe",
        }),
      ).rejects.toThrow(
        "Announcements are only visible to the Game Master before play begins.",
      );
      await expect(
        player.query(api.notes.listNotesForTarget, {
          gameId: h.ids.gameId,
          targetKind: "announcement",
          targetAnnouncementId,
        }),
      ).rejects.toThrow(
        "Announcements are only visible to the Game Master before play begins.",
      );
    }
  });

  test("ready announcement notes are absent from player drawer and counts", async () => {
    const h = await createHarness();
    await createAnnouncementNote(h, h.ids.gmId, "Hidden public note", "public");
    const player = h.t.withIdentity(asUser(h.ids.playerId));

    const drawerRows = await player.query(api.notes.listGameNotes, {
      gameId: h.ids.gameId,
    });
    expect(drawerRows).toEqual([]);

    const counts = await player.query(api.notes.getNoteCountsForGameView, {
      gameId: h.ids.gameId,
    });
    expect(counts.byAnnouncement[h.ids.announcementId] ?? 0).toBe(0);
  });

  test("players can create and read announcement notes in playing and archived", async () => {
    const h = await createHarness();
    await createAnnouncementNote(h, h.ids.gmId, "Public GM note", "public");
    await startGame(h);
    await createAnnouncementNote(h, h.ids.playerId, "Player note", "private");

    const player = h.t.withIdentity(asUser(h.ids.playerId));
    const playingRows = await player.query(api.notes.listNotesForTarget, {
      gameId: h.ids.gameId,
      targetKind: "announcement",
      targetAnnouncementId: h.ids.announcementId,
    });
    expect(playingRows.map(({ body }) => body).sort()).toEqual([
      "Player note",
      "Public GM note",
    ]);

    await archiveGame(h);
    await expect(
      createAnnouncementNote(h, h.ids.playerId, "Archived note"),
    ).resolves.toBeTruthy();
    const archivedRows = await player.query(api.notes.listNotesForTarget, {
      gameId: h.ids.gameId,
      targetKind: "announcement",
      targetAnnouncementId: h.ids.announcementId,
    });
    expect(archivedRows).toHaveLength(3);
  });
});

describe("announcement notes: target integrity and projection", () => {
  test("the announcement id is required and sibling target ids are rejected", async () => {
    const h = await createHarness();
    const gm = h.t.withIdentity(asUser(h.ids.gmId));

    await expect(
      gm.mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "announcement",
        body: "Missing target",
      }),
    ).rejects.toThrow(/targetAnnouncementId/i);
    await expect(
      gm.mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "announcement",
        targetAnnouncementId: h.ids.announcementId,
        targetSyndicateId: h.ids.syndicateId,
        body: "Conflicting targets",
      }),
    ).rejects.toThrow(/no other target/i);
  });

  test("an announcement from another game is rejected", async () => {
    const h = await createHarness();
    const otherAnnouncementId = await h.t.run(async (ctx) => {
      const otherGameId = await ctx.db.insert("games", {
        gmId: h.ids.gmId,
        state: "ready",
      });
      return await ctx.db.insert("announcements", {
        gameId: otherGameId,
        body: "Other game",
        createdAt: 1,
        createdByUserId: h.ids.gmId,
      });
    });

    await expect(
      h.t.withIdentity(asUser(h.ids.gmId)).mutation(api.notes.createNote, {
        gameId: h.ids.gameId,
        targetKind: "announcement",
        targetAnnouncementId: otherAnnouncementId,
        body: "Cross-game note",
      }),
    ).rejects.toThrow(/not in this game/i);
  });

  test("counts and drawer rows include announcement context after play starts", async () => {
    const h = await createHarness();
    const longBody = `${"A".repeat(80)} trailing text`;
    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.announcements.updateAnnouncement, {
        announcementId: h.ids.announcementId,
        body: longBody,
      });
    await createAnnouncementNote(h, h.ids.gmId, "Attached", "public");
    await startGame(h);

    const player = h.t.withIdentity(asUser(h.ids.playerId));
    const counts = await player.query(api.notes.getNoteCountsForGameView, {
      gameId: h.ids.gameId,
    });
    expect(counts.byAnnouncement[h.ids.announcementId]).toBe(1);

    const drawerRows = await player.query(api.notes.listGameNotes, {
      gameId: h.ids.gameId,
    });
    expect(drawerRows).toHaveLength(1);
    expect(drawerRows[0].targetKind).toBe("announcement");
    expect(drawerRows[0].targetAnnouncementId).toBe(h.ids.announcementId);
    expect(drawerRows[0].announcementExcerpt).toBe(`${"A".repeat(80)}…`);
  });

  test("deleting an announcement cascades its notes", async () => {
    const h = await createHarness();
    const noteId = await createAnnouncementNote(h, h.ids.gmId, "Disposable");

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.announcements.deleteAnnouncement, {
        announcementId: h.ids.announcementId,
      });

    const stored = await h.t.run(async (ctx) => ({
      announcement: await ctx.db.get(h.ids.announcementId),
      note: await ctx.db.get(noteId),
    }));
    expect(stored).toEqual({ announcement: null, note: null });
  });

  test("the note cap keeps a maximum-size deletion transaction bounded", async () => {
    const h = await createHarness();
    await h.t.run(async (ctx) => {
      for (let index = 0; index < MAX_ANNOUNCEMENT_NOTES; index += 1) {
        await ctx.db.insert("notes", {
          gameId: h.ids.gameId,
          targetKind: "announcement",
          targetAnnouncementId: h.ids.announcementId,
          authorUserId: h.ids.gmId,
          visibility: "private",
          body: `Note ${index}`,
          createdAt: index,
        });
      }
    });

    await expect(
      createAnnouncementNote(h, h.ids.gmId, "Over the limit"),
    ).rejects.toThrow(new RegExp(`${MAX_ANNOUNCEMENT_NOTES} notes`));

    await h.t
      .withIdentity(asUser(h.ids.gmId))
      .mutation(api.announcements.deleteAnnouncement, {
        announcementId: h.ids.announcementId,
      });
    const remaining = await h.t.run((ctx) =>
      ctx.db
        .query("notes")
        .withIndex("by_announcement", (q) =>
          q.eq("targetAnnouncementId", h.ids.announcementId),
        )
        .take(1),
    );
    expect(remaining).toEqual([]);
  });
});
