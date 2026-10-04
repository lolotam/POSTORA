import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { GradientHeading } from "@/components/fx/GradientHeading";
import { GradientRingCard } from "@/components/fx/GradientRingCard";
import { Icon3D } from "@/components/fx/Icon3D";
import { GradientDivider } from "@/components/fx/GradientDivider";
import { Send } from "lucide-react";

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

describe("flat fx primitives", () => {
  it("renders Icon3D as a neutral tile with no gradient", () => {
    const { container } = render(<Icon3D icon={Send} variant="violet" />);
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.className).toContain("bg-secondary");
    expect(container.innerHTML).not.toMatch(/bg-gradient|text-white/);
  });

  it("marks the active GradientRingCard with a foreground border instead of a halo", () => {
    const { container } = render(
      <GradientRingCard variant="sky" active>
        x
      </GradientRingCard>,
    );
    expect(container.innerHTML).toContain("border-foreground");
    expect(container.innerHTML).not.toMatch(/bg-gradient|blur/);
  });

  it("renders GradientDivider as a plain hairline", () => {
    const { container } = render(<GradientDivider tone="rose" />);
    expect((container.firstElementChild as HTMLElement).className).toContain("bg-border");
  });
});

/** Every production .tsx file under src, skipping tests. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return full.endsWith(".tsx") && !full.includes(".test.") ? [full] : [];
  });
}

describe("flat design guard", () => {
  const files = sourceFiles(resolve(__dirname, "../.."));

  // Gradient text and frosted glass were the two signatures of the old look; they crept in
  // one component at a time, so the guard scans the whole tree rather than a few pages.
  it.each([
    ["gradient text", /bg-clip-text/],
    ["frosted glass", /backdrop-blur/],
  ])("has no %s left in any component", (_label, pattern) => {
    const offenders = files.filter((file) => pattern.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("geometry guard", () => {
  const files = sourceFiles(resolve(__dirname, "../.."));
  const matches = (pattern: RegExp) =>
    files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(pattern)].map((m) => `${file}: ${m[0]}`));

  // A class-deduplication pass once collapsed repeated numbers outside class names too,
  // turning viewBox="0 0 24 24" into "0 24" and inset(0 0 0 x) into inset(0 0 x).
  it("gives every SVG viewBox four numbers", () => {
    const bad = matches(/viewBox="([^"]*)"/g).filter((hit) => {
      const value = hit.slice(hit.indexOf('"') + 1, -1);
      return value.trim().split(/[\s,]+/).length !== 4;
    });
    expect(bad).toEqual([]);
  });

  it("gives every clip-path inset() four values", () => {
    const bad = matches(/inset\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g).filter((hit) => {
      const inner = hit.slice(hit.indexOf("inset(") + 6, -1).replace(/\$\{[^}]*\}%?/g, "X");
      return inner.trim().split(/\s+/).length !== 4;
    });
    expect(bad).toEqual([]);
  });
});
