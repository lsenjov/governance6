// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Id } from "../../convex/_generated/dataModel";
import { AnnouncementsSection } from "./AnnouncementsSection";
import {
  announcementNoteLabel,
  formatAnnouncementOrdinal,
} from "../lib/announcementPresentation";

const convexMocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
}));

vi.mock("convex/react", () => convexMocks);
vi.mock("./NoteIcon", () => ({
  NoteIcon: ({ label }: { label: string }) => (
    <button type="button" aria-label={`Notes: ${label}`}>
      Notes
    </button>
  ),
}));

const GAME_ID = "game" as Id<"games">;
const ANNOUNCEMENT_ID = "announcement" as Id<"announcements">;

function renderSection(
  overrides: Partial<{
    gameState: "ready" | "playing" | "archived";
    viewerIsGm: boolean;
    hideManagementControls: boolean;
  }> = {},
) {
  return render(
    <AnnouncementsSection
      gameId={GAME_ID}
      gameState={overrides.gameState ?? "playing"}
      viewerIsGm={overrides.viewerIsGm ?? true}
      hideManagementControls={overrides.hideManagementControls ?? false}
      noteCounts={undefined}
    />,
  );
}

function announcementData(canManage: boolean) {
  return {
    canManage,
    announcements: [
      {
        _id: ANNOUNCEMENT_ID,
        body: "The first decree",
        createdAt: 1,
      },
    ],
  };
}

beforeEach(() => {
  convexMocks.useQuery.mockReset();
  convexMocks.useMutation.mockReset();
  convexMocks.useMutation.mockReturnValue(vi.fn().mockResolvedValue(null));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("announcement presentation helpers", () => {
  it("formats stable one-based ordinals", () => {
    expect(formatAnnouncementOrdinal(0)).toBe("ANN-01");
    expect(formatAnnouncementOrdinal(11)).toBe("ANN-12");
  });

  it("uses a bounded body excerpt for note labels", () => {
    expect(announcementNoteLabel(0, "Short directive")).toBe(
      "ANN-01: Short directive",
    );
    expect(announcementNoteLabel(1, `${"A".repeat(80)} trailing`)).toBe(
      `ANN-02: ${"A".repeat(80)}…`,
    );
  });
});

describe("AnnouncementsSection lifecycle", () => {
  it("does not query or render announcements for a Player in ready", () => {
    convexMocks.useQuery.mockReturnValue(undefined);
    const { container } = renderSection({
      gameState: "ready",
      viewerIsGm: false,
    });

    expect(container.innerHTML).toBe("");
    expect(convexMocks.useQuery).toHaveBeenCalledWith(
      expect.anything(),
      "skip",
    );
  });

  it("hides an empty section from Players after play begins", () => {
    convexMocks.useQuery.mockReturnValue({
      canManage: false,
      announcements: [],
    });
    const { container } = renderSection({
      gameState: "playing",
      viewerIsGm: false,
    });
    expect(container.innerHTML).toBe("");
  });

  it("renders archived announcements without management controls", () => {
    convexMocks.useQuery.mockReturnValue(announcementData(false));
    renderSection({ gameState: "archived" });

    expect(screen.getByText("The first decree")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Notes: ANN-01/ })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /New Announcement/ }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit ANN-01" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete ANN-01" })).toBeNull();
  });

  it("keeps content and notes visible when management controls are hidden", () => {
    convexMocks.useQuery.mockReturnValue(announcementData(true));
    renderSection({
      gameState: "playing",
      hideManagementControls: true,
    });

    expect(screen.getByText("The first decree")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Notes: ANN-01/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit ANN-01" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete ANN-01" })).toBeNull();
  });
});

describe("AnnouncementsSection actions", () => {
  it("submits a new announcement", async () => {
    const create = vi.fn().mockResolvedValue(null);
    convexMocks.useQuery.mockReturnValue({
      canManage: true,
      announcements: [],
    });
    convexMocks.useMutation.mockReturnValue(create);
    const user = userEvent.setup();
    renderSection({ gameState: "ready" });

    await user.click(
      screen.getByRole("button", { name: "+ New Announcement" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Announcement body" }),
      "A new directive",
    );
    await user.click(screen.getByRole("button", { name: "Issue" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith({
        gameId: GAME_ID,
        body: "A new directive",
      }),
    );
  });

  it("confirms deletion with attached-note consequences", async () => {
    const mutation = vi.fn().mockResolvedValue(null);
    convexMocks.useQuery.mockReturnValue(announcementData(true));
    convexMocks.useMutation.mockReturnValue(mutation);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Delete ANN-01" }));

    expect(confirm).toHaveBeenCalledWith(
      "Delete this announcement and all notes attached to it? This cannot be undone.",
    );
    expect(mutation).toHaveBeenCalledWith({
      announcementId: ANNOUNCEMENT_ID,
    });
  });

  it("announces mutation failures", async () => {
    const create = vi.fn().mockRejectedValue(new Error("Server rejected it."));
    convexMocks.useQuery.mockReturnValue({
      canManage: true,
      announcements: [],
    });
    convexMocks.useMutation.mockReturnValue(create);
    const user = userEvent.setup();
    renderSection();

    await user.click(
      screen.getByRole("button", { name: "+ New Announcement" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Announcement body" }),
      "Rejected",
    );
    await user.click(screen.getByRole("button", { name: "Issue" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Server rejected it.",
    );
  });
});
