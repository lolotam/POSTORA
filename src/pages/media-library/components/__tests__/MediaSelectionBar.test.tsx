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
});
