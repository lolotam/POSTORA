import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RetentionBadge } from "../RetentionBadge";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { count?: number }, options?: { count?: number }) => {
      const template = typeof fallback === "string" ? fallback : key;
      const count = options?.count ?? (typeof fallback === "object" ? fallback.count : undefined);
      return count === undefined ? template : template.replace("{{count}}", String(count));
    },
  }),
}));

describe("RetentionBadge", () => {
  it("shows the paused wording when deletion is switched off", () => {
    render(
      <RetentionBadge
        expiresAt={new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString()}
        deletionPaused
        onKeep={() => {}}
      />,
    );
    expect(screen.getByText("Would be deleted — deletion paused by admin")).toBeInTheDocument();
  });

  it("Keep calls the keep handler", () => {
    const onKeep = vi.fn();
    render(
      <RetentionBadge
        expiresAt={new Date(Date.now() + 60 * 60 * 1000).toISOString()}
        deletionPaused={false}
        onKeep={onKeep}
      />,
    );
    expect(screen.getByText("Deletes in 1 days")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(onKeep).toHaveBeenCalledOnce();
  });
});