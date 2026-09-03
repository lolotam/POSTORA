import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuotaUsageBar } from "../QuotaUsageBar";

describe("QuotaUsageBar", () => {
  it("shows used / limit and the percent", () => {
    render(<QuotaUsageBar used={40} limit={100} />);
    expect(screen.getByText("40 / 100")).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.getByTestId("quota-bar")).toHaveAttribute("data-tone", "ok");
  });
  it("turns warning at 80% and critical at 95%", () => {
    const { rerender } = render(<QuotaUsageBar used={80} limit={100} />);
    expect(screen.getByTestId("quota-bar")).toHaveAttribute("data-tone", "warning");
    rerender(<QuotaUsageBar used={95} limit={100} />);
    expect(screen.getByTestId("quota-bar")).toHaveAttribute("data-tone", "critical");
  });
  it("shows only the count for an unlimited quota", () => {
    render(<QuotaUsageBar used={7} limit={null} />);
    expect(screen.getByText(/7 · unlimited/i)).toBeInTheDocument();
    expect(screen.queryByTestId("quota-bar")).not.toBeInTheDocument();
  });
});
