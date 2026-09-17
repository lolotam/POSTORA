import DOMPurify from "dompurify";

const EMAIL_HTML_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ["style", "form", "input", "textarea", "button"],
  FORBID_ATTR: ["style"],
};

export function sanitizeEmailHtml(html: string): string {
  return DOMPurify.sanitize(html, EMAIL_HTML_CONFIG);
}
