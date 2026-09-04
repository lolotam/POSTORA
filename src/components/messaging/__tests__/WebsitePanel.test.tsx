import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WebsitePanel } from "@/components/messaging/knowledge/WebsitePanel";

const setup = (submitting = false) => {
  const onSubmit = vi.fn();
  render(
    <WebsitePanel
      accountId="a1"
      selectedAccountLabel="Shop"
      submitting={submitting}
      onSubmit={onSubmit}
    />,
  );
  return onSubmit;
};

const typeUrl = (value: string) =>
  fireEvent.change(screen.getByLabelText(/website address/i), { target: { value } });

const start = () => fireEvent.click(screen.getByRole("button", { name: /start scraping/i }));

describe("WebsitePanel", () => {
  it("refuses an empty address before calling the server", () => {
    const onSubmit = setup();
    start();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/enter the address/i)).toBeInTheDocument();
  });

  it("refuses a non-https address before calling the server", () => {
    const onSubmit = setup();
    typeUrl("http://x.com");
    start();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/must start with https/i)).toBeInTheDocument();
  });

  it("submits a single page with the account scope", () => {
    const onSubmit = setup();
    typeUrl("https://x.com/shop");
    start();
    expect(onSubmit).toHaveBeenCalledWith({
      url: "https://x.com/shop",
      mode: "page",
      limit: 50,
      scope: "account",
    });
  });

  it("shows the page cap only for a whole-site crawl, and submits it", () => {
    // The cap is what the crawl is billed and bounded by, so it must not be
    // silently applied to a mode that cannot use it.
    const onSubmit = setup();
    expect(screen.queryByLabelText(/maximum pages/i)).not.toBeInTheDocument();

    const siteOption = screen.getByRole("radio", { name: /whole site/i });
    fireEvent.click(siteOption);
    fireEvent.change(screen.getByLabelText(/maximum pages/i), { target: { value: "120" } });
    typeUrl("https://x.com");
    start();

    expect(onSubmit).toHaveBeenCalledWith({
      url: "https://x.com",
      mode: "site",
      limit: 120,
      scope: "account",
    });
  });

  it("trims surrounding whitespace rather than failing on it", () => {
    const onSubmit = setup();
    typeUrl("  https://x.com  ");
    start();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ url: "https://x.com" }));
  });

  it("falls back to all accounts when no account is selected", () => {
    // A restricted source must name an account; with none selected the only
    // honest scope is shared, which is what the upload path already does.
    const onSubmit = vi.fn();
    render(
      <WebsitePanel accountId={null} selectedAccountLabel={null} submitting={false} onSubmit={onSubmit} />,
    );
    fireEvent.change(screen.getByLabelText(/website address/i), {
      target: { value: "https://x.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /start scraping/i }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ scope: "all" }));
  });
});
