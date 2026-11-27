import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import GoogleApiDisclosure from "@/pages/GoogleApiDisclosure";
import Privacy from "@/pages/Privacy";
import Terms from "@/pages/Terms";

function renderPage(page: ReactElement) {
  return render(<MemoryRouter>{page}</MemoryRouter>);
}

function pageText(container: HTMLElement) {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("YouTube legal disclosures", () => {
  it.each([
    ["Google API Services Disclosure", <GoogleApiDisclosure />],
    ["Postora Privacy Policy", <Privacy />],
    ["Postora Terms of Service", <Terms />],
  ])("pins the update date on %s", (_heading, page) => {
    const { container } = renderPage(page);

    expect(pageText(container)).toContain("Last updated: November 26, 2026");
    expect(pageText(container)).not.toContain("Last updated: January 8, 2026");
  });

  it("discloses every requested YouTube scope by its full URL", () => {
    renderPage(<GoogleApiDisclosure />);

    for (const scope of [
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ]) {
      expect(screen.getByText(scope)).toBeInTheDocument();
    }
  });

  it("covers channel identification, uploaded-video browsing, and on-demand analytics", () => {
    const { container } = renderPage(<GoogleApiDisclosure />);
    const text = pageText(container);

    expect(text).toContain("Read basic channel info");
    expect(text).toContain("Verify the connection stays healthy");
    expect(text).toContain("Browse your uploaded videos and full video details");
    expect(text).toContain("/youtube");
    expect(text).toContain("/analytics/youtube");
    expect(text).toContain("YouTube Analytics API v2");
    expect(text).toContain("Analytics Purpose Clause, Version 2, dated November 26, 2026");
    expect(text).toContain("insightTrafficSourceType");
    expect(text).toContain("audienceWatchRatio");
    expect(text).toContain("read on demand");
    expect(text).toContain("never stored by Postora");
  });

  it("covers new uploads, custom thumbnails, and published metadata editing without video deletion", () => {
    const { container } = renderPage(<GoogleApiDisclosure />);
    const text = pageText(container);

    expect(text).toContain("Upload videos and Shorts");
    expect(text).toContain("Set a custom thumbnail");
    expect(text).toContain("thumbnails.set");
    expect(text).toContain("Edit published video metadata");
    expect(text).toContain("currently disabled at the production baseline");
    expect(text).toContain("videos.update");
    expect(text).toContain("title, description, tags, category, privacy, language, made-for-kids and synthetic-media declarations");
    expect(text).toContain("Postora does not replace existing video media bytes or delete your videos.");
    expect(text).toContain("can add a newly uploaded video to an existing playlist you choose through the narrower force-ssl scope");
    expect(text).toContain("does not create, rename, reorder, or delete playlists or remove playlist items, change channel settings, replace existing video media bytes, or delete videos");
    expect(text).not.toContain("does not manage playlists or channel settings");
    expect(text).not.toContain("(managing playlists, editing or deleting existing videos, channel settings)");
    expect(text).not.toContain("This scope does not allow us to edit or delete your existing videos.");
  });

  it("discloses replacing the thumbnail of a video that was already uploaded", () => {
    const { container } = renderPage(<GoogleApiDisclosure />);
    const text = pageText(container);

    expect(text).toContain("Replace the thumbnail of a video you already uploaded");
    expect(text).toContain("thumbnails.set");
    expect(text).toContain("using a JPEG or PNG image from your own Postora media library");
    expect(text).toContain("Only an image you own is sent");
    expect(text).toContain("Postora never replaces the video's media bytes, and Postora never deletes the video.");
    expect(text).toContain("Setting a thumbnail is not a media-byte replacement");
    expect(text).toContain("/youtube");
  });

  it("discloses reading the channel's playlists and adding a new video to a chosen one", () => {
    const { container } = renderPage(<GoogleApiDisclosure />);
    const text = pageText(container);

    expect(text).toContain("List your channel's playlists");
    expect(text).toContain("playlists.list");
    expect(text).toContain("Add a newly uploaded video to an existing playlist");
    expect(text).toContain("playlistItems.insert");
    expect(text).toContain("Postora does not create, rename, reorder, or delete playlists, and does not remove items from a playlist.");
  });

  it("covers comment creation, own-comment actions, and moderation", () => {
    const { container } = renderPage(<GoogleApiDisclosure />);
    const text = pageText(container);

    expect(text).toContain("Read and create comments");
    expect(text).toContain("Published and Held for review queues");
    expect(text).toContain("top-level comments and replies");
    expect(text).toContain("edit or delete comments written by your channel");
    expect(text).toContain("Suggest AI reply");
    expect(text).toContain("sends that comment's text and the video title to the configured AI provider solely to draft a reply");
    expect(text).toContain("Moderate comments");
    expect(text).toContain("publishing or rejecting them");
    expect(text).toContain("moving an already-published comment to hold is unavailable at the current baseline");
    expect(text).toContain("banAuthor");
  });

  it("names the exact disconnect path, shared-grant rule, token fallback, and fresh analytics acceptance", () => {
    const { container } = renderPage(<GoogleApiDisclosure />);
    const text = pageText(container);

    expect(text).toContain("Profiles → Connected Accounts → Disconnect");
    expect(text).toContain("For a native YouTube connection, Postora clears the connection's stored credentials immediately");
    expect(text).toContain("when no other active connection of yours shares that grant");
    expect(text).toContain("using the refresh token first and the access token as a fallback");
    expect(text).toContain("ends the current connection's in-app Analytics Purpose Clause acceptance");
    expect(text).toContain("requires fresh acceptance before analytics can be read again");
  });

  it("keeps the required Google and YouTube policy links", () => {
    renderPage(<GoogleApiDisclosure />);

    const userDataPolicyLinks = screen.getAllByRole("link", { name: "Google API Services User Data Policy" });
    expect(userDataPolicyLinks.some((link) => link.getAttribute("href") === "https://developers.google.com/terms/api-services-user-data-policy")).toBe(true);
    expect(screen.getByRole("link", { name: "YouTube Terms of Service" })).toHaveAttribute("href", "https://www.youtube.com/t/terms");
    expect(screen.getByRole("link", { name: "Google Privacy Policy" })).toHaveAttribute("href", "https://policies.google.com/privacy");
    expect(screen.getByRole("link", { name: "Google Account Permissions" })).toHaveAttribute("href", "https://myaccount.google.com/permissions");
  });

  it("reconciles Privacy collection, use, and retention with all Stage 1–5 capabilities", () => {
    const { container } = renderPage(<Privacy />);
    const text = pageText(container);

    expect(text).toContain("Your uploaded videos and their details when you browse your channel in Postora");
    expect(text).toContain("Published video metadata when published metadata editing is enabled and you instruct Postora to edit details");
    expect(text).toContain("The playlists of your channel (playlist ID, title, privacy status) when you open YouTube publishing settings for a single connected channel or choose a destination playlist for a video you publish");
    expect(text).toContain("let you browse your uploaded videos and their full details");
    expect(text).toContain("Edit published video metadata only when that feature is enabled (currently disabled at the production baseline)");
    expect(text).toContain("Replace the thumbnail of a video you already uploaded with a JPEG or PNG image from your own media library, only when you pick the image and confirm the change");
    expect(text).toContain("The bytes of a JPEG or PNG image from your own Postora media library when you replace the thumbnail of a video you already uploaded");
    expect(text).toContain("List your channel's playlists so you can choose a destination playlist when publishing, and add a newly uploaded video to the playlist you select");
    expect(text).toContain("Postora never creates, renames, reorders, or deletes playlists and never removes playlist items");
    expect(text).toContain("Read, create, reply to, edit, delete, and moderate comments");
    expect(text).toContain("send that comment's text and the video title to the configured AI provider solely to draft a reply");
    expect(text).toContain("Analytics Purpose Clause, Version 2, dated November 26, 2026");
    expect(text).toContain("viewer country, device type, traffic sources, and audience retention");
    expect(text).toContain("Postora clears its stored OAuth credentials immediately");
    expect(text).toContain("revokes the Google grant when no other active connection of yours shares it");
    expect(text).toContain("On-demand YouTube Analytics numbers are never stored");
    expect(text).toContain("reconnecting requires fresh acceptance");
  });

  it("describes the complete owner-authorized YouTube feature suite in Terms", () => {
    const { container } = renderPage(<Terms />);
    const text = pageText(container);

    expect(text).toContain("video and Short publishing");
    expect(text).toContain("channel and uploaded-video browsing");
    expect(text).toContain("published video metadata editing (when enabled; currently disabled at the production baseline)");
    expect(text).toContain("comment creation and moderation");
    expect(text).toContain("on-demand channel and video analytics");
    expect(text).toContain("accept the current Analytics Purpose Clause inside Postora for that connection");
  });
});
