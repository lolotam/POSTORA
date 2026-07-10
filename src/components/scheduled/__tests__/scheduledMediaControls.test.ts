import { describe, expect, it } from "vitest";
import {
  getMediaFolderLabel,
  getScheduledPostTypes,
} from "../scheduledMediaControls";

describe("getScheduledPostTypes", () => {
  it("normalizes distinct metadata types in Feed, Story, Reel order", () => {
    expect(
      getScheduledPostTypes(
        {
          facebook_post_type: ["reel", "feed"],
          instagram_post_type: "stories",
          instagram: { mediaType: ["story", "unsupported"] },
        },
        ["facebook", "instagram"],
      ),
    ).toEqual(["feed", "story", "reel"]);
  });

  it("uses the legacy Instagram media type and defaults only Facebook or Instagram to feed", () => {
    expect(
      getScheduledPostTypes({ instagram: { mediaType: "stories" } }, ["instagram"]),
    ).toEqual(["story"]);
    expect(getScheduledPostTypes({}, ["facebook"])).toEqual(["feed"]);
    expect(getScheduledPostTypes({}, ["linkedin"])).toEqual([]);
  });

  it("ignores legacy Instagram media type when the current field has a recognized value", () => {
    expect(
      getScheduledPostTypes(
        {
          instagram_post_type: "reel",
          instagram: { mediaType: "stories" },
        },
        ["instagram"],
      ),
    ).toEqual(["reel"]);
  });
});

describe("getMediaFolderLabel", () => {
  const folders = [
    { name: "Campaign", full_path: "/Campaign" },
    { name: "Launch", full_path: "/Campaign/Launch" },
  ];

  it("labels root media as Media Library", () => {
    expect(getMediaFolderLabel(["/", null], folders)).toBe("Media Library");
  });

  it("labels media sharing one folder with the matching folder name", () => {
    expect(getMediaFolderLabel(["/Campaign/Launch", "/Campaign/Launch"], folders)).toBe(
      "Launch",
    );
  });

  it("labels media from different folders as Multiple folders", () => {
    expect(getMediaFolderLabel(["/", "/Campaign"], folders)).toBe("Multiple folders");
  });
});
