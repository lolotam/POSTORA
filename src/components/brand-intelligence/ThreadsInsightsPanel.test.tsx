import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18next from "@/i18n";
import { ThreadsInsightsPanel } from "./ThreadsInsightsPanel";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
// Supabase is the external boundary; the real component, reason handling and translations run.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  auth: { getUser: async () => ({ data: { user: null } }) },
  functions: { invoke },
} }));

afterEach(async () => {
  cleanup();
  await i18next.changeLanguage("en");
});
beforeEach(() => invoke.mockReset());

describe("Threads selection refusals", () => {
  it("clears the previous report when a changed period fails", async () => {
    invoke.mockResolvedValueOnce({ data: {
      ok: true, insights: { views: { value: 111, previous: 0, daily: [] } }, posts: [], username: "previous-account",
    }, error: null }).mockResolvedValueOnce({ data: null, error: {
      context: Response.json({ ok: false, reason: "storage_error" }, { status: 503 }),
    } });
    await i18next.changeLanguage("en");
    render(<ThreadsInsightsPanel />);
    expect(await screen.findByText("111", { exact: true })).toBeVisible();
    fireEvent.pointerDown(screen.getByRole("combobox"), { button: 0, ctrlKey: false, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("option", { name: "Last 14 days" }));
    expect(await screen.findByText("Unable to load the Threads account. Please retry.")).toBeVisible();
    expect(screen.queryByText("111", { exact: true })).not.toBeInTheDocument();
  });

  it.each([
    ["account_not_found", "The selected Threads account is unavailable.", "حساب Threads المختار غير متاح."],
    ["storage_error", "Unable to load the Threads account. Please retry.", "تعذّر تحميل حساب Threads. جرّب مرة أخرى."],
    ["invalid_request", "Invalid Threads insights request. Refresh the page and retry.", "طلب تحليلات Threads غير صالح. حدّث الصفحة وجرّب مرة أخرى."],
    ["unauthorized", "Your session could not be verified. Please sign in again.", "تعذّر التحقق من جلستك. سجّل الدخول مرة أخرى."],
    ["wrong_account", "Reconnect the selected Threads account.", "أعد ربط حساب Threads المختار."],
    ["expired_token", "Reconnect the selected Threads account.", "أعد ربط حساب Threads المختار."],
    ["rate_limited", "Threads request limit reached. Please retry later.", "وصلت طلبات Threads للحد المسموح. جرّب لاحقًا."],
    ["not_eligible", "The selected Threads account is not eligible for these insights.", "حساب Threads المختار غير مؤهل لهذه التحليلات."],
    ["not_found", "Threads could not find the requested account or content.", "لم يعثر Threads على الحساب أو المحتوى المطلوب."],
    ["transient", "Threads insights failed.", "فشل تحميل تحليلات Threads."],
  ])("renders localized %s instead of the backend fallback", async (reason, english, arabic) => {
    invoke.mockImplementation(async () => ({ data: null, error: {
      context: Response.json({ ok: false, reason, message: "Untranslated backend fallback" }, { status: 503 }),
    } }));
    await i18next.changeLanguage("ar");
    render(<ThreadsInsightsPanel />);
    expect(await screen.findByText(arabic)).toBeVisible();
    expect(screen.queryByText("Untranslated backend fallback")).not.toBeInTheDocument();
    cleanup();
    await i18next.changeLanguage("en");
    render(<ThreadsInsightsPanel />);
    expect(await screen.findByText(english)).toBeVisible();
  });
});
