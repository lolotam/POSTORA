import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PostCard } from "../PostCard";
import { HistoryTable } from "../HistoryTable";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }) }));

const noop = () => {};

describe("partial publication badges", () => {
  for (const status of ["failed", "pending"] as const) {
    it.each(["card", "table"])(`%s does not show green success when the Story is ${status}`, (view) => {
      const post = {
        id: "post", caption: "caption", platforms: ["instagram"], status: "completed",
        created_at: "2026-11-08T09:11:47Z",
        platformResults: [
          { id: "reel", platform: "instagram", social_account_id: "account", status: "success", response_data: { ig_post_subtype: "reel" } },
          { id: "story", platform: "instagram", social_account_id: "account", status, response_data: { ig_post_subtype: "story" } },
        ],
      };
      const shared = { accountsCache: {}, onToggleSelection: noop, onViewDetails: noop, onRetryFailed: noop, onRetryWithMedia: noop, onDelete: noop };
      render(view === "card"
        ? <PostCard {...shared} post={post} isSelected={false} isRetrying={false} hasTikTokMediaError={false} />
        : <HistoryTable {...shared} posts={[post]} selectedPosts={new Set<string>()} retryingPostId={null} onSelectAll={noop} onDeselectAll={noop} isTikTokMediaError={() => false} />);
      const label = status === "failed" ? "Partially published — some items failed" : "Partially published — some items pending";
      const badge = screen.getByText(label);
      expect(badge).toHaveClass(status === "failed" ? "text-destructive" : "text-amber-400");
      expect(badge).not.toHaveClass("text-emerald-400");
      expect(badge.querySelector("svg")).toBeInTheDocument();
      expect(badge.querySelector("svg")).toHaveClass(status === "failed" ? "lucide-circle-x" : "lucide-circle-alert");
    });
  }
});
