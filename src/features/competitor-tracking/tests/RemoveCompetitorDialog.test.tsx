import { describe, expect, it, vi, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import analyticsAr from "@/i18n/locales/ar/analytics.json";
import { RemoveCompetitorDialog } from "../ui/RemoveCompetitorDialog";

/**
 * The removal confirmation is a DECISION, not a click.
 *
 * These tests assert that the dialog names the handle, explains what
 * the removal does, keeps the safe action as the default, and stays
 * open with the reason when the removal does not succeed.
 */

beforeAll(async () => {
  if (i18next.isInitialized) return;
  await i18next.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    ns: ["analytics"],
    defaultNS: "analytics",
    resources: {
      en: { analytics: {} },
      ar: { analytics: analyticsAr },
    },
    interpolation: { escapeValue: false },
  });
});

type DialogProps = Parameters<typeof RemoveCompetitorDialog>[0];

function renderDialog(overrides: Partial<DialogProps> = {}) {
  const props: DialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    username: "northwind",
    onConfirm: vi.fn(),
    ...overrides,
  };

  const result = render(<RemoveCompetitorDialog {...props} />);

  return { ...result, props };
}

describe("RemoveCompetitorDialog", () => {
  it("names the handle and explains what the removal does", async () => {
    renderDialog();

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Remove @northwind?");
    expect(dialog).toHaveTextContent(
      "Collection stops and a slot is freed. History is kept for 90 days, then eligible for cleanup.",
    );
  });

  it("puts the focus on Cancel so the safe action is the default", async () => {
    renderDialog();

    const dialog = await screen.findByRole("alertdialog");
    const cancel = screen.getByRole("button", { name: "Cancel" });

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toBe(cancel);
  });

  it("does not remove anything when the owner cancels", async () => {
    const { props } = renderDialog();

    await screen.findByRole("alertdialog");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and the reason visible while the removal is in flight", async () => {
    const { props } = renderDialog({ isPending: true });

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Removing");
    expect(screen.getByRole("button", { name: "Removing" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Removing" }));
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows the reason when the removal fails", async () => {
    renderDialog({ errorMessage: "Something went wrong." });

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Something went wrong.");
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong.");
    expect(screen.getByRole("button", { name: "Remove" })).not.toBeDisabled();
  });

  it("says the outcome could not be confirmed when the removal is indeterminate", async () => {
    renderDialog({ indeterminate: true });

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Could not confirm the change. Reload to check.");
  });

  it("asks for the removal once when the owner confirms", async () => {
    const { props } = renderDialog();

    await screen.findByRole("alertdialog");
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    // The dialog is NOT closed by the button: only a confirmed removal
    // closes it, so a failure can keep the reason on screen.
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
