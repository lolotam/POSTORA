import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { reportFixture } from "../../tests/reportFixture";
import { MetricsOverviewCards } from "../MetricsOverviewCards";

describe("account metric cards", () => {
  it("explains partial values and never labels daily reach sums as unique period reach", async () => {
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { analytics: {} } }, defaultNS: "analytics" });
    render(<I18nextProvider i18n={i18n}><MetricsOverviewCards report={reportFixture()} /></I18nextProvider>);
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("An exact period total is required for unique reach.")).toBeInTheDocument();
    expect(screen.getAllByText("Partial: 2 of 30 days")).toHaveLength(2);
    expect(screen.getByText("8.4K")).toBeInTheDocument();
    expect(screen.queryByText("3K")).not.toBeInTheDocument();
    expect(screen.queryByText(/impressions/i)).not.toBeInTheDocument();
  });
});
