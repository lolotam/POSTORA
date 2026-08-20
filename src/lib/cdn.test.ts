import { describe, expect, it } from "vitest";
import { getCdnImageUrl, getCdnPlaceholder, getCdnThumbnail } from "./cdn";
describe("cdn facade", () => {
  const media = { file_path: "logo2.png" };
  it("selects Openinary delivery", () => expect(getCdnImageUrl(media, [], {}, { read_preference: "openinary", openinary: { serverUrl: "https://cdn.example.com", folderPrefix: "postora.cloud" } })).toContain("/t/q_auto,f_auto/postora.cloud/logo2.png"));
  it("uses ready rows before deriving a URL", () => expect(getCdnImageUrl(media, [{ provider: "openinary", status: "ready", delivery_url: "https://cdn.example.com/t/logo2.png" }], {}, { read_preference: "openinary" })).toBe("https://cdn.example.com/t/logo2.png"));
  it("provides thumbnail and placeholder helpers", () => { expect(getCdnThumbnail(media, [], 80, { read_preference: "openinary", openinary: { serverUrl: "https://cdn.example.com" } })).toContain("w_80"); expect(getCdnPlaceholder(media, [], { read_preference: "openinary", openinary: { serverUrl: "https://cdn.example.com" } })).toContain("w_20"); });
});
