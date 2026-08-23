import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import AdminPlanQuotas from "../AdminPlanQuotas";
import { usePlanQuotas } from "@/hooks/usePlanQuotas";

// R5 (CodeRabbit round 2, 2026-08-23): handleQuotaFieldChange() only wrote
// the parsed number into `formData` when validation passed. On an invalid
// keystroke, the controlled <Input value={formData.field ?? ""}> snapped
// back to the LAST VALID number while an error message appeared beside it -
// the admin could see the error, but not what they had actually typed, and
// had no way to see/correct the bad input in place.
//
// Fix: keep a raw string per field in form state (rawFieldValues), always
// render that string in the Input, validate it for the error message, and
// convert to a number only in handleSave().
//
// `type="number"` inputs blank a non-numeric string on `fireEvent.change`
// (jsdom mirrors real browser behaviour), so a bare "abc" proves nothing -
// the test vector below is a syntactically numeric but semantically invalid
// quota value (above the PostgreSQL `integer` max from R4), which DOES
// reach the input's DOM value.
const OUT_OF_RANGE_VALUE = "2147483648"; // INT32_MAX + 1, rejected by R4

vi.mock("@/components/admin/AdminLayout", () => ({
  AdminLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/hooks/usePlanQuotas", () => ({
  usePlanQuotas: vi.fn(),
}));

const PRO_PLAN = {
  id: "plan-pro",
  plan_slug: "pro",
  plan_name: "Pro",
  profile_limit: 15,
  max_social_accounts: 30,
  max_posts_per_month: 500,
  max_posts_per_day: 30,
  max_media_uploads_per_day: 500,
};

function createWrapper() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("AdminPlanQuotas raw quota input (R5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (usePlanQuotas as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      quotas: [PRO_PLAN],
      isLoading: false,
      updateQuota: { mutate: vi.fn(), isPending: false },
    });
  });

  it("keeps the admin's rejected keystroke visible in the field instead of snapping back to the old number", () => {
    const Wrapper = createWrapper();
    render(<AdminPlanQuotas />, { wrapper: Wrapper });

    // Open the edit dialog for the Pro plan.
    fireEvent.click(screen.getByRole("button", { name: "" })); // Edit icon button (no accessible name)

    const profileInput = screen.getByLabelText(/Social Profiles/i) as HTMLInputElement;
    expect(profileInput.value).toBe("15");

    fireEvent.change(profileInput, { target: { value: OUT_OF_RANGE_VALUE } });

    // The admin must still see exactly what they typed...
    expect(profileInput.value).toBe(OUT_OF_RANGE_VALUE);
    // ...alongside a visible error, not silently reverted to "15".
    expect(profileInput.value).not.toBe("15");
  });
});
