import { describe, it, expect } from "vitest";
import { sanitizeEmailHtml, escapeHtmlText } from "../sanitizeHtml";

/**
 * Regression guard for the forward/reply XSS path (PR #180 review, 2026-09-20).
 *
 * `MessageDetail` sanitized the body it *displayed* but handed the raw
 * `html_body` to `onForward`. `ComposeEmail` interpolated that into its
 * forwarded-message template and `RichTextEditor` assigned the result to
 * `innerHTML`, so an inbound email could execute script in an admin's browser
 * the moment they clicked Forward. The header fields were interpolated raw on
 * the same path, which made a crafted `From:` an injection point of its own.
 */
describe("sanitizeEmailHtml", () => {
  it.each([
    ['<img src=x onerror="alert(1)">', "onerror"],
    ['<a href="javascript:alert(1)">x</a>', "javascript:"],
    ["<script>alert(1)</script>", "<script"],
    ['<svg><animate onbegin="alert(1)" /></svg>', "onbegin"],
    ['<iframe src="https://evil.test"></iframe>', "<iframe"],
  ])("strips the executable part of %s", (payload, forbidden) => {
    expect(sanitizeEmailHtml(payload).toLowerCase()).not.toContain(forbidden.toLowerCase());
  });

  it("keeps ordinary formatting so a forwarded email stays readable", () => {
    const clean = sanitizeEmailHtml("<p>Hello <strong>there</strong></p>");
    expect(clean).toContain("<strong>");
    expect(clean).toContain("Hello");
  });
});

describe("escapeHtmlText", () => {
  it("renders a crafted sender name as text instead of markup", () => {
    // A sender controls their own display name, so this reaches the compose
    // template as a header field, where sanitizing markup is not enough.
    expect(escapeHtmlText('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
    );
  });

  it("escapes the ampersand first so no entity is double-built", () => {
    expect(escapeHtmlText("&lt;")).toBe("&amp;lt;");
  });

  it.each([
    [null, ""],
    [undefined, ""],
  ])("renders %s as empty rather than the literal word", (value, expected) => {
    expect(escapeHtmlText(value)).toBe(expected);
  });
});
