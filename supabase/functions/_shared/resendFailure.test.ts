import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { describeResendFailure, resendFailureLog } from "./resendFailure.ts";

Deno.test("a revoked key, as Resend reports it today, is a rejected key", () => {
  // The exact body Resend returned for the production key on 2026-10-29.
  const failure = describeResendFailure({ statusCode: 400, message: "API key is invalid", name: "validation_error" });
  assertEquals(failure, { statusCode: 400, name: "validation_error", keyRejected: true });
  assertEquals(
    resendFailureLog("send-change-password-otp", failure),
    "send-change-password-otp: resend send failed (status 400, validation_error); RESEND_API_KEY rejected by Resend: issue a new key and recreate the functions container",
  );
});

Deno.test("missing and restricted keys are rejected keys too", () => {
  assertEquals(describeResendFailure({ statusCode: 401, name: "missing_api_key" }).keyRejected, true);
  assertEquals(describeResendFailure({ statusCode: 401, name: "restricted_api_key" }).keyRejected, true);
});

Deno.test("an unverified sender domain is not a key problem", () => {
  const failure = describeResendFailure({ statusCode: 403, name: "validation_error", message: "The postora.cloud domain is not verified" });
  assertEquals(failure.keyRejected, false);
  assertEquals(resendFailureLog("send-reset-otp", failure), "send-reset-otp: resend send failed (status 403, validation_error)");
});

Deno.test("an unknown error shape still yields a log line", () => {
  assertEquals(describeResendFailure(undefined), { statusCode: 0, name: "unknown", keyRejected: false });
  assertEquals(describeResendFailure("boom"), { statusCode: 0, name: "unknown", keyRejected: false });
});
