import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { clientIpFromHeaders, isValidUuid } from "./requestGuards.ts";

const ip = (values: Record<string, string>) => clientIpFromHeaders(new Headers(values));

Deno.test("the multi-hop chain that broke api_logs yields only the first hop", () => {
  assertEquals(ip({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), "1.2.3.4");
  assertEquals(ip({ "x-forwarded-for": "  1.2.3.4 ,5.6.7.8,9.10.11.12  " }), "1.2.3.4");
});

Deno.test("cf-connecting-ip wins over the forwarded chain", () => {
  assertEquals(ip({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), "203.0.113.7");
});

Deno.test("a usable hop is found when earlier ones are junk", () => {
  assertEquals(ip({ "x-forwarded-for": "unknown, 5.6.7.8" }), "5.6.7.8");
  assertEquals(ip({ "cf-connecting-ip": "not-an-ip", "x-forwarded-for": "5.6.7.8" }), "5.6.7.8");
});

Deno.test("no usable address yields null rather than a value inet would reject", () => {
  assertEquals(ip({}), null);
  assertEquals(ip({ "x-forwarded-for": "" }), null);
  assertEquals(ip({ "x-forwarded-for": ", ,unknown" }), null);
  assertEquals(ip({ "x-forwarded-for": "999.1.1.1" }), null);
  assertEquals(ip({ "x-forwarded-for": "1.2.3.4; DROP TABLE api_logs" }), null);
});

Deno.test("IPv6 hops survive, including the forms proxies decorate", () => {
  assertEquals(ip({ "x-forwarded-for": "2001:db8::1, 5.6.7.8" }), "2001:db8::1");
  assertEquals(ip({ "x-forwarded-for": "[2001:db8::1]:443" }), "2001:db8::1");
  assertEquals(ip({ "x-forwarded-for": "fe80::1%eth0" }), "fe80::1");
  assertEquals(ip({ "x-forwarded-for": "::ffff:1.2.3.4" }), "::ffff:1.2.3.4");
  assertEquals(ip({ "x-forwarded-for": "::1" }), "::1");
});

Deno.test("an IPv4 hop carrying a port drops the port", () => {
  assertEquals(ip({ "x-forwarded-for": "1.2.3.4:56789" }), "1.2.3.4");
});

Deno.test("isValidUuid accepts v1-v5 and trims", () => {
  assertEquals(isValidUuid("d41f6c78-3ac4-42b9-ae2c-7a5c7fa09dfb"), true);
  assertEquals(isValidUuid("  D41F6C78-3AC4-42B9-AE2C-7A5C7FA09DFB  "), true);
});

Deno.test("isValidUuid rejects the values n8n workflows actually mis-send", () => {
  assertEquals(isValidUuid("1214265425109740"), false); // a Facebook page id
  assertEquals(isValidUuid("danatfuture"), false); // a username
  assertEquals(isValidUuid(""), false);
  assertEquals(isValidUuid("d41f6c78-3ac4-42b9-ae2c-7a5c7fa09dfb-extra"), false);
  assertEquals(isValidUuid(undefined), false);
  assertEquals(isValidUuid(null), false);
  assertEquals(isValidUuid(12345), false);
});
