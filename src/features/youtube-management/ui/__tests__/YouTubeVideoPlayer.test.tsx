import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { YOUTUBE_EMBED_ORIGIN } from "../../domain/player";
import { YouTubeVideoPlayer } from "../YouTubeVideoPlayer";

const VIDEO_ID = "AbcD1234eFg";

async function renderPlayer(ui: ReactElement, language = "en") {
  const i18n = createInstance();
  await i18n.init({ lng: language, resources: { [language]: { accounts: {} } }, defaultNS: "accounts" });
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>);
}

function player(overrides: Partial<Parameters<typeof YouTubeVideoPlayer>[0]> = {}) {
  return (
    <YouTubeVideoPlayer
      videoId={VIDEO_ID}
      title="First video"
      thumbnailUrl="https://img.test/thumb.jpg"
      durationIso8601="PT4M13S"
      privacyStatus="public"
      {...overrides}
    />
  );
}

function mountedIframe(): HTMLIFrameElement {
  const frame = document.querySelector("iframe");
  if (!frame) throw new Error("the player iframe is not mounted");
  return frame;
}

function reportFromEmbed(data: unknown, origin = YOUTUBE_EMBED_ORIGIN, source?: Window | null) {
  const frame = mountedIframe();
  const event = new MessageEvent("message", { data });
  // jsdom does not carry the init dict's `origin` and `source` into the
  // event, and the player checks both, so they are set on the event itself.
  Object.defineProperty(event, "origin", { value: origin });
  Object.defineProperty(event, "source", { value: source ?? frame.contentWindow });
  // The report arrives on a native listener, so React batches the state
  // update it triggers; act() flushes that update before the assertion.
  act(() => {
    window.dispatchEvent(event);
  });
}

beforeEach(cleanup);
afterEach(() => {
  vi.useRealTimers();
});

describe("the poster before Play", () => {
  it("shows the thumbnail, the duration and a real Play button, and no iframe", async () => {
    await renderPlayer(player());

    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: "Play video" })).toBeInTheDocument();
    expect(screen.getByText("4:13")).toBeInTheDocument();
    expect(screen.getByText("Click Play to load the video from youtube-nocookie.com")).toBeInTheDocument();
  });

  it("offers no Play button when the id is not a video id", async () => {
    await renderPlayer(player({ videoId: "not-an-id" }));

    expect(screen.queryByRole("button", { name: "Play video" })).not.toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("says when the video has no preview image", async () => {
    await renderPlayer(player({ thumbnailUrl: null }));

    expect(screen.getByText("No preview image for this video")).toBeInTheDocument();
  });
});

describe("the mounted embed", () => {
  it("mounts the privacy-enhanced frame with its attributes after Play", async () => {
    await renderPlayer(player());

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    const frame = mountedIframe();
    expect(frame.getAttribute("src")).toContain("https://www.youtube-nocookie.com/embed/AbcD1234eFg");
    expect(frame.getAttribute("src")).toContain("enablejsapi=1");
    expect(frame).toHaveAttribute("title", "First video");
    expect(frame).toHaveAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
    expect(frame).toHaveAttribute("allowfullscreen");
    expect(frame).toHaveAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    expect(screen.queryByRole("button", { name: "Play video" })).not.toBeInTheDocument();
  });

  it("ignores a report from another origin and one from another window", async () => {
    await renderPlayer(player());
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    reportFromEmbed({ event: "infoDelivery", info: { playbackQuality: "hd720" } }, "https://evil.example");
    reportFromEmbed({ event: "infoDelivery", info: { playbackQuality: "hd720" } }, YOUTUBE_EMBED_ORIGIN, window);

    expect(screen.queryByText(/hd720/)).not.toBeInTheDocument();
  });

  it("reads the state the embed reports", async () => {
    await renderPlayer(player());
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    reportFromEmbed({ event: "infoDelivery", info: { playbackQuality: "hd1080", playbackRate: 1.5 } });

    expect(screen.getByText(/hd1080/)).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("1.5");
  });

  it("sends a command to the embed's own origin", async () => {
    await renderPlayer(player());
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    const spy = vi.spyOn(mountedIframe().contentWindow as Window, "postMessage");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    expect(spy).toHaveBeenCalledWith(expect.stringContaining('"func":"pauseVideo"'), YOUTUBE_EMBED_ORIGIN);
  });

  it("returns to the poster when the creator stops the video", async () => {
    await renderPlayer(player());
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByRole("button", { name: "Play video" })).toBeInTheDocument();
  });
});

describe("the handshake", () => {
  it("hides the playback group when the embed stays silent, and keeps the rest", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await renderPlayer(player());

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));
    fireEvent.load(mountedIframe());
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
    expect(screen.queryByRole("slider", { name: "Volume" })).not.toBeInTheDocument();
    expect(screen.getByText("Use the controls inside the video player.")).toBeInTheDocument();
    // The controls that do not need a message keep working.
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mini" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open on YouTube" })).toBeInTheDocument();
  });

  it("keeps the playback group when the embed reports its state", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await renderPlayer(player());

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));
    fireEvent.load(mountedIframe());
    reportFromEmbed({ event: "onReady", info: { playerState: 1 } });

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.queryByText("Use the controls inside the video player.")).not.toBeInTheDocument();
  });
});

describe("the size modes", () => {
  it("shrinks the player to a 200 by 200 minimum in Mini", async () => {
    await renderPlayer(player());

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));
    fireEvent.click(screen.getByRole("button", { name: "Mini" }));

    expect(mountedIframe().parentElement).toHaveClass(
      "w-[356px]",
      "h-[200px]",
      "min-w-[200px]",
      "min-h-[200px]",
      "sticky",
      "top-0",
      "z-10",
    );
  });

  it("keeps the same frame mounted when the size changes", async () => {
    await renderPlayer(player());

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));
    const before = mountedIframe();
    fireEvent.click(screen.getByRole("button", { name: "Theater" }));

    expect(mountedIframe()).toBe(before);
  });

  it("reports the chosen size to the drawer", async () => {
    const onSizeModeChange = vi.fn();
    await renderPlayer(player({ onSizeModeChange }));

    fireEvent.click(screen.getByRole("button", { name: "Theater" }));

    expect(onSizeModeChange).toHaveBeenCalledWith("theater");
  });
});

describe("the notices", () => {
  it("warns that a private video plays only for its owner", async () => {
    await renderPlayer(player({ privacyStatus: "private" }));

    expect(
      screen.getAllByText(/This video is private\. It plays here only if this browser is signed in/),
    ).not.toHaveLength(0);
  });

  it("warns that YouTube may still be processing the video", async () => {
    await renderPlayer(player({ uploadStatus: "processing" }));

    expect(screen.getByText("YouTube may still be processing this video.")).toBeInTheDocument();
  });

  it("says nothing about processing once the video is processed", async () => {
    await renderPlayer(player({ uploadStatus: "processed" }));

    expect(screen.queryByText("YouTube may still be processing this video.")).not.toBeInTheDocument();
  });
});

describe("an Arabic page", () => {
  it("keeps the numeric controls left-to-right", async () => {
    await renderPlayer(player(), "ar");

    const volume = screen.getByRole("slider", { name: "Volume" });
    expect(volume.closest("[dir]")).toHaveAttribute("dir", "ltr");
  });
});
