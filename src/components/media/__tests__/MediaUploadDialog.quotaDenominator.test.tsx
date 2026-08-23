import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MediaUploadDialog } from "../MediaUploadDialog";

// I2 (2026-08-23 final review): the dialog used to read the raw
// user_quotas row (`quota?.max_media_uploads_per_day ?? 20`), a hardcoded
// free-tier literal that ignores any plan edit and any per-user override.
// Post-backfill the raw column is normally NULL (inherit), so this denied
// every upload dialog the wrong denominator the moment an admin edited the
// plan's uploads/day away from 20. It must read the already-resolved
// planLimits value from useQuotas() instead.

const useQuotasMock = vi.fn();
vi.mock("@/hooks/useQuotas", () => ({
  useQuotas: () => useQuotasMock(),
}));

vi.mock("@/hooks/useMediaOperationsHistory", () => ({
  useLogMediaOperation: () => ({
    logOperation: vi.fn(),
    completeOperation: vi.fn(),
    failOperation: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

describe("MediaUploadDialog — quota denominator", () => {
  it("shows the resolved plan limit, not the hardcoded free default of 20, when the raw override is NULL", () => {
    // The normal post-backfill shape: user_quotas.max_media_uploads_per_day
    // is NULL (inherit), and the admin has edited the plan's uploads/day
    // down to 10 via /admin/plan-quotas. resolvePlanLimits() already
    // resolves this correctly into planLimits — the bug was the dialog
    // ignoring it.
    useQuotasMock.mockReturnValue({
      canUploadMedia: vi.fn().mockResolvedValue({ allowed: true }),
      incrementMediaUpload: vi.fn(),
      quota: {
        max_media_uploads_per_day: null,
        media_uploads_today: 3,
      },
      planLimits: {
        max_profiles: 2,
        max_social_accounts: 3,
        max_posts_per_month: 30,
        max_posts_per_day: 2,
        max_media_uploads_per_day: 10,
      },
    });

    render(
      <MemoryRouter>
        <MediaUploadDialog
          open={true}
          onClose={() => {}}
          currentFolder="/"
          onUploadComplete={() => {}}
        />
      </MemoryRouter>,
    );

    // 10 (plan limit) - 3 (used) = 7 remaining. The old hardcoded-20 bug
    // would render 17.
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.queryByText("17")).not.toBeInTheDocument();
  });
});
