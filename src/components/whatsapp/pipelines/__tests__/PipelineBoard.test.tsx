import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PipelineBoard } from "../PipelineBoard";
import type { WhatsAppDeal, WhatsAppPipelineStage } from "@/hooks/useWhatsAppPipelines";

// The board is driven through the accessible "Move to stage" select rather than
// synthetic pointer events: @dnd-kit's drag sensors do not operate in jsdom, and
// that select is the behaviour we actually promise on touch and via the keyboard.
// fireEvent matches this repo's testing convention (the shared setup defines a
// non-configurable navigator.clipboard, which userEvent.setup cannot stub).

function stage(
  overrides: Partial<WhatsAppPipelineStage> & Pick<WhatsAppPipelineStage, "id" | "name">,
): WhatsAppPipelineStage {
  return {
    pipeline_id: "pipeline-1",
    workspace_id: "workspace-1",
    position: 0,
    stage_type: "open",
    color: "#3b82f6",
    created_at: "2026-07-26T00:00:00Z",
    updated_at: "2026-07-26T00:00:00Z",
    ...overrides,
  } as WhatsAppPipelineStage;
}

function deal(
  overrides: Partial<WhatsAppDeal> & Pick<WhatsAppDeal, "id" | "title" | "stage_id">,
): WhatsAppDeal {
  return {
    workspace_id: "workspace-1",
    pipeline_id: "pipeline-1",
    contact_id: "contact-1",
    conversation_cache_id: null,
    amount: 100,
    currency: "USD",
    status: "open",
    position: 0,
    assigned_to: null,
    created_by: "user-1",
    created_at: "2026-07-26T00:00:00Z",
    updated_at: "2026-07-26T00:00:00Z",
    contact: { id: "contact-1", display_name: "Acme Co", phone_number: "+96500000001" },
    conversation: null,
    ...overrides,
  } as WhatsAppDeal;
}

const NEW_LEAD = stage({ id: "stage-new", name: "New Lead", position: 0 });
const WON = stage({ id: "stage-won", name: "Won", position: 1, stage_type: "won" });

function moveControl(dealTitle: string) {
  return screen.getByLabelText(`Move ${dealTitle} to stage`);
}

describe("PipelineBoard", () => {
  it("renders one column per stage in position order", () => {
    render(<PipelineBoard stages={[NEW_LEAD, WON]} deals={[]} canWrite onMove={vi.fn()} />);

    expect(
      screen.getAllByRole("region").map((column) => column.getAttribute("aria-label")),
    ).toEqual(["New Lead stage", "Won stage"]);
  });

  it("moves a deal through the accessible control with no drag gesture", () => {
    const onMove = vi.fn();
    render(
      <PipelineBoard
        stages={[NEW_LEAD, WON]}
        deals={[deal({ id: "deal-1", title: "Renewal", stage_id: "stage-new" })]}
        canWrite
        onMove={onMove}
      />,
    );

    fireEvent.change(moveControl("Renewal"), { target: { value: "stage-won" } });

    expect(onMove).toHaveBeenCalledWith({
      dealId: "deal-1",
      sourceStageId: "stage-new",
      destinationStage: { id: "stage-won", stage_type: "won" },
      destinationIndex: 0,
    });
  });

  it("appends the deal after existing cards in the destination stage", () => {
    const onMove = vi.fn();
    render(
      <PipelineBoard
        stages={[NEW_LEAD, WON]}
        deals={[
          deal({ id: "deal-1", title: "Renewal", stage_id: "stage-new" }),
          deal({ id: "deal-2", title: "Existing won", stage_id: "stage-won" }),
        ]}
        canWrite
        onMove={onMove}
      />,
    );

    fireEvent.change(moveControl("Renewal"), { target: { value: "stage-won" } });

    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: "deal-1", destinationIndex: 1 }),
    );
  });

  it("does not offer the deal's own stage as a move target", () => {
    render(
      <PipelineBoard
        stages={[NEW_LEAD, WON]}
        deals={[deal({ id: "deal-1", title: "Renewal", stage_id: "stage-new" })]}
        canWrite
        onMove={vi.fn()}
      />,
    );

    const options = within(moveControl("Renewal") as HTMLSelectElement)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["Move to stage…", "Won"]);
  });

  it("disables moving for a read-only viewer", () => {
    render(
      <PipelineBoard
        stages={[NEW_LEAD, WON]}
        deals={[deal({ id: "deal-1", title: "Renewal", stage_id: "stage-new" })]}
        canWrite={false}
        onMove={vi.fn()}
      />,
    );

    expect(moveControl("Renewal")).toBeDisabled();
  });

  it("derives won styling from stage_type, not from the stage name", () => {
    // A stage NAMED "Won" but semantically open must not be treated as won. This
    // is the regression that matters: renaming a column cannot change outcomes.
    const namedWonButOpen = stage({
      id: "stage-decoy",
      name: "Won",
      position: 0,
      stage_type: "open",
    });
    const genuinelyWon = stage({
      id: "stage-real-won",
      name: "Closed",
      position: 1,
      stage_type: "won",
    });

    render(
      <PipelineBoard
        stages={[namedWonButOpen, genuinelyWon]}
        deals={[]}
        canWrite
        onMove={vi.fn()}
      />,
    );

    expect(screen.getByTestId("stage-column-stage-decoy").className).not.toContain("emerald");
    expect(screen.getByTestId("stage-column-stage-real-won").className).toContain("emerald");
  });

  it("shows the deal count per column", () => {
    render(
      <PipelineBoard
        stages={[NEW_LEAD, WON]}
        deals={[
          deal({ id: "deal-1", title: "One", stage_id: "stage-new" }),
          deal({ id: "deal-2", title: "Two", stage_id: "stage-new", position: 1 }),
        ]}
        canWrite
        onMove={vi.fn()}
      />,
    );

    expect(
      within(screen.getByTestId("stage-column-stage-new")).getByText("2"),
    ).toBeInTheDocument();
  });
});
