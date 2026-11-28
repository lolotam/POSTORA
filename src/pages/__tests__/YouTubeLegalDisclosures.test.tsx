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

// The embedded player is loaded by the creator's own browser, so every legal
// page says where the request goes and what Postora never sees.
const EMBEDDED_PLAYER_DISCLOSURE =
  "When you press Play on a video in Postora, your browser loads YouTube's embedded player from "
  + "youtube-nocookie.com. Google receives the request directly from your browser under YouTube's "
  + "Terms of Service and Google's Privacy Policy. Postora does not receive or store playback data.";

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

  it.each([
    ["Google API Services Disclosure", <GoogleApiDisclosure />],
    ["Postora Privacy Policy", <Privacy />],
    ["Postora Terms of Service", <Terms />],
  ])("discloses the embedded player on %s", (_heading, page) => {
    const { container } = renderPage(page);

    expect(pageText(container)).toContain(EMBEDDED_PLAYER_DISCLOSURE);
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
    expect(text).toContain("videos.update");
    expect(text).toContain("title, description, tags");
    expect(text).toContain("and category");
    expect(text).toContain("Postora does not replace existing video media bytes or delete your videos.");
    expect(text).toContain("can create a new playlist on your channel when you explicitly ask (playlists.insert)");
    expect(text).toContain("can add a newly uploaded video to an existing playlist you choose through the narrower force-ssl scope");
    expect(text).toContain("does not rename, reorder, or delete playlists or remove playlist items, change channel settings, replace existing video media bytes, or delete videos");
    expect(text).not.toContain("does not create, rename, reorder, or delete playlists");
    expect(text).not.toContain("does not manage playlists or channel settings");
    expect(text).not.toContain("(managing playlists, editing or deleting existing videos, channel settings)");
    expect(text).not.toContain("This scope does not allow us to edit or delete your existing videos.");
  });

  it("describes published metadata editing as a live, verified and limited write", () => {
    const { container } = renderPage(<GoogleApiDisclosure />);
    const text = pageText(container);

    // The edit path is live on /youtube, not behind a gate.
    expect(text).not.toContain("currently disabled at the production baseline");
    expect(text).not.toContain("hard-off activation gate");
    expect(text).toContain("/youtube");
    // The write is conditional and the saved result is verified.
    expect(text).toContain("If-Match");
    expect(text).toContain("conditional write");
    expect(text).toContain("confirm the saved values");
    // The limiter and the shared budget are disclosed with their numbers.
    expect(text).toContain("10 per 10 minutes");
    expect(text).toContain("50 per 24 hours");
    expect(text).toContain("4,000 units per day");
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

  it("discloses reading the channel's playlists, creating a playlist on explicit instruction, and adding a new video to a chosen one", () => {
    const { container } = renderPage(<GoogleApiDisclosure />);
    const text = pageText(container);

    expect(text).toContain("List your channel's playlists");
    expect(text).toContain("playlists.list");
    expect(text).toContain("Create a new playlist on your channel when you explicitly ask");
    expect(text).toContain("playlists.insert");
    expect(text).toContain("add a newly uploaded video to an existing playlist");
    expect(text).toContain("playlistItems.insert");
    expect(text).toContain("Postora does not rename, reorder, or delete playlists, and does not remove items from a playlist.");
  });

  it("discloses listing a video's caption tracks and adding a new one, without touching the existing ones", () => {
    const { container } = renderPage(<GoogleApiDisclosure />);
    const text = pageText(container);

    expect(text).toContain("List the caption tracks of a video you already uploaded");
    expect(text).toContain("captions.list");
    expect(text).toContain("add a new caption track");
    expect(text).toContain("captions.insert");
    expect(text).toContain(".srt");
    expect(text).toContain(".vtt");
    expect(text).toContain("only when you ask for the list");
    expect(text).toContain("Postora never modifies, replaces, or deletes existing caption tracks");
  });

  it.each([
    ["Google API Services Disclosure", <GoogleApiDisclosure />],
    ["Postora Privacy Policy", <Privacy />],
    ["Postora Terms of Service", <Terms />],
  ])("discloses upload-time captions sent after video upload under youtube.force-ssl on %s", (_heading, page) => {
    const { container } = renderPage(page);
    const text = pageText(container);

    expect(text).toContain("attach an .srt or .vtt caption file to a new video upload in Create Post");
    expect(text).toContain("attach subtitles generated from the video's audio in Create Post");
    expect(text).toContain("after the video upload completes");
    expect(text).toContain("youtube.force-ssl");
  });

  it("discloses comparing public channels the user names, without storing the figures", () => {
    const { container } = renderPage(<GoogleApiDisclosure />);
    const text = pageText(container);

    expect(text).toContain("Compare up to three public YouTube channels you name");
    expect(text).toContain("channels.list");
    expect(text).toContain("playlistItems.list");
    expect(text).toContain("videos.list");
    expect(text).toContain("/youtube/benchmark");
    expect(text).toContain("Cache-Control: no-store");
    expect(text).toContain("never written to a database or to browser storage");
    expect(text).toContain("does not combine the figures of different channels into one score");
    expect(text).toContain("Public Channel Benchmark:");
  });

  it("reconciles the Privacy policy with the public channel benchmark", () => {
    const { container } = renderPage(<Privacy />);
    const text = pageText(container);

    expect(text).toContain(
      "The public statistics of up to three public YouTube channels you name yourself on the YouTube Channel Benchmark page",
    );
    expect(text).toContain(
      "Compare up to three public YouTube channels you name yourself on the YouTube Channel Benchmark page",
    );
    expect(text).toContain("Public channel benchmark figures are never stored");
    expect(text).toContain("Cache-Control: no-store");
    expect(text).toContain("without combining the figures of different channels into one score");
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
    expect(text).toContain("Published video metadata (title, description, tags and category) when you instruct Postora to edit a video you already uploaded");
    expect(text).toContain("The playlists of your channel (playlist ID, title, privacy status) when you open YouTube publishing settings for a single connected channel or choose a destination playlist for a video you publish");
    expect(text).toContain("let you browse your uploaded videos and their full details");
    expect(text).toContain("Edit published video metadata (title, description, tags and category) only when you instruct Postora to make that change");
    expect(text).toContain("Replace the thumbnail of a video you already uploaded with a JPEG or PNG image from your own media library, only when you pick the image and confirm the change");
    expect(text).toContain("The bytes of a JPEG or PNG image from your own Postora media library when you replace the thumbnail of a video you already uploaded");
    expect(text).toContain("List your channel's playlists so you can choose a destination playlist when publishing, create a new playlist on your channel when you explicitly instruct Postora in Create Post (playlists.insert), and add a newly uploaded video to the playlist you select");
    expect(text).toContain("Postora does not rename, reorder, or delete playlists and never removes playlist items");
    expect(text).toContain("The caption tracks of your videos (track ID, language, name, kind, status and draft flag) when you ask Postora to list them");
    expect(text).toContain("the text of an .srt or .vtt caption file you choose when you upload a new caption track");
    expect(text).toContain("List the caption tracks of a video you already uploaded and add a new caption track from an .srt or .vtt file you choose");
    expect(text).toContain("Postora never modifies, replaces, or deletes existing caption tracks");
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
    expect(text).toContain("published video metadata editing (title, description, tags and category)");
    expect(text).toContain("comment creation and moderation");
    expect(text).toContain("on-demand channel and video analytics");
    expect(text).toContain("accept the current Analytics Purpose Clause inside Postora for that connection");
  });
});
