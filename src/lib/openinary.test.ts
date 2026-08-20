import { describe, expect, it } from "vitest";
import { buildOpeninaryTransform, getOpeninaryUrl, isOpeninaryUrl } from "./openinary";

describe("openinary URL layer", () => {
  const cfg = { serverUrl: "https://cdn.example.com/", folderPrefix: "postora.cloud" };
  it("builds the verified transform grammar", () => expect(buildOpeninaryTransform({ width: 300, format: "auto", quality: "auto" })).toBe("w_300,q_auto,f_auto"));
  it("retains extensions and encodes every path segment", () => expect(getOpeninaryUrl("probe (1).png", {}, cfg)).toBe("https://cdn.example.com/t/q_auto,f_auto/postora.cloud/probe%20(1).png"));
  it("deliberately drops dpr and blur directives", () => expect(buildOpeninaryTransform({ width: 20, dpr: 2, blur: 1000 })).toBe("w_20"));
  it("uses public /t delivery", () => expect(isOpeninaryUrl("https://cdn.example.com/t/w_300/postora.cloud/logo2.png", cfg.serverUrl)).toBe(true));
});
