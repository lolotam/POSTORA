import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { GradientHeading } from "@/components/fx/GradientHeading";

const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");

/** Custom properties declared inside the first `selector { ... }` block in index.css. */
function tokensOf(selector: string): Set<string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block missing from index.css`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("\n  }", start));
  return new Set([...body.matchAll(/--([\w-]+):/g)].map((m) => m[1]));
}

describe("design tokens", () => {
  // Light and dark are one system: switching modes may only swap colours. A token the
  // dark block forgets to override silently keeps its light value on a dark page.
  it("overrides every light colour token in dark mode", () => {
    const light = tokensOf(":root");
    const dark = tokensOf(".dark");
    const colour = (name: string) =>
      !name.startsWith("radius") &&
      !name.startsWith("gradient") &&
      name !== "shadow-glow" &&
      !/^(facebook|instagram|tiktok|twitter|linkedin|youtube|pinterest|threads|bluesky|reddit|whatsapp)/.test(name);
    const missing = [...light].filter(colour).filter((name) => !dark.has(name));
    expect(missing).toEqual([]);
  });

  it("no longer carries the admin-selected theme variants", () => {
    expect(css).not.toMatch(/data-dark-theme/);
    expect(css).not.toMatch(/data-app-theme/);
  });
});

describe("Button", () => {
  it.each(["gradient", "glow"] as const)("renders the legacy %s variant as the flat primary button", (variant) => {
    render(<Button variant={variant}>Go</Button>);
    const cls = screen.getByRole("button", { name: "Go" }).className;
    expect(cls).toContain("bg-primary");
    expect(cls).not.toMatch(/bg-gradient|shadow-/);
  });

  it("has no shadow on the default variant", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" }).className).not.toMatch(/shadow-/);
  });
});

describe("GradientHeading", () => {
  it("renders solid text in the requested heading level", () => {
    render(
      <GradientHeading as="h1" preset="sky-violet">
        Dashboard
      </GradientHeading>,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "Dashboard" });
    expect(heading.className).toContain("text-foreground");
    expect(heading.innerHTML).not.toMatch(/bg-clip-text|text-transparent/);
  });
});
