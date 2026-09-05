import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { validateKnowledgeUrl } from "./knowledgeUrl.ts";

Deno.test("accepts a plain https URL and returns it normalised", () => {
  assertEquals(validateKnowledgeUrl("https://xsellpoint.com/shop"), {
    ok: true,
    url: "https://xsellpoint.com/shop",
  });
});

Deno.test("strips the fragment, which the server never sees anyway", () => {
  assertEquals(validateKnowledgeUrl("https://xsellpoint.com/shop#reviews"), {
    ok: true,
    url: "https://xsellpoint.com/shop",
  });
});

Deno.test("keeps the query string, which selects the page", () => {
  assertEquals(validateKnowledgeUrl("https://xsellpoint.com/p?id=7"), {
    ok: true,
    url: "https://xsellpoint.com/p?id=7",
  });
});

Deno.test("rejects http", () => {
  assertEquals(validateKnowledgeUrl("http://xsellpoint.com").ok, false);
});

Deno.test("rejects every non-http scheme", () => {
  for (const raw of ["file:///etc/passwd", "ftp://x.com", "javascript:alert(1)", "data:text/html,x"]) {
    assertEquals(validateKnowledgeUrl(raw).ok, false, raw);
  }
});

Deno.test("rejects credentials embedded in the URL", () => {
  assertEquals(validateKnowledgeUrl("https://user:pass@xsellpoint.com").ok, false);
  assertEquals(validateKnowledgeUrl("https://user@xsellpoint.com").ok, false);
});

Deno.test("rejects loopback, private, link-local and metadata hosts", () => {
  for (
    const host of [
      "localhost",
      "127.0.0.1",
      "127.1.2.3",
      "0.0.0.0",
      "10.1.2.3",
      "192.168.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.169.254",
      "[::1]",
      "[fd00::1]",
      "[fc00::1]",
      "internal",
      "db.local",
      "api.internal",
    ]
  ) {
    assertEquals(validateKnowledgeUrl(`https://${host}/x`).ok, false, host);
  }
});

Deno.test("accepts a public address just outside each private range", () => {
  // The boundaries, written down rather than assumed: 172.15 and 172.32 are
  // public, 11.x is public, and 169.253 is not link-local.
  for (const host of ["172.15.0.1", "172.32.0.1", "11.0.0.1", "169.253.0.1"]) {
    assertEquals(validateKnowledgeUrl(`https://${host}/x`).ok, true, host);
  }
});

Deno.test("rejects a non-string and an unparseable string", () => {
  assertEquals(validateKnowledgeUrl(42).ok, false);
  assertEquals(validateKnowledgeUrl(null).ok, false);
  assertEquals(validateKnowledgeUrl("").ok, false);
  assertEquals(validateKnowledgeUrl("not a url").ok, false);
});

Deno.test("rejects a URL longer than 2048 characters", () => {
  assertEquals(validateKnowledgeUrl(`https://x.com/${"a".repeat(2100)}`).ok, false);
});

Deno.test("every rejection carries a reason a user can act on", () => {
  const result = validateKnowledgeUrl("http://xsellpoint.com");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason.includes("https"), true);
});
