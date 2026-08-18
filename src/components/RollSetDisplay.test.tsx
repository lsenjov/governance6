// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RollSetDisplay } from "./RollSetDisplay";

afterEach(cleanup);

describe("RollSetDisplay", () => {
  it("presents a missing roll set as unavailable instead of pending", () => {
    render(<RollSetDisplay rolls={null} />);

    expect(screen.getByLabelText("Rolls unavailable")).toBeTruthy();
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    expect(screen.queryByText("Pending")).toBeNull();
  });
});
