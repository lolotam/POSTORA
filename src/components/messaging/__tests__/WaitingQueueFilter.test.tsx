import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { WaitingQueueFilter } from "@/components/messaging/human-agent/WaitingQueueFilter";
import { emptyQueueCopy, resolveQueueFilter, type Platform, type QueueFilter } from "@/components/messaging/human-agent/queueFilter";

const onChange = vi.fn();

const counts: Record<Platform, number> = { facebook: 3, instagram: 2, whatsapp: 7 };

function renderFilter(props: { platforms: Platform[]; value: QueueFilter }) {
  return render(
    <WaitingQueueFilter
      platforms={props.platforms}
      counts={counts}
      totalCount={12}
      value={props.value}
      onChange={onChange}
    />,
  );
}

describe("resolveQueueFilter", () => {
  it("returns 'all' unchanged", () => {
    expect(resolveQueueFilter("all", ["facebook", "whatsapp"])).toBe("all");
  });

  it("keeps a platform that still has a connected account", () => {
    expect(resolveQueueFilter("whatsapp", ["facebook", "whatsapp"])).toBe("whatsapp");
  });

  it("falls back to 'all' for a platform with no connected account", () => {
    expect(resolveQueueFilter("instagram", ["facebook", "whatsapp"])).toBe("all");
    expect(resolveQueueFilter("instagram", [])).toBe("all");
  });
});

describe("emptyQueueCopy", () => {
  it("reassures only when the whole queue is empty", () => {
    expect(emptyQueueCopy("all", 0)).toEqual({
      title: "Nothing waiting",
      subtitle: "All conversations are either claimed or handled by auto-reply.",
    });
  });

  it("does not claim everything is handled while other platforms have a backlog", () => {
    // Filtered to Instagram with nothing on it, but 5 still waiting elsewhere:
    // telling the agent everything is handled would send them away from real work.
    expect(emptyQueueCopy("instagram", 5)).toEqual({
      title: "Nothing waiting on Instagram",
      subtitle: "Other platforms still have conversations waiting.",
    });
  });

  it("names the filtered platform with brand casing", () => {
    expect(emptyQueueCopy("whatsapp", 0).title).toBe("Nothing waiting on WhatsApp");
  });
});

describe("WaitingQueueFilter", () => {
  beforeEach(() => onChange.mockReset());

  afterEach(async () => {
    cleanup();
    // House pattern: finish Radix timer work in this jsdom realm before
    // Vitest replaces its CustomEvent constructor.
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  });

  it("renders nothing when fewer than two platforms have connected accounts", () => {
    const one = renderFilter({ platforms: ["whatsapp"], value: "all" });
    expect(one.container).toBeEmptyDOMElement();

    const none = renderFilter({ platforms: [], value: "all" });
    expect(none.container).toBeEmptyDOMElement();
  });

  it("renders an All chip plus one chip per platform, each showing its count", () => {
    renderFilter({ platforms: ["facebook", "instagram", "whatsapp"], value: "all" });

    expect(screen.getByRole("button", { name: "All 12" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Facebook 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Instagram 2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "WhatsApp 7" })).toBeInTheDocument();
  });

  it("exposes the chips as a labelled toggle group, not tabs", () => {
    renderFilter({ platforms: ["facebook", "whatsapp"], value: "all" });

    expect(screen.getByRole("group", { name: "Filter waiting queue by platform" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("calls onChange with the platform of the clicked chip", () => {
    renderFilter({ platforms: ["facebook", "instagram", "whatsapp"], value: "all" });

    fireEvent.click(screen.getByRole("button", { name: "WhatsApp 7" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("whatsapp");
  });

  it("presses only the active chip", () => {
    renderFilter({ platforms: ["facebook", "instagram", "whatsapp"], value: "instagram" });

    expect(screen.getByRole("button", { name: "Instagram 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All 12" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Facebook 3" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "WhatsApp 7" })).toHaveAttribute("aria-pressed", "false");
  });

  it("presses All when the selected platform no longer has a connected account", () => {
    // A disconnected account must never leave the pressed chip on a platform
    // that is not rendered — there would be no chip to click to clear it.
    renderFilter({ platforms: ["facebook", "whatsapp"], value: "instagram" });

    expect(screen.getByRole("button", { name: "All 12" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Facebook 3" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "WhatsApp 7" })).toHaveAttribute("aria-pressed", "false");
  });
});
