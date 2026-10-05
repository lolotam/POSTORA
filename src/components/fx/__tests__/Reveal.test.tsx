import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Reveal } from "../Reveal";

type Callback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;

const original = window.IntersectionObserver;

function captureObserver() {
  const captured: { callback?: Callback; options?: IntersectionObserverInit } = {};
  window.IntersectionObserver = class {
    constructor(callback: Callback, options?: IntersectionObserverInit) {
      captured.callback = callback;
      captured.options = options;
    }
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof IntersectionObserver;
  return captured;
}

describe("Reveal", () => {
  afterEach(() => {
    window.IntersectionObserver = original;
  });

  // A ratio threshold is unreachable for a block taller than viewport/ratio, which
  // kept the whole Agent Setup form at opacity-0 on short screens.
  it("asks for any overlap rather than a share of the block's height", () => {
    const captured = captureObserver();
    render(<Reveal>content</Reveal>);
    expect(captured.options?.threshold).toBe(0);
  });

  it("reveals a tall block once any part of it intersects", () => {
    const captured = captureObserver();
    render(<Reveal>content</Reveal>);
    const block = screen.getByText("content");
    expect(block.className).toContain("opacity-0");

    act(() => captured.callback?.([{ isIntersecting: true, intersectionRatio: 0.05 }]));

    expect(block.className).toContain("opacity-100");
  });
});
