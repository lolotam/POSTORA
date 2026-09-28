import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MediaRetentionSection } from "../MediaRetentionSection";

const { eq, update, refreshProfile, toast } = vi.hoisted(() => {
  const eq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn(() => ({ eq }));
  return { eq, update, refreshProfile: vi.fn(), toast: vi.fn() };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { count?: number }, options?: { count?: number }) => {
      const template = typeof fallback === "string" ? fallback : key;
      const count = options?.count ?? (typeof fallback === "object" ? fallback.count : undefined);
      return count === undefined ? template : template.replace("{{count}}", String(count));
    },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    profile: { media_retention_days: 30 },
    refreshProfile,
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: () => ({ update }) },
}));

describe("MediaRetentionSection", () => {
  it("saves the selected retention on the profile and refreshes it", async () => {
    render(<MediaRetentionSection />);
    fireEvent.click(screen.getByRole("radio", { name: "7 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Save retention" }));
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ media_retention_days: 7 }));
    expect(eq).toHaveBeenCalledWith("id", "user-1");
    expect(refreshProfile).toHaveBeenCalled();
  });
});
