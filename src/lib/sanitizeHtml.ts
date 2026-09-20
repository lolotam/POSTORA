import DOMPurify from "dompurify";

const EMAIL_HTML_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "textarea", "button"],
  FORBID_ATTR: ["style"],
};

export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, EMAIL_HTML_CONFIG);
}

/**
 * Escapes attacker-controlled *text* for interpolation into an HTML template.
 *
 * Not interchangeable with `sanitizeEmailHtml`: that one preserves markup, which
 * is right for a message body and wrong for a header field. A sender controls
 * their own display name and subject, so interpolating either one raw lets a
 * crafted `From:` inject markup into the compose editor even when the body
 * beside it has been sanitized.
 */
export function escapeHtmlText(value: string | null | undefined): string {
  // Regex rather than replaceAll: this project's TS lib target predates it.
  // The ampersand must be replaced first or the entities below get double-built.
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
