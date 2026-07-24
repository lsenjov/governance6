import { describe, expect, it } from "vitest";
import {
  announcementNoteLabel,
  formatAnnouncementOrdinal,
} from "../lib/announcementPresentation";

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
