import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MediaSelectionBar } from "../MediaSelectionBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => (typeof fallback === "string" ? fallback : _key),
  }),
}));

describe("Keep forever bulk", () => {
  it("asks to keep every selected file", () => {
    const onKeepForever = vi.fn();
    render(
      <MediaSelectionBar
        selectedCount={2}
        totalCount={4}
        displayedCount={4}
        allSelectedAreImages={false}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onSendToPost={() => {}}
        onBatchRename={() => {}}
        onBatchImageTools={() => {}}
        onMove={() => {}}
        onDownload={() => {}}
        onDelete={() => {}}
        onKeepForever={onKeepForever}
        onAllowExpiry={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep forever" }));
    expect(onKeepForever).toHaveBeenCalledOnce();
  });

  it("hides Keep forever while viewing another user's library", () => {
    render(
      <MediaSelectionBar
        selectedCount={2}
        totalCount={4}
        displayedCount={4}
        allSelectedAreImages={false}
        onSelectAll={() => {}}
        onDeselectAll={() => {}}
        onSendToPost={() => {}}
        onBatchRename={() => {}}
        onBatchImageTools={() => {}}
        onMove={() => {}}
        onDownload={() => {}}
        onDelete={() => {}}
        onKeepForever={() => {}}
        onAllowExpiry={() => {}}
        showKeep={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Keep forever" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow expiry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });
});
