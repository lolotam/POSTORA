import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PinnedMessagesBar } from "./PinnedMessagesBar";

describe("PinnedMessagesBar", () => {
  it("scrolls to a loaded message and expands an unloaded one in place", () => {
    const onScrollTo = vi.fn();
    render(
      <PinnedMessagesBar
        pinned={[
          { message_row_id: "loaded", preview: "seen in thread", timestamp: "2026-08-25T12:00:00.000Z" },
          { message_row_id: "unloaded", preview: "only in the bar", timestamp: "2026-08-24T12:00:00.000Z" },
        ]}
        loadedIds={new Set(["loaded"])}
        onScrollTo={onScrollTo}
      />,
    );

    fireEvent.click(screen.getByText("seen in thread"));
    expect(onScrollTo).toHaveBeenCalledWith("loaded");
    expect(screen.queryByText("not loaded in this view")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("only in the bar"));
    expect(onScrollTo).not.toHaveBeenCalledWith("unloaded");
    expect(screen.getByText("not loaded in this view")).toBeInTheDocument();
  });
});
