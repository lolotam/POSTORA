import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { YouTubeCategorySelect } from "../YouTubeCategorySelect";

afterEach(cleanup);

const visibleText = () => screen.getByRole("combobox").textContent?.replace(/[\u2068\u2069]/g, "");

function open() {
  fireEvent.pointerDown(screen.getByRole("combobox"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

describe("YouTubeCategorySelect", () => {
  it("shows the stored category first and keeps non-assignable options disabled", async () => {
    render(
      <YouTubeCategorySelect
        value="22"
        onValueChange={vi.fn()}
        locale="en"
      />,
    );

    expect(visibleText()).toBe("22 (People & Blogs)");
    open();

    const options = await screen.findAllByRole("option");
    expect(options.length).toBeGreaterThan(10);
    const optionNamed = (text: string) => options.find(
      (option) => option.textContent?.replace(/[\u2068\u2069]/g, "") === text,
    )!;
    expect(optionNamed("30 (Movies)")).toHaveAttribute("data-disabled");
    expect(optionNamed("22 (People & Blogs)")).not.toHaveAttribute("data-disabled");
  });

  it("shows a preserved unlisted category with an unavailable label", () => {
    render(
      <YouTubeCategorySelect
        value="999"
        onValueChange={vi.fn()}
        locale="ar"
      />,
    );

    expect(visibleText()).toBe("999 (غير متاح حالياً)");
  });

  it("preserves the selection and offers retry when the catalog cannot load", () => {
    const onRetry = vi.fn();
    render(
      <YouTubeCategorySelect
        value="22"
        onValueChange={vi.fn()}
        locale="en"
        catalogUnavailable
        onRetry={onRetry}
        retryText="Retry catalog"
      />,
    );

    expect(screen.getByRole("combobox")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry catalog" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
