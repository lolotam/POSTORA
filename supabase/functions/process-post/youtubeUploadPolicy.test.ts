/**
 * The policy the upload path shares.
 *
 * Three things are proved here:
 *
 *   * the reason codes are stable, and the message that goes with one does
 *     not tell the customer to retry when a retry could put a second video
 *     on their channel;
 *   * a credential cannot be interpolated into a log line or a stored error,
 *     whether it arrives in a provider body, in an exception message, or in
 *     a URL;
 *   * the media egress policy only lets a reviewed host be read, and only
 *     over HTTPS.
 */

import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  approvedMediaHosts,
  isApprovedMediaUrl,
  redactProviderText,
  redactResumableCredentials,
  YOUTUBE_UPLOAD_REASON,
  youtubeUploadPublicMessage,
  youtubeStorageReadUrl,
} from "./youtubeUploadPolicy.ts";

Deno.test("internal signed video URLs use the approved public HTTPS Storage endpoint", () => {
  const internal = "http://kong:8000";
  const external = "https://storage.example";
  const path = "/storage/v1/object/sign/media/team/clip%20one.mp4?token=fixture";
  const rebased = youtubeStorageReadUrl(internal + path, internal, external);
  assertEquals(rebased, external + path);
  assertEquals(isApprovedMediaUrl(rebased, approvedMediaHosts({ supabaseUrl: external })), true);
  for (const url of [
    "http://kong:8000/rest/v1/media_files",
    "http://alternate.example" + path,
    "http://user@kong:8000" + path,
  ]) {
    assertEquals(youtubeStorageReadUrl(url, internal, external), url);
  }
  assertEquals(youtubeStorageReadUrl(internal + path, internal, "http://storage.example"), internal + path);
});

Deno.test("every reason code has a message of its own", () => {
  const codes = Object.values(YOUTUBE_UPLOAD_REASON);
  const messages = codes.map((code) => youtubeUploadPublicMessage(code));
  assertEquals(new Set(messages).size, codes.length);
});

Deno.test("a reason that needs a human does not read like a retry is safe", () => {
  const reconcile = youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.reconcile).toLowerCase();
  assert(!reconcile.includes("safe to retry"));
  assert(!reconcile.includes("trying again is safe"));
  const expired = youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.expired).toLowerCase();
  assert(!expired.includes("safe to retry"));
});

Deno.test("a reason that is safe to retry says so", () => {
  const unsent = youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.unsent).toLowerCase();
  assert(unsent.includes("retried"));
});

Deno.test("the upload credential is taken out of a message", () => {
  const redacted = redactResumableCredentials(
    "the request https://www.googleapis.com/upload?upload_id=abc123&part=snippet failed",
  );
  assert(!redacted.includes("abc123"));
  assertStringIncludes(redacted, "upload_id=***");
});

Deno.test("a provider body cannot leak the session uri into a log line", () => {
  const body = JSON.stringify({
    error: { message: "Bad Request: https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc123&uploadType=resumable" },
  });
  const redacted = redactProviderText(body);
  assert(!redacted.includes("abc123"));
  assert(!redacted.includes("https://"));
});

Deno.test("query values after a bracket or upload ID are redacted", () => {
  const storageUrl = "https://storage.example.test/[video].mp4?signature=private-value&additional=extra-value";
  const uploadUrl = "https://www.googleapis.com/upload?upload_id=identifier&additional=extra-value";
  assertEquals(redactProviderText(`source ${storageUrl} provider ${uploadUrl}`), "source [redacted-url] provider [redacted-url]");
});

Deno.test("an exception message cannot leak the session uri into a log line", () => {
  const error = new Error("request to https://www.googleapis.com/upload?upload_id=abc123 failed");
  const redacted = redactProviderText(error);
  assert(!redacted.includes("abc123"));
  assert(!redacted.includes("https://"));
});

Deno.test("a token cannot leak into a log line", () => {
  const redacted = redactProviderText('{"access_token":"ya29.super-secret","expires_in":3600}');
  assert(!redacted.includes("ya29.super-secret"));
  assertEquals(redactProviderText("{'refresh_token': 'fixture with spaces'}"),
    "{'refresh_token': '[redacted]'}");
});

Deno.test("a bearer token cannot leak into a log line", () => {
  const redacted = redactProviderText("Authorization: Bearer ya29.super-secret");
  assert(!redacted.includes("ya29.super-secret"));
});

Deno.test("the redacted text is bounded", () => {
  const redacted = redactProviderText("x".repeat(5_000), 100);
  assertEquals(redacted.length <= 101, true);
});

Deno.test("the redacted text keeps what the customer needs", () => {
  const redacted = redactProviderText("the video was rejected because the format is not supported");
  assertStringIncludes(redacted, "not supported");
});

Deno.test("only a reviewed host over https may be read", () => {
  const hosts = approvedMediaHosts({ supabaseUrl: "https://api.example.test" });
  assertEquals(isApprovedMediaUrl("https://api.example.test/storage/v1/object/sign/v.mp4", hosts), true);
  assertEquals(isApprovedMediaUrl("https://elsewhere.example/v.mp4", hosts), false);
  assertEquals(isApprovedMediaUrl("http://api.example.test/v.mp4", hosts), false);
  assertEquals(isApprovedMediaUrl("https://api.example.test.evil.test/v.mp4", hosts), false);
  assertEquals(isApprovedMediaUrl("https://api.example.test@evil.test/v.mp4", hosts), false);
  assertEquals(isApprovedMediaUrl("javascript:alert(1)", hosts), false);
});

Deno.test("the cloudinary delivery host is approved", () => {
  const hosts = approvedMediaHosts({ supabaseUrl: "https://api.example.test" });
  assertEquals(hosts.has("res.cloudinary.com"), true);
});

Deno.test("a configured cdn origin is approved and an insecure one is not", () => {
  const hosts = approvedMediaHosts({
    supabaseUrl: "https://api.example.test",
    cdnOrigins: ["https://cdn.example.test", "http://insecure.example.test"],
  });
  assertEquals(hosts.has("cdn.example.test"), true);
  assertEquals(hosts.has("insecure.example.test"), false);
});
