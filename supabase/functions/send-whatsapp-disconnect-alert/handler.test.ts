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
  type AlertPayload,
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

/** How long a claim stays live. The RPC retakes a claim only once it went stale. */
const CLAIM_STALE_MS = 30 * 60 * 1000;

/** The claim state of one recipient, exactly what the claim RPC keeps on the row. */
interface RecipientState {
  episodeId: string;
  claimedAt: number;
  marked: boolean;
  /** The payload the first claim stored. The RPC keeps it for the whole episode. */
  payload: AlertPayload | null;
}

/**
 * A recording fake. Every side effect the handler performs is observable through the call
 * order, so the tests assert behaviour rather than implementation.
 *
 * The claim and the mark are ONE state machine per recipient, because that is what the
 * claim RPC is: a marked recipient is never claimed again, a live claim blocks a second
 * one, and only a stale claim is retaken. A fake that always hands out an episode would
 * let a test pass that the real RPC refuses.
 */
function fakeDeps(overrides: Partial<SendAlertsDeps> = {}): {
  deps: SendAlertsDeps;
  rec: Recorder;
  advance: (ms: number) => void;
} {
  const rec: Recorder = { calls: [], sent: [], marks: [] };
  const state = new Map<string, RecipientState>();
  let clock = 0;

  const deps: SendAlertsDeps = {
    loadAccount: () => Promise.resolve(ACCOUNT),
    loadOwnerProfile: () => Promise.resolve(OWNER),
    loadAdmins: () => Promise.resolve(ADMINS),
    isGlobalEmailEnabled: () => Promise.resolve(true),
    isAdminAlertEnabled: () => Promise.resolve(true),
    claim: (accountId, kind, payload) => {
      rec.calls.push(`claim:${kind}`);
      const key = `${accountId}:${kind}`;
      const current = state.get(key);
      if (!current) {
        // The first claim of the episode stores the payload: the RPC keeps it for the
        // whole episode, so the body under the idempotency key never changes.
        state.set(key, { episodeId: EPISODE, claimedAt: clock, marked: false, payload });
        return Promise.resolve({ episodeId: EPISODE, payload });
      }
      // Already emailed for this episode: the RPC refuses.
      if (current.marked) return Promise.resolve(null);
      // A live claim blocks another one; only a stale claim is retaken.
      if (clock - current.claimedAt < CLAIM_STALE_MS) return Promise.resolve(null);
      current.claimedAt = clock;
      // A retake answers with the stored payload, never with a rebuilt one.
      return Promise.resolve({ episodeId: current.episodeId, payload: current.payload });
    },
    send: (payload) => {
      rec.calls.push("send");
      rec.sent.push(payload);
      return Promise.resolve();
    },
    mark: (accountId, kind, episodeId) => {
      rec.calls.push(`mark:${kind}`);
      rec.marks.push({ kind, episodeId });
      const current = state.get(`${accountId}:${kind}`);
      // A mark without a live claim, or for another episode, writes nothing.
      if (!current || current.episodeId !== episodeId || current.marked) {
        return Promise.resolve(false);
      }
      current.marked = true;
      return Promise.resolve(true);
    },
    ...overrides,
  };
  return { deps, rec, advance: (ms: number) => void (clock += ms) };
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

Deno.test("a phone number inside a longer display name is removed and the shop name stays", () => {
  const account: AlertAccount = {
    ...ACCOUNT,
    platform_username: "Postora Store 96566600001",
  };

  const ownerHtml = buildOwnerEmail(account, OWNER.full_name);
  const adminHtml = buildAdminEmail(account, "Waleed +965 6660-0001");

  assertStringIncludes(ownerHtml, "Postora Store");
  assertStringIncludes(adminHtml, "Postora Store");
  assertStringIncludes(adminHtml, "Waleed");
  assertFalse(ownerHtml.includes("96566600001"));
  assertFalse(adminHtml.includes("96566600001"));
  assertFalse(adminHtml.includes("6660-0001"));
  assertFalse(adminHtml.includes("+965"));
});

Deno.test("a display name that is only a formatted phone becomes the generic label", () => {
  const account: AlertAccount = { ...ACCOUNT, platform_username: "+965 6660-0001" };

  const html = buildOwnerEmail(account, OWNER.full_name);

  assertFalse(html.includes("6660"));
  assertFalse(html.includes("965"));
  assertStringIncludes(html, "WhatsApp");
});

Deno.test("phone-only profile fields use generic labels in both emails", () => {
  for (const phone of ["96566600001", "+965 6660-0001", "(965) 6660.0001"]) {
    const account = { ...ACCOUNT, platform_username: phone };
    const ownerHtml = buildOwnerEmail(account, phone);
    const adminHtml = buildAdminEmail(account, phone);
    assertStringIncludes(ownerHtml, "Hi there,");
    assertStringIncludes(adminHtml, "of a Postora user");
    assertStringIncludes(ownerHtml, "<strong>WhatsApp</strong>");
    assertFalse(ownerHtml.includes(phone));
    assertFalse(adminHtml.includes(phone));
  }
});

Deno.test("neither email carries the phone number when the account name IS the phone number", () => {
  // A WhatsApp row whose display name was never set stores the number in
  // platform_username, and platform_user_id holds the same digits. Naming the account
  // would put the owner's number in both emails, so the generic label is used.
  const account: AlertAccount = { ...ACCOUNT, platform_username: "96566600001" };

  const ownerHtml = buildOwnerEmail(account, OWNER.full_name);
  const adminHtml = buildAdminEmail(account, OWNER.full_name);

  assertFalse(ownerHtml.includes("96566600001"));
  assertFalse(adminHtml.includes("96566600001"));
  assertStringIncludes(ownerHtml, "WhatsApp");
  assertStringIncludes(adminHtml, "WhatsApp");
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

Deno.test("a marked recipient is never emailed twice", async () => {
  // The claim RPC refuses a recipient that was already emailed for this episode, so
  // the second run sends nothing at all. A fake that always handed out an episode
  // would hide exactly this.
  const { deps, rec } = fakeDeps();

  await sendDisconnectAlerts(deps, "acc-1");
  const firstRun = rec.sent.length;
  await sendDisconnectAlerts(deps, "acc-1");

  assertEquals(firstRun, 2);
  assertEquals(rec.sent.length, 2);
});

Deno.test("a stale claim that was never marked is retaken with the same idempotency key", async () => {
  // A crash between the send and the mark leaves the claim open. The live claim
  // blocks the next run, and once it went stale the recipient can be claimed again.
  // The key is the same either way, so the provider sends the same email instead of
  // a second copy.
  let ownerSendFails = true;
  const { deps, rec, advance } = fakeDeps({
    send: (payload) => {
      rec.calls.push("send");
      rec.sent.push(payload);
      if (ownerSendFails && payload.subject === OWNER_SUBJECT) {
        return Promise.reject(new Error("resend down"));
      }
      return Promise.resolve();
    },
  });

  await sendDisconnectAlerts(deps, "acc-1");
  const first = rec.sent[0].idempotencyKey;

  // The claim is still live: the owner is not emailed again.
  await sendDisconnectAlerts(deps, "acc-1");
  assertEquals(rec.sent.filter((payload) => payload.subject === OWNER_SUBJECT).length, 1);

  advance(CLAIM_STALE_MS + 1);
  ownerSendFails = false;
  await sendDisconnectAlerts(deps, "acc-1");

  const ownerSends = rec.sent.filter((payload) => payload.subject === OWNER_SUBJECT);
  assertEquals(ownerSends.length, 2);
  assertEquals(ownerSends[1].idempotencyKey, first);
});

Deno.test("a retake after a stale claim sends the payload the first claim stored", async () => {
  // The provider's idempotency key belongs to the episode and the recipient, so the body
  // under that key must never change. The account name and the admin list may well have
  // changed while the claim was live: the retake sends the ORIGINAL body, and the
  // rebuilt one is the body that must not go out.
  let sendsFail = true;
  let account: AlertAccount = ACCOUNT;
  let admins: AdminProfile[] = ADMINS;
  const { deps, rec, advance } = fakeDeps({
    loadAccount: () => Promise.resolve(account),
    loadAdmins: () => Promise.resolve(admins),
    send: (payload) => {
      rec.calls.push("send");
      rec.sent.push(payload);
      if (sendsFail) return Promise.reject(new Error("resend down"));
      return Promise.resolve();
    },
  });

  await sendDisconnectAlerts(deps, "acc-1");
  const firstOwner = rec.sent[0];
  const firstAdmin = rec.sent.find((payload) => payload.subject === ADMIN_SUBJECT);
  assertEquals(firstOwner.subject, OWNER_SUBJECT);
  assertEquals(firstAdmin?.subject, ADMIN_SUBJECT);

  // The account is renamed and the admin list changes while the claims are live.
  account = { ...ACCOUNT, platform_username: "Renamed Store" };
  admins = [{ email: "admin-three@example.invalid", full_name: "Admin Three" }];

  advance(CLAIM_STALE_MS + 1);
  sendsFail = false;
  await sendDisconnectAlerts(deps, "acc-1");

  const ownerSends = rec.sent.filter((payload) => payload.subject === OWNER_SUBJECT);
  const adminSends = rec.sent.filter((payload) => payload.subject === ADMIN_SUBJECT);
  assertEquals(ownerSends.length, 2);
  assertEquals(adminSends.length, 2);

  // The same key and the same body under it.
  assertEquals(ownerSends[1].idempotencyKey, firstOwner.idempotencyKey);
  assertEquals(ownerSends[1].html, firstOwner.html);
  assertEquals(ownerSends[1].to, firstOwner.to);
  assertEquals(adminSends[1].idempotencyKey, firstAdmin?.idempotencyKey);
  assertEquals(adminSends[1].html, firstAdmin?.html);
  assertEquals(adminSends[1].to, firstAdmin?.to);

  // The rebuilt body is the one that must not go out.
  assertFalse(ownerSends[1].html.includes("Renamed Store"));
  assertFalse(adminSends[1].to.includes("admin-three@example.invalid"));
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

Deno.test("recipient failures log sanitized codes without provider text", async () => {
  const providerText = "owner@example.invalid: provider request details";
  const scenarios = [
    {
      code: "timeout",
      deps: fakeDeps({
        send: (payload) => payload.subject === OWNER_SUBJECT
          ? Promise.reject(Object.assign(new Error(providerText), { code: "timeout" }))
          : Promise.resolve(),
      }).deps,
    },
    {
      code: "network_error",
      deps: fakeDeps({
        loadOwnerProfile: () =>
          Promise.resolve({ ...OWNER, email_notifications_enabled: false }),
        loadAdmins: () =>
          Promise.reject(Object.assign(new Error(providerText), { code: "network_error" })),
      }).deps,
    },
    {
      code: "PGRST116",
      deps: fakeDeps({
        loadOwnerProfile: () =>
          Promise.reject(Object.assign(new Error(providerText), { code: "PGRST116" })),
      }).deps,
    },
    {
      code: "unknown_error",
      deps: fakeDeps({
        send: () => Promise.reject({ code: "recipient=owner@example.invalid; phone=96566600001" }),
        isAdminAlertEnabled: () => Promise.resolve(false),
      }).deps,
    },
  ];

  for (const scenario of scenarios) {
    const logs: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await sendDisconnectAlerts(scenario.deps, "acc-1");
    } finally {
      console.error = originalError;
    }

    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0], `error_code=${scenario.code}`);
    assertFalse(logs[0].includes(providerText));
  }
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
