import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";
import { vi } from "vitest";

// `findBy*` and `waitFor` use testing-library's own timeout, which defaults to
// 1000ms and is not affected by vitest's testTimeout. The heaviest component
// tests drive Radix dialogs through react-query, and under full-suite CPU
// contention a query has not resolved within a second - so a different couple
// of files failed every run with "Unable to find role=..." while all of them
// passed in isolation.
//
// This waits longer for something that does arrive; it asserts nothing extra.
// An element that never renders still fails the test, just later.
configure({ asyncUtilTimeout: 10_000 });

// Mock matchMedia for responsive tests
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock IntersectionObserver
class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}

Object.defineProperty(window, "IntersectionObserver", {
  writable: true,
  value: MockIntersectionObserver,
});

// Mock ResizeObserver
class MockResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  unobserve = vi.fn();
}

Object.defineProperty(window, "ResizeObserver", {
  writable: true,
  value: MockResizeObserver,
});

// Mock scrollTo
Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: vi.fn(),
});

// jsdom implements neither of these, and Radix primitives call both while opening a popover
// or select. Without them any test that opens a shadcn Select throws from inside Radix's
// effects rather than from the component under test.
Object.defineProperty(Element.prototype, "scrollIntoView", {
  writable: true,
  value: vi.fn(),
});

for (const method of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  Object.defineProperty(Element.prototype, method, { writable: true, value: vi.fn() });
}

// Mock clipboard API
Object.defineProperty(navigator, "clipboard", {
  writable: true,
  value: {
    writeText: vi.fn().mockResolvedValue(undefined),
    readText: vi.fn().mockResolvedValue(""),
  },
});

// Suppress console errors in tests (optional)
// vi.spyOn(console, 'error').mockImplementation(() => {});
