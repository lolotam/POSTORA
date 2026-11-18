import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveYoutubePublishOptions,
  youtubePrivacyOrDefault,
  YOUTUBE_DEFAULT_PRIVACY,
  YOUTUBE_OPTION_ALIASES,
  YOUTUBE_PRIVACY_VALUES,
} from "../../../supabase/functions/_shared/youtubePublishOptions.ts";

// Contract guard for the YouTube publishing options.
//
// The YouTube API reads one set of field names. Postora's website
// documentation and its in-app playground used to publish a different set,
// which the API ignored: a request asking for a public video was published
// privately and a request naming a category was published in the default
// category, without any error. These assertions keep the browser surfaces on
// the canonical names and keep the documented behaviour true.

function read(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");
}

const DOCS_PAGE = "src/pages/docs/YoutubeApi.tsx";
const PLAYGROUND_STATE = "src/components/api-playground/usePlaygroundState.ts";
const CROSS_PLATFORM_GUIDE = "src/pages/docs/MultiPlatformGuide.tsx";

describe("YouTube publishing option contract", () => {
  it("declares the canonical field names and their legacy aliases", () => {
    expect(YOUTUBE_OPTION_ALIASES).toEqual({
      youtube_category: "youtube_category_id",
      youtube_allow_embedding: "youtube_embeddable",
    });
  });

  it("publishes privately when no privacy is chosen", () => {
    expect(YOUTUBE_PRIVACY_VALUES).toEqual(["public", "unlisted", "private"]);
    expect(youtubePrivacyOrDefault(undefined)).toBe("private");
  });

  it("lets a legacy alias stand in for its canonical field", () => {
    const resolved = resolveYoutubePublishOptions({
      youtube_privacy_status: "public",
      youtube_category_id: "10",
      youtube_embeddable: false,
    });

    expect(youtubePrivacyOrDefault(resolved.options.youtube_privacy)).toBe("private");
    expect(resolved.ignoredPrivacyFields).toEqual(["youtube_privacy_status"]);
    expect(resolved.options.youtube_category).toBe("10");
    expect(resolved.options.youtube_allow_embedding).toBe(false);
  });

  it("never emits a legacy alias from the developer documentation", () => {
    const source = read(DOCS_PAGE);

    expect(source).not.toMatch(/"youtube_privacy_status"\s*:/);
    expect(source).not.toMatch(/"youtube_category_id"\s*:/);
    expect(source).not.toMatch(/"youtube_embeddable"\s*:/);
    expect(source).not.toMatch(/-F\s+"youtube_privacy_status=/);
    expect(source).not.toMatch(/-F\s+"youtube_category_id=/);
    expect(source).not.toMatch(/-F\s+"youtube_embeddable=/);
  });

  it("emits the canonical field names from the developer documentation", () => {
    const source = read(DOCS_PAGE);

    expect(source).toContain('name: "youtube_privacy"');
    expect(source).toContain('name: "youtube_category"');
    expect(source).toContain('name: "youtube_allow_embedding"');
    expect(source).toContain('name: "youtube_video_type"');
  });

  it("never emits a legacy alias from the cross-platform guide", () => {
    const source = read(CROSS_PLATFORM_GUIDE);

    expect(source).not.toContain("youtube_privacy_status");
    expect(source).not.toContain("youtube_category_id");
  });

  it("never emits a legacy alias from the in-app playground", () => {
    const source = read(PLAYGROUND_STATE);

    expect(source).not.toContain("youtube_privacy_status");
    expect(source).not.toContain("youtube_category_id");
    expect(source).toContain("body.youtube_privacy");
    expect(source).toContain("body.youtube_category");
  });

  it("starts the in-app playground on the privacy the API actually applies", () => {
    const source = read(PLAYGROUND_STATE);

    const playgroundDefault = source.match(
      /const \[youtubePrivacy, setYoutubePrivacy\] = useState\("([^"]+)"\)/,
    )?.[1];

    expect(playgroundDefault).toBe(YOUTUBE_DEFAULT_PRIVACY);
  });

  it("documents the Shorts rules YouTube applies today", () => {
    const source = read(DOCS_PAGE);

    expect(source).toContain("three minutes");
    expect(source).not.toContain("under 60 seconds");
  });
});
