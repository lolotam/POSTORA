import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { INVITATION_ACCEPT_URL, invitationEmailHtml } from "./index.ts";

// The invitation link shipped broken: it pointed at
// /settings?workspace_invitation_token=..., but the accept page is registered at
// /workspace/invite and reads a `token` parameter. Nothing in the frontend has
// ever read `workspace_invitation_token`, so every invitee landed on Settings and
// their token was silently ignored.
//
// Neither existing suite could catch it — the frontend tests mock the backend and
// the backend tests mock the email — so these assertions pin the contract that
// spans both. If the route or parameter name ever moves, this fails loudly.

Deno.test("the acceptance link targets the route the frontend registers", () => {
  assertStringIncludes(INVITATION_ACCEPT_URL, "/workspace/invite");
  assertEquals(
    INVITATION_ACCEPT_URL.includes("workspace_invitation_token"),
    false,
    "no frontend route reads workspace_invitation_token",
  );
  assertEquals(
    INVITATION_ACCEPT_URL.includes("/settings"),
    false,
    "Settings does not handle invitation tokens",
  );
});

Deno.test("the acceptance link uses the query parameter WorkspaceInvite reads", () => {
  // src/pages/WorkspaceInvite.tsx: searchParams.get("token")
  assertStringIncludes(INVITATION_ACCEPT_URL, "?token=");
});

Deno.test("the email embeds the raw token in a usable acceptance link", () => {
  const html = invitationEmailHtml({
    to: "invitee@example.test",
    workspaceName: "Acme",
    rawToken: "abc123",
  });
  assertStringIncludes(html, "https://postora.cloud/workspace/invite?token=abc123");
});

Deno.test("the email percent-encodes a token containing URL-significant characters", () => {
  const html = invitationEmailHtml({
    to: "invitee@example.test",
    workspaceName: "Acme",
    rawToken: "a+b/c=d&e",
  });
  assertStringIncludes(html, "token=a%2Bb%2Fc%3Dd%26e");
  assertEquals(
    html.includes("token=a+b/c=d&e"),
    false,
    "an unencoded token would truncate at the first & and break acceptance",
  );
});

Deno.test("the workspace name is escaped so it cannot inject markup", () => {
  const html = invitationEmailHtml({
    to: "invitee@example.test",
    workspaceName: '<img src=x onerror="alert(1)">',
    rawToken: "tok",
  });
  assertEquals(
    html.includes('<img src=x onerror="alert(1)">'),
    false,
    "a workspace name must not be injected into the email as live markup",
  );
  assertStringIncludes(html, "&lt;img");
});
