import {
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ADMIN_SUBJECT,
  OWNER_SUBJECT,
  RECONNECT_URL,
  buildAdminEmail,
  buildOwnerEmail,
  idempotencyKeyFor,
  sendDisconnectAlerts,
  type AdminProfile,
  type AlertAccount,
  type OwnerProfile,
  type SendAlertsDeps,
} from "./handler.ts";

const ACCOUNT: AlertAccount = {
  id: "acc-1",
  user_id: "user-1",
  platform_username: "Postora Store",
  platform_user_id: "96566600001",
};

const OWNER: OwnerProfile = {
  email: "owner@example.invalid",
  full_name: "Dr. Waleed",
  email_notifications_enabled: true,
};

const ADMINS: AdminProfile[] = [
  { email: "admin-one@example.invalid", full_name: "Admin One" },
  { email: "admin-two@example.invalid", full_name: "Admin Two" },
];

/** The episode the fake claim hands out. */
const EPISODE = "ep-1111-2222";

interface Recorder {
  calls: string[];
  sent: Array<{ to: string[]; subject: string; html: string; idempotencyKey: string }>;
  marks: Array<{ kind: string; episodeId: string }>;
}

/**
 * A recording fake. Every side effect the handler performs is observable through the call
 * order, so the tests assert behaviour rather than implementation.
 */
function fakeDeps(overrides: Partial<SendAlertsDeps> = {}): { deps: SendAlertsDeps; rec: Recorder } {
  const rec: Recorder = { calls: [], sent: [], marks: [] };
  const deps: SendAlertsDeps = {
    loadAccount: () => Promise.resolve(ACCOUNT),
    loadOwnerProfile: () => Promise.resolve(OWNER),
    loadAdmins: () => Promise.resolve(ADMINS),
    isGlobalEmailEnabled: () => Promise.resolve(true),
    isAdminAlertEnabled: () => Promise.resolve(true),
    claim: (_accountId, kind) => {
      rec.calls.push(`claim:${kind}`);
      return Promise.resolve(EPISODE);
    },
    send: (payload) => {
      rec.calls.push("send");
      rec.sent.push(payload);
      return Promise.resolve();
    },
    mark: (_accountId, kind, episodeId) => {
      rec.calls.push(`mark:${kind}`);
      rec.marks.push({ kind, episodeId });
      return Promise.resolve(true);
    },
    ...overrides,
  };
  return { deps, rec };
}

Deno.test("the owner email links to the reconnect page", () => {
  assertStringIncludes(buildOwnerEmail(ACCOUNT, OWNER.full_name), RECONNECT_URL);
  assertEquals(RECONNECT_URL, "https://postora.cloud/messaging/whatsapp/setup");
});

Deno.test("the owner email names the account", () => {
  assertStringIncludes(buildOwnerEmail(ACCOUNT, OWNER.full_name), "Postora Store");
});

Deno.test("the owner email carries no phone number", () => {
  const html = buildOwnerEmail(ACCOUNT, OWNER.full_name);
  assertFalse(html.includes("96566600001"));
});

Deno.test("the owner email escapes the account name", () => {
  const html = buildOwnerEmail({ ...ACCOUNT, platform_username: "<script>alert(1)</script>" }, null);
  assertFalse(html.includes("<script>alert(1)</script>"));
  assertStringIncludes(html, "&lt;script&gt;");
});

Deno.test("the admin email names the account and the owner", () => {
  const html = buildAdminEmail(ACCOUNT, OWNER.full_name);
  assertStringIncludes(html, "Postora Store");
  assertStringIncludes(html, "Dr. Waleed");
});

Deno.test("the admin email has no reconnect button: the page lists the reader's own accounts", () => {
  // An admin is not the account owner, so the WhatsApp setup page can never show the
  // affected account. A button there would promise an action it cannot perform.
  const html = buildAdminEmail(ACCOUNT, OWNER.full_name);
  assertFalse(html.includes(RECONNECT_URL));
  assertStringIncludes(html, "owner");
});

Deno.test("the admin email carries no phone number", () => {
  assertFalse(buildAdminEmail(ACCOUNT, OWNER.full_name).includes("96566600001"));
});

Deno.test("one owner email is sent when the owner has notifications enabled", async () => {
  const { deps, rec } = fakeDeps();

  const summary = await sendDisconnectAlerts(deps, "acc-1");

  const ownerSends = rec.sent.filter((payload) => payload.subject === OWNER_SUBJECT);
  assertEquals(ownerSends.length, 1);
  assertEquals(ownerSends[0].to, [OWNER.email]);
  assertEquals(summary.ownerSent, true);
});

Deno.test("no owner email is sent when the owner disabled notifications, but the admin email goes out", async () => {
  const { deps, rec } = fakeDeps({
    loadOwnerProfile: () => Promise.resolve({ ...OWNER, email_notifications_enabled: false }),
  });

  const summary = await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.sent.filter((payload) => payload.subject === OWNER_SUBJECT).length, 0);
  assertEquals(rec.sent.filter((payload) => payload.subject === ADMIN_SUBJECT).length, 1);
  assertEquals(summary.ownerSent, false);
  assertEquals(summary.adminSent, true);
});

Deno.test("the owner email is claimed before it is sent and marked after it", async () => {
  const { deps, rec } = fakeDeps();

  await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.calls.slice(0, 3), ["claim:user", "send", "mark:user"]);
});

Deno.test("the mark carries the episode the claim returned", async () => {
  const { deps, rec } = fakeDeps();

  await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.marks.map((m) => m.episodeId), [EPISODE, EPISODE]);
});

Deno.test("every send carries an idempotency key bound to the account, the episode and the recipient", async () => {
  const { deps, rec } = fakeDeps();

  await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.sent.length, 2);
  for (const payload of rec.sent) {
    assertStringIncludes(payload.idempotencyKey, "acc-1");
    assertStringIncludes(payload.idempotencyKey, EPISODE);
  }
  assertNotEquals(rec.sent[0].idempotencyKey, rec.sent[1].idempotencyKey);
  assertEquals(
    idempotencyKeyFor("acc-1", EPISODE, "user"),
    `whatsapp-disconnect:acc-1:${EPISODE}:user`,
  );
});

Deno.test("a retry of the same episode reuses the same idempotency key", async () => {
  const { deps, rec } = fakeDeps();

  await sendDisconnectAlerts(deps, "acc-1");
  const first = rec.sent[0].idempotencyKey;
  await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.sent[2].idempotencyKey, first);
});

Deno.test("nothing is sent when the claim is refused", async () => {
  const { deps, rec } = fakeDeps({ claim: () => Promise.resolve(null) });

  const summary = await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.sent.length, 0);
  assertEquals(summary.ownerSent, false);
  assertEquals(summary.adminSent, false);
});

Deno.test("the admin email goes to every admin in one recipient list", async () => {
  const { deps, rec } = fakeDeps();

  await sendDisconnectAlerts(deps, "acc-1");

  const adminSends = rec.sent.filter((payload) => payload.subject === ADMIN_SUBJECT);
  assertEquals(adminSends.length, 1);
  assertEquals(adminSends[0].to, ["admin-one@example.invalid", "admin-two@example.invalid"]);
});

Deno.test("no admin email is sent when the admin toggle is off", async () => {
  const { deps, rec } = fakeDeps({ isAdminAlertEnabled: () => Promise.resolve(false) });

  const summary = await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.sent.filter((payload) => payload.subject === ADMIN_SUBJECT).length, 0);
  assertEquals(summary.adminSent, false);
});

Deno.test("a failing owner send does not cost the admin its alert", async () => {
  const { deps, rec } = fakeDeps({
    send: (payload) => {
      rec.calls.push("send");
      rec.sent.push(payload);
      if (payload.subject === OWNER_SUBJECT) return Promise.reject(new Error("resend down"));
      return Promise.resolve();
    },
  });

  const summary = await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.sent.filter((payload) => payload.subject === ADMIN_SUBJECT).length, 1);
  assertEquals(summary.ownerSent, false);
  assertEquals(summary.adminSent, true);
  assertEquals(summary.failed, ["acc-1"]);
});

Deno.test("a failing owner profile lookup does not cost the admin its alert", async () => {
  const { deps, rec } = fakeDeps({
    loadOwnerProfile: () => Promise.reject(new Error("profiles unreachable")),
  });

  const summary = await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.sent.filter((payload) => payload.subject === OWNER_SUBJECT).length, 0);
  assertEquals(rec.sent.filter((payload) => payload.subject === ADMIN_SUBJECT).length, 1);
  assertEquals(summary.ownerSent, false);
  assertEquals(summary.adminSent, true);
  assertEquals(summary.failed, ["acc-1"]);
});

Deno.test("nothing is sent when the global email flag is off", async () => {
  const { deps, rec } = fakeDeps({ isGlobalEmailEnabled: () => Promise.resolve(false) });

  const summary = await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.sent.length, 0);
  assertEquals(summary.skipped, "email notifications disabled");
});

Deno.test("a missing account is skipped", async () => {
  const { deps, rec } = fakeDeps({ loadAccount: () => Promise.resolve(null) });

  const summary = await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(rec.sent.length, 0);
  assertEquals(summary.skipped, "account not found");
});
