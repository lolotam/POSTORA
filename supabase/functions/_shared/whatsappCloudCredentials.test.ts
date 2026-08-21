import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { resolveWhatsAppCloudCredentials } from "./whatsappCloudCredentials.ts";

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
  assertEquals(resolveWhatsAppCloudCredentials([cloudAccount]), {
    status: "ok",
    credentials: { accessToken: "account-token", phoneNumberId: "1097745303431352" },
  });
});

Deno.test("accepts accounts whose connection_mode predates the field", () => {
  // Rows connected before connection_mode existed have no value at all; requiring an explicit
  // 'cloud_api' would reject every one of them.
  const legacy = { ...cloudAccount, account_metadata: null };
  const resolution = resolveWhatsAppCloudCredentials([legacy]);
  assertEquals(resolution.status, "ok");
});

Deno.test("skips a newer Direct QR account in favour of an older Cloud API one", () => {
  assertEquals(resolveWhatsAppCloudCredentials([qrAccount, cloudAccount]), {
    status: "ok",
    credentials: { accessToken: "account-token", phoneNumberId: "1097745303431352" },
  });
});

Deno.test("never borrows another account's identity for a QR-only user", () => {
  // The original defect paired a global env token with this account's phone number. There is no
  // global fallback any more, so a QR-only user must be reported rather than quietly sent out
  // under someone else's WhatsApp identity.
  assertEquals(resolveWhatsAppCloudCredentials([qrAccount]), { status: "requires_cloud_api" });
});

Deno.test("reports a QR-only user separately from a user with nothing connected", () => {
  assertEquals(resolveWhatsAppCloudCredentials([qrAccount]), { status: "requires_cloud_api" });
  assertEquals(resolveWhatsAppCloudCredentials([]), { status: "none" });
});

Deno.test("ignores a Cloud API account that is missing half its credentials", () => {
  const incomplete = { ...cloudAccount, access_token: null };
  assertEquals(resolveWhatsAppCloudCredentials([incomplete]), { status: "requires_cloud_api" });
});
