/**
 * Assumed dependencies interface for the sendAlerts orchestrator:
 * 
 * deps = {
 *   listFlagged(): Promise<Row[]>,
 *   loadProfile(userId: string): Promise<{ email: string; full_name: string | null; email_notifications_enabled: boolean | null } | null>,
 *   claim(accountId: string, since: string): Promise<boolean>,
 *   send(payload: { to: string; subject: string; html: string }): Promise<void>,
 *   mark(accountId, since: string): Promise<boolean>,
 *   now(): Date
 * }
 */

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  selectAccountsToEmail,
  sendAlerts,
  type SendAlertsDeps,
} from "./handler.ts";

type FlaggedRow = Parameters<typeof selectAccountsToEmail>[0][number];

function makeAccount(
  overrides: {
    id?: string;
    userId?: string;
    username?: string | null;
    phone?: string;
    since?: string;
    lastAt?: string;
    emailedAt?: string;
    snoozed?: boolean;
  } = {},
): FlaggedRow {
  return {
    id: overrides.id ?? "acc-1",
    user_id: overrides.userId ?? "user-1",
    platform: "whatsapp",
    platform_username: overrides.username !== undefined ? overrides.username : "xsellpoint",
    platform_user_id: overrides.phone ?? "96597950350",
    // A social_accounts column (20260116191438), not a metadata key.
    alerts_snoozed: overrides.snoozed ?? false,
    account_metadata: {
      undelivered_store_events: overrides.since
        ? {
            since: overrides.since,
            last_at: overrides.lastAt ?? overrides.since,
          }
        : undefined,
      undelivered_alert_email_at: overrides.emailedAt,
    },
  } as unknown as FlaggedRow;
}

function createFakeDeps(overrides: Partial<SendAlertsDeps> = {}) {
  const calls: string[] = [];
  const claimed: Array<{ accountId: string; since: string }> = [];
  const marked: Array<{ accountId: string; since: string }> = [];
  const sentEmails: Array<{ to: string; subject: string; html: string }> = [];

  const defaultRow = makeAccount({
    id: "acc-1",
    userId: "user-1",
    username: "xsellpoint",
    phone: "96597950350",
    since: "2026-10-01T10:00:00Z",
    lastAt: "2026-10-01T12:00:00Z",
  });

  const deps: SendAlertsDeps = {
    listFlagged: overrides.listFlagged ?? (() => Promise.resolve([defaultRow])),
    loadProfile: overrides.loadProfile ?? ((_userId: string) => Promise.resolve({
      email: "owner@example.com",
      full_name: "Store Owner",
      email_notifications_enabled: true,
    })),
    claim: overrides.claim ?? ((accountId: string, since: string) => {
      calls.push(`claim:${accountId}`);
      claimed.push({ accountId, since });
      return Promise.resolve(true);
    }),
    send: overrides.send ?? ((payload: { to: string; subject: string; html: string }) => {
      calls.push(`send:${payload.to}`);
      sentEmails.push(payload);
      return Promise.resolve();
    }),
    mark: overrides.mark ?? ((accountId: string, since: string) => {
      calls.push(`mark:${accountId}`);
      marked.push({ accountId, since });
      return Promise.resolve(true);
    }),
    now: overrides.now ?? (() => new Date("2026-10-01T12:00:00Z")),
  };

  return { deps, calls, claimed, marked, sentEmails };
}

Deno.test("selectAccountsToEmail: eligible when never emailed before", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const row = makeAccount({
    since: "2026-10-01T10:00:00Z",
    lastAt: "2026-10-01T11:00:00Z",
    emailedAt: undefined,
  });

  const selected = selectAccountsToEmail([row], now);
  assertEquals(selected.length, 1);
  assertEquals(selected[0].id, "acc-1");
});

Deno.test("selectAccountsToEmail: eligibility is by since (not last_at)", () => {
  const now = new Date("2026-10-01T15:00:00Z");

  // acc1: emailed after since; last_at is newer than emailedAt, but since is older -> NOT eligible
  const acc1 = makeAccount({
    id: "acc-1",
    since: "2026-10-01T10:00:00Z",
    emailedAt: "2026-10-01T11:00:00Z",
    lastAt: "2026-10-01T14:00:00Z",
  });

  // acc2: emailed previously for an earlier incident; new incident since 13:00 -> ELIGIBLE
  const acc2 = makeAccount({
    id: "acc-2",
    since: "2026-10-01T13:00:00Z",
    emailedAt: "2026-10-01T11:00:00Z",
    lastAt: "2026-10-01T14:00:00Z",
  });

  const selected = selectAccountsToEmail([acc1, acc2], now);
  assertEquals(selected.map((a: FlaggedRow) => a.id), ["acc-2"]);
});

Deno.test("selectAccountsToEmail: alerts_snoozed is never emailed", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const snoozed = makeAccount({
    id: "acc-snoozed",
    since: "2026-10-01T10:00:00Z",
    snoozed: true,
  });

  const selected = selectAccountsToEmail([snoozed], now);
  assertEquals(selected.length, 0);
});

Deno.test("selectAccountsToEmail: rows without undelivered_store_events are ignored", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const unflagged = makeAccount({
    id: "acc-unflagged",
    since: undefined,
  });

  const selected = selectAccountsToEmail([unflagged], now);
  assertEquals(selected.length, 0);
});

Deno.test("sendAlerts: claim called BEFORE send, mark called AFTER send, email contains account name and no phone digits", async () => {
  const fake = createFakeDeps();
  await sendAlerts(fake.deps);

  // Claim before send, mark after send
  assertEquals(fake.calls, ["claim:acc-1", "send:owner@example.com", "mark:acc-1"]);
  assertEquals(fake.claimed, [{ accountId: "acc-1", since: "2026-10-01T10:00:00Z" }]);
  assertEquals(fake.marked, [{ accountId: "acc-1", since: "2026-10-01T10:00:00Z" }]);

  // Email content assertions
  assertEquals(fake.sentEmails.length, 1);
  const email = fake.sentEmails[0];
  assertEquals(email.to, "owner@example.com");
  assertEquals(email.html.includes("xsellpoint"), true, "HTML must contain account name");
  assertEquals(email.html.includes("96597950350"), false, "HTML must NOT contain full phone number");
  assertEquals(email.html.includes("97950350"), false, "HTML must NOT contain local phone digits");
  assertEquals(email.subject.includes("96597950350"), false, "Subject must NOT contain phone digits");
});

Deno.test("sendAlerts: a claim returning false sends nothing and does not mark", async () => {
  const fake = createFakeDeps({
    claim: () => Promise.resolve(false),
  });

  await sendAlerts(fake.deps);

  assertEquals(fake.calls, ["claim:acc-1"]);
  assertEquals(fake.sentEmails.length, 0);
  assertEquals(fake.marked.length, 0);
});

Deno.test("sendAlerts: a send failure does not mark", async () => {
  const fake = createFakeDeps({
    send: () => Promise.reject(new Error("Resend rate limit exceeded")),
  });

  try {
    await sendAlerts(fake.deps);
  } catch {
    // Orchestrator may either throw or record failure per-account
  }

  assertEquals(fake.calls, ["claim:acc-1", "send:owner@example.com"]);
  assertEquals(fake.marked.length, 0, "Mark must never be called if send failed");
});

Deno.test("sendAlerts: profile email_notifications_enabled !== true is never emailed, claimed, or marked", async (t) => {
  const cases: Array<[string, boolean | null | undefined, boolean]> = [
    ["explicitly false", false, false],
    ["null", null, false],
    ["profile missing", undefined, true],
  ];

  for (const [label, pref, missingProfile] of cases) {
    await t.step(label, async () => {
      const fake = createFakeDeps({
        loadProfile: () =>
          missingProfile
            ? Promise.resolve(null)
            : Promise.resolve({
                email: "owner@example.com",
                full_name: "Store Owner",
                email_notifications_enabled: pref as boolean | null,
              }),
      });

      await sendAlerts(fake.deps);

      assertEquals(fake.sentEmails.length, 0);
      assertEquals(fake.claimed.length, 0);
      assertEquals(fake.marked.length, 0);
      assertEquals(fake.calls, []);
    });
  }
});

Deno.test("sendAlerts: alerts_snoozed is never claimed or emailed", async () => {
  const snoozedRow = makeAccount({
    id: "acc-snoozed",
    since: "2026-10-01T10:00:00Z",
    snoozed: true,
  });

  const fake = createFakeDeps({
    listFlagged: () => Promise.resolve([snoozedRow]),
  });

  await sendAlerts(fake.deps);

  assertEquals(fake.calls.length, 0);
  assertEquals(fake.sentEmails.length, 0);
  assertEquals(fake.claimed.length, 0);
  assertEquals(fake.marked.length, 0);
});
