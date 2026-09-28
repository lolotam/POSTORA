import { assertEquals } from "jsr:@std/assert@1";
import { isServiceRoleBearer } from "./serviceCaller.ts";

Deno.test("only the exact service-role key opens the userId-from-body branch", () => {
  const key = "service-role-key-value";
  assertEquals(isServiceRoleBearer(key, key), true);
  assertEquals(isServiceRoleBearer("not-a-real-token", key), false);
  assertEquals(isServiceRoleBearer("service-role-key-valuX", key), false);
  assertEquals(isServiceRoleBearer("", key), false);
  assertEquals(isServiceRoleBearer(key, undefined), false);
});
