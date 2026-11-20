import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { YouTubeResourceNotice } from "../YouTubeResourceNotice";

async function renderUi(ui: ReactElement) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
  return render(<MemoryRouter><I18nextProvider i18n={i18n}>{ui}</I18nextProvider></MemoryRouter>);
}

describe("YouTubeResourceNotice", () => {
  it.each([
    ["reconnect_required", "This channel needs to be reconnected before Postora can read it."],
    ["missing_scope", "Postora does not have permission to read this channel. Reconnect it and allow viewing your YouTube account."],
    ["provider_unsupported", "This channel is connected through the managed connector, which does not support browsing yet."],
    ["quota_exceeded", "YouTube's daily limit for Postora is used up. It resets at midnight Pacific Time."],
    ["not_found", "YouTube could not find this content for the connected channel."],
    ["upstream_unavailable", "YouTube did not answer. Nothing was changed."],
  ] as const)("explains %s in its own words", async (code, message) => {
    await renderUi(<YouTubeResourceNotice code={code} retryAfterSeconds={null} onRetry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
  });

  it("tells a rate limited user how long to wait", async () => {
    await renderUi(<YouTubeResourceNotice code="rate_limited" retryAfterSeconds={120} onRetry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Too many requests. Try again in about 2 min.");
  });

  it("links to Profiles when a reconnect fixes it and offers no retry", async () => {
    await renderUi(<YouTubeResourceNotice code="reconnect_required" retryAfterSeconds={null} onRetry={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Open Profiles" })).toHaveAttribute("href", "/profiles");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers a retry only for a transient failure", async () => {
    const onRetry = vi.fn();
    await renderUi(<YouTubeResourceNotice code="upstream_unavailable" retryAfterSeconds={null} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("explains an expired session without offering a retry", async () => {
    await renderUi(<YouTubeResourceNotice code="unauthorized" retryAfterSeconds={null} onRetry={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your session expired. Sign in again or reload the page.");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("offers to reload a changed list when the cursor is stale", async () => {
    const onRetry = vi.fn();
    await renderUi(<YouTubeResourceNotice code="invalid_cursor" retryAfterSeconds={null} onRetry={onRetry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The list changed on YouTube's side. Load it again from the beginning.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
