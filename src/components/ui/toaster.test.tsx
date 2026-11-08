import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { toast } from "@/hooks/use-toast";
import { Toaster } from "./toaster";

afterEach(cleanup);

describe("social platform notifications", () => {
  it.each(["ltr", "rtl"])("keeps the platform left of the message in %s and preserves its link", (dir) => {
    render(<div dir={dir}><Toaster /></div>);
    act(() => {
      toast({ platform: "instagram", title: "Published to Instagram", description: <a href="https://example.com/post">View post</a> });
    });
    const title = screen.getByText("Published to Instagram");
    const content = title.parentElement!;
    const row = content.parentElement!;
    expect(row.getAttribute("dir")).toBe("ltr");
    expect(row.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    expect(row.firstElementChild?.querySelector("svg")).not.toBeNull();
    expect(row.lastElementChild).toBe(content);
    expect(screen.getByRole("link", { name: "View post" }).getAttribute("href")).toBe("https://example.com/post");
    expect(row.closest("[platform]")).toBeNull();
  });

  it("does not invent a platform icon for a generic notification", () => {
    render(<Toaster />);
    act(() => { toast({ title: "Saved", description: "Settings updated" }); });
    const content = screen.getByText("Saved").parentElement!;
    expect(content.parentElement?.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByText("Settings updated")).toBeTruthy();
  });
});
