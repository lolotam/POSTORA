import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RescheduleWhatsAppDialog } from "./WhatsAppScheduleDialogs";

const translate = vi.hoisted(() => (
  key: string,
  fallback?: string | Record<string, unknown>,
  options?: Record<string, unknown>,
) => {
  const template = typeof fallback === "string" ? fallback : key;
  const vars = typeof fallback === "string" ? options : fallback;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

describe("reschedule dialog wall clock", () => {
  it("refuses a spring-forward gap and accepts a real local time", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const onConfirm = vi.fn();
      render(
        <RescheduleWhatsAppDialog
          open
          recipientLabel="Clinic"
          scheduledAt="2026-06-15T15:00:00.000Z"
          pending={false}
          onOpenChange={vi.fn()}
          onConfirm={onConfirm}
        />,
      );
      const input = screen.getByLabelText("Date and time");
      fireEvent.change(input, { target: { value: "2026-03-08T02:30" } });
      fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
      expect(onConfirm).not.toHaveBeenCalled();
      expect(screen.getByRole("alert")).toHaveTextContent("That time does not exist on the selected day.");

      fireEvent.change(input, { target: { value: "2026-03-08T10:30" } });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
      const chosen = new Date(onConfirm.mock.calls[0][0] as string);
      expect(chosen.getFullYear()).toBe(2026);
      expect(chosen.getMonth()).toBe(2);
      expect(chosen.getDate()).toBe(8);
      expect(chosen.getHours()).toBe(10);
      expect(chosen.getMinutes()).toBe(30);
    } finally {
      process.env.TZ = previous;
    }
  });
});
