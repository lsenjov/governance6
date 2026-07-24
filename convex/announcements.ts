import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireGameGm, requireGameParticipant } from "./lib/auth";

const BODY_MAX = 2000;

function validateBody(raw: string): string {
  const body = raw.trim();
  if (body.length === 0) {
    throw new Error("Announcement body must not be empty.");
  }
  if (body.length > BODY_MAX) {
    throw new Error(
      `Announcement body must be at most ${BODY_MAX} characters.`,
    );
  }
  return body;
}

async function requireWritableGame(
  ctx: MutationCtx,
  gameId: Id<"games">,
): Promise<Doc<"games">> {
  const game = await requireGameGm(ctx, gameId);
  if (game.state === "archived") {
    throw new Error("Announcements cannot be modified in an archived game.");
  }
  return game;
}

export const createAnnouncement = mutation({
  args: {
    gameId: v.id("games"),
    body: v.string(),
  },
  handler: async (ctx, args): Promise<Id<"announcements">> => {
    const game = await requireWritableGame(ctx, args.gameId);
    return await ctx.db.insert("announcements", {
      gameId: game._id,
      body: validateBody(args.body),
      createdAt: Date.now(),
      createdByUserId: game.gmId,
    });
  },
});

export const updateAnnouncement = mutation({
  args: {
    announcementId: v.id("announcements"),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const announcement = await ctx.db.get(args.announcementId);
    if (!announcement) throw new Error("Announcement not found.");
    await requireWritableGame(ctx, announcement.gameId);
    await ctx.db.patch(announcement._id, { body: validateBody(args.body) });
  },
});

export const deleteAnnouncement = mutation({
  args: { announcementId: v.id("announcements") },
  handler: async (ctx, args) => {
    const announcement = await ctx.db.get(args.announcementId);
    if (!announcement) throw new Error("Announcement not found.");
    await requireWritableGame(ctx, announcement.gameId);

    const notes = await ctx.db
      .query("notes")
      .withIndex("by_announcement", (q) =>
        q.eq("targetAnnouncementId", announcement._id),
      )
      .collect();
    for (const note of notes) await ctx.db.delete(note._id);

    await ctx.db.delete(announcement._id);
  },
});

export type AnnouncementRow = {
  _id: Id<"announcements">;
  body: string;
  createdAt: number;
};

export const listAnnouncementsForGame = query({
  args: { gameId: v.id("games") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    announcements: AnnouncementRow[];
    canManage: boolean;
  }> => {
    const { game, role } = await requireGameParticipant(ctx, args.gameId);
    if (game.state === "ready" && role !== "gm") {
      throw new Error(
        "Announcements are only visible to the Game Master before play begins.",
      );
    }

    const announcements = await ctx.db
      .query("announcements")
      .withIndex("by_game_createdAt", (q) => q.eq("gameId", args.gameId))
      .order("asc")
      .collect();

    return {
      announcements: announcements.map((announcement) => ({
        _id: announcement._id,
        body: announcement.body,
        createdAt: announcement.createdAt,
      })),
      canManage: role === "gm" && game.state !== "archived",
    };
  },
});
