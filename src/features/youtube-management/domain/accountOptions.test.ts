import { describe, expect, it } from "vitest";
import { toYouTubeAccountOptions } from "./accountOptions";

describe("toYouTubeAccountOptions", () => {
  it("keeps only YouTube accounts and names an untitled channel by a neutral label", () => {
    const options = toYouTubeAccountOptions([
      { id: "a", platform: "youtube", platform_username: "Channel A", avatar_url: "https://cdn.example/a.png", auth_provider: "native" },
      { id: "b", platform: "instagram", platform_username: "ig", avatar_url: null, auth_provider: "native" },
      { id: "c", platform: "youtube", platform_username: null, avatar_url: null, auth_provider: "composio" },
    ]);
    expect(options).toEqual([
      { id: "a", title: "Channel A", avatarUrl: "https://cdn.example/a.png", provider: "native" },
      { id: "c", title: "YouTube", avatarUrl: null, provider: "composio" },
    ]);
  });
});
