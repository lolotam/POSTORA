import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CalendarGrid } from "@/components/calendar/CalendarGrid";
import { DayDetailDialog } from "@/components/calendar/DayDetailDialog";
import { buildCalendarEntries, toWhatsAppCardModel, type ScheduledWhatsAppSource } from "@/features/scheduled/domain/scheduledBoard";
import { WhatsAppScheduledCard } from "@/features/scheduled/ui/WhatsAppScheduledCard";

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

const PHONE = "96550001111";

function source(status: string, id = status): ScheduledWhatsAppSource {
  return {
    id,
    recipient_phone: PHONE,
    recipient_name: null,
    message_text: "Bring the file",
    media_url: "https://cdn.example/visit.pdf",
    media_type: "document",
    media_filename: null,
    scheduled_at: "2026-09-30T15:00:00.000Z",
    status,
    account_name: "Clinic",
    avatar_url: null,
  };
}

function htmlHasPhone(container: HTMLElement): boolean {
  return container.innerHTML.includes(PHONE);
}

describe("WhatsApp scheduled surfaces", () => {
  it("shows reschedule and cancel only for a pending card", () => {
    const pending = toWhatsAppCardModel(source("pending"), "WhatsApp account");
    const { rerender, container } = render(
      <WhatsAppScheduledCard model={pending} overdue={false} onReschedule={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Reschedule" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByText("•••• 1111")).toBeInTheDocument();
    expect(screen.getByText("visit.pdf")).toBeInTheDocument();
    expect(htmlHasPhone(container)).toBe(false);

    rerender(
      <WhatsAppScheduledCard
        model={toWhatsAppCardModel(source("sending"), "WhatsApp account")}
        overdue={false}
        onReschedule={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reschedule" })).not.toBeInTheDocument();
    expect(htmlHasPhone(container)).toBe(false);
  });

  it("keeps the full number out of calendar chips, including the accessible name", () => {
    const entries = buildCalendarEntries(
      [{
        id: "post-1",
        caption: "Launch",
        platforms: ["instagram"],
        scheduled_at: "2026-09-30T15:00:00.000Z",
        status: "scheduled",
        media_file_ids: null,
      }],
      [source("pending", "wa-pending"), source("sending", "wa-sending")],
      "WhatsApp account",
    );
    const onDragStart = vi.fn();
    const { container } = render(
      <CalendarGrid
        currentMonth={new Date(2026, 8, 1)}
        entries={entries}
        draggedId={null}
        onDragStart={onDragStart}
        onDragOver={vi.fn()}
        onDrop={vi.fn()}
        onDayClick={vi.fn()}
      />,
    );
    const chips = screen.getAllByLabelText("WhatsApp, •••• 1111");
    const pendingChip = chips.find((chip) => chip.getAttribute("draggable") === "true");
    const lockedChips = chips.filter((chip) => chip.getAttribute("draggable") === "false");
    expect(pendingChip).toBeTruthy();
    expect(lockedChips).toHaveLength(1);
    fireEvent.dragStart(pendingChip!);
    expect(onDragStart).toHaveBeenCalledWith(expect.objectContaining({ kind: "whatsapp", id: "wa-pending" }));
    onDragStart.mockClear();
    fireEvent.dragStart(lockedChips[0]);
    expect(onDragStart).not.toHaveBeenCalled();
    const postChip = container.querySelector("[draggable='true']:not([aria-label])");
    expect(postChip).not.toBeNull();
    fireEvent.dragStart(postChip!);
    expect(onDragStart).toHaveBeenCalledWith(expect.objectContaining({ kind: "post", id: "post-1" }));
    expect(htmlHasPhone(container)).toBe(false);

    render(
      <DayDetailDialog
        open
        onOpenChange={vi.fn()}
        selectedDate={new Date("2026-09-30T15:00:00.000Z")}
        entries={entries}
        onRescheduleWhatsApp={vi.fn()}
        onCancelWhatsApp={vi.fn()}
      />,
    );
    expect(screen.getAllByText("•••• 1111").length).toBeGreaterThan(0);
    expect(document.body.innerHTML).not.toContain(PHONE);
  });
});
