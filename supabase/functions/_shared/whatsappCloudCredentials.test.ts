import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { resolveWhatsAppCloudCredentials } from "./whatsappCloudCredentials.ts";

const ENV = { accessToken: "env-token", phoneNumberId: "env-phone-id" };
const NO_ENV = { accessToken: undefined, phoneNumberId: undefined };

const cloudAccount = {
  access_token: "account-token",
  platform_user_id: "1097745303431352",
  account_metadata: { connection_mode: "coexistence" },
};

// Direct QR sessions carry no Meta identity: the token is empty and platform_user_id is a
// plain phone number, which Meta cannot resolve as a phone_number_id.
const qrAccount = {
  access_token: "",
  platform_user_id: "96597950350",
  account_metadata: { connection_mode: "evolution_qr" },
};

Deno.test("uses the account's own credentials when it is Cloud API backed", () => {
  assertEquals(resolveWhatsAppCloudCredentials([cloudAccount], ENV), {
    status: "ok",
    source: "account",
    credentials: { accessToken: "account-token", phoneNumberId: "1097745303431352" },
  });
});

Deno.test("accepts accounts whose connection_mode predates the field", () => {
  // Rows connected before connection_mode existed have no value at all; requiring an explicit
  // 'cloud_api' would reject every one of them.
  const legacy = { ...cloudAccount, account_metadata: null };
  const resolution = resolveWhatsAppCloudCredentials([legacy], NO_ENV);
  assertEquals(resolution.status, "ok");
});

Deno.test("skips a newer Direct QR account in favour of an older Cloud API one", () => {
  assertEquals(resolveWhatsAppCloudCredentials([qrAccount, cloudAccount], NO_ENV), {
    status: "ok",
    source: "account",
    credentials: { accessToken: "account-token", phoneNumberId: "1097745303431352" },
  });
});

Deno.test("never pairs the env token with an account's phone number", () => {
  // The original defect: a per-field fallback produced env-token + QR phone number, a pair
  // belonging to no real WhatsApp account.
  const resolution = resolveWhatsAppCloudCredentials([qrAccount], ENV);
  assertEquals(resolution, {
    status: "ok",
    source: "env",
    credentials: { accessToken: "env-token", phoneNumberId: "env-phone-id" },
  });
});

Deno.test("falls back to env only when both halves are present", () => {
  const halfConfigured = { accessToken: "env-token", phoneNumberId: undefined };
  assertEquals(resolveWhatsAppCloudCredentials([qrAccount], halfConfigured), {
    status: "requires_cloud_api",
  });
});

Deno.test("reports a QR-only user separately from a user with nothing connected", () => {
  assertEquals(resolveWhatsAppCloudCredentials([qrAccount], NO_ENV), { status: "requires_cloud_api" });
  assertEquals(resolveWhatsAppCloudCredentials([], NO_ENV), { status: "none" });
});

Deno.test("ignores a Cloud API account that is missing half its credentials", () => {
  const incomplete = { ...cloudAccount, access_token: null };
  assertEquals(resolveWhatsAppCloudCredentials([incomplete], NO_ENV), { status: "requires_cloud_api" });
});
