import fs from "node:fs";
import { it } from "vitest";

it("public/_headers does not allow clickjacking (no frame-ancestors *)", () => {
  const headers = fs.readFileSync("public/_headers", "utf8");

  if (/frame-ancestors\s+\*/i.test(headers)) {
    throw new Error(
      "public/_headers contains 'frame-ancestors *' — clickjacking vulnerability. " +
      "Must be restricted to 'self'.",
    );
  }

  if (/X-Frame-Options:\s*ALLOWALL/i.test(headers)) {
    throw new Error(
      "public/_headers contains 'X-Frame-Options: ALLOWALL' — allows embedding on any domain.",
    );
  }
});

it("public/_headers enforces restrictive frame-ancestors", () => {
  const headers = fs.readFileSync("public/_headers", "utf8");

  if (!/frame-ancestors\s+'self'/i.test(headers)) {
    throw new Error(
      "public/_headers must contain \"frame-ancestors 'self'\" to prevent clickjacking.",
    );
  }
});

it("public/_headers includes HSTS header", () => {
  const headers = fs.readFileSync("public/_headers", "utf8");

  if (!/Strict-Transport-Security:\s*max-age=/i.test(headers)) {
    throw new Error("public/_headers must include Strict-Transport-Security (HSTS) header.");
  }
});
