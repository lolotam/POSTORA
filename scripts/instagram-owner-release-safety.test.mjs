import assert from "node:assert/strict";
import { test } from "node:test";
import { assertLocalDockerSocket } from "../e2e/fixtures/instagramOwnerReleaseSafety.mjs";

test("fixture socket guard accepts local pipes and refuses remote or ambiguous Docker endpoints", () => {
  for (const endpoint of ["unix:///var/run/docker.sock", "npipe:////./pipe/dockerDesktopLinuxEngine"]) {
    assert.doesNotThrow(() => assertLocalDockerSocket(endpoint));
  }
  for (const endpoint of ["ssh://contabo", "tcp://86.48.2.205:2376", "tcp://127.0.0.1:2375", "npipe:////remote/pipe/docker_engine", "unix://remote/docker.sock", null, ""]) {
    assert.throws(() => assertLocalDockerSocket(endpoint));
  }
});
