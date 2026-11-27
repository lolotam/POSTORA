import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { YouTubeAISuggestions } from "../YouTubeAISuggestions";
import { buildYouTubeSuggestContext } from "../youtubeSuggestContext";
import i18n from "@/i18n";

const { getSessionMock, invokeMock, toastMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  invokeMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: getSessionMock },
    functions: { invoke: invokeMock },
  },
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
  toast: toastMock,
}));

beforeEach(() => {
  invokeMock.mockReset();
  getSessionMock.mockReset();
  toastMock.mockReset();
  getSessionMock.mockResolvedValue({ data: { session: { user: { id: "user-1" } } } });
  void i18n.changeLanguage("en");
});

describe("buildYouTubeSuggestContext", () => {
  it.each([
    {
      scenario: "title uses the title only",
      type: "title" as const,
      title: "How to Ship Faster",
      description: "Ignored draft notes",
      expected: "How to Ship Faster",
    },
    {
      scenario: "description with empty description uses the title only",
      type: "description" as const,
      title: "How to Ship Faster",
      description: "",
      expected: "How to Ship Faster",
    },
    {
      scenario: "description with whitespace-only description uses the title only",
      type: "description" as const,
      title: "How to Ship Faster",
      description: "   \n\t  ",
      expected: "How to Ship Faster",
    },
    {
      scenario: "description with undefined description uses the title only",
      type: "description" as const,
      title: "How to Ship Faster",
      description: undefined,
      expected: "How to Ship Faster",
    },
    {
      scenario: "description with a non-empty draft sends Title and Draft Description / Notes",
      type: "description" as const,
      title: "How to Ship Faster",
      description: "Key point 1: CI gates\nBooking: https://cal.example/team",
      expected: "Title: How to Ship Faster\nDraft Description / Notes: Key point 1: CI gates\nBooking: https://cal.example/team",
    },
    {
      scenario: "tags sends Title and Description",
      type: "tags" as const,
      title: "How to Ship Faster",
      description: "Deep dive on CI and CD",
      expected: "Title: How to Ship Faster\nDescription: Deep dive on CI and CD",
    },
    {
      scenario: "tags with undefined description sends empty Description field",
      type: "tags" as const,
      title: "How to Ship Faster",
      description: undefined,
      expected: "Title: How to Ship Faster\nDescription: ",
    },
  ])("$scenario", ({ type, title, description, expected }) => {
    expect(buildYouTubeSuggestContext(type, title, description)).toBe(expected);
  });
});

describe("YouTubeAISuggestions component", () => {
  it("sends both Title and Draft Description / Notes when generating description suggestions with a draft", async () => {
    const onSelect = vi.fn();
    invokeMock.mockResolvedValue({
      data: { suggestions: ["Suggested description 1"] },
      error: null,
    });

    render(
      <YouTubeAISuggestions
        type="description"
        context="My Video Title"
        secondaryContext="Draft notes with facts and links"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "AI Suggest" }));

    expect(await screen.findByText("Suggested description 1")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("generate-caption", {
      body: {
        context: "Title: My Video Title\nDraft Description / Notes: Draft notes with facts and links",
        platform: "youtube",
        language: "english",
        requestType: "youtube_description",
      },
    });

    fireEvent.click(screen.getByText("Suggested description 1"));
    expect(onSelect).toHaveBeenCalledWith("Suggested description 1");
  });

  it("sends only the title when generating description suggestions with an empty or whitespace draft", async () => {
    invokeMock.mockResolvedValue({
      data: { suggestions: ["Title-only description"] },
      error: null,
    });

    render(
      <YouTubeAISuggestions
        type="description"
        context="My Video Title"
        secondaryContext="   "
        onSelect={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "AI Suggest" }));

    expect(await screen.findByText("Title-only description")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("generate-caption", {
      body: {
        context: "My Video Title",
        platform: "youtube",
        language: "english",
        requestType: "youtube_description",
      },
    });
  });

  it("sends Title and Description when generating tag suggestions", async () => {
    const onSelect = vi.fn();
    invokeMock.mockResolvedValue({
      data: { suggestions: ["react, typescript, vite"] },
      error: null,
    });

    render(
      <YouTubeAISuggestions
        type="tags"
        context="React 18 Tutorial"
        secondaryContext="Full walkthrough of hooks and suspense"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "AI Suggest" }));

    expect(await screen.findByText("react, typescript, vite")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("generate-caption", {
      body: {
        context: "Title: React 18 Tutorial\nDescription: Full walkthrough of hooks and suspense",
        platform: "youtube",
        language: "english",
        requestType: "youtube_tags",
      },
    });

    fireEvent.click(screen.getByText("react, typescript, vite"));
    expect(onSelect).toHaveBeenCalledWith("react, typescript, vite");
  });

  it("handles 422 suggestions_invalid via handleAIError toast without crashing", async () => {
    const onSelect = vi.fn();
    invokeMock.mockResolvedValue({
      data: null,
      error: new FunctionsHttpError(
        new Response(JSON.stringify({ error: "suggestions_invalid" }), { status: 422 }),
      ),
    });

    render(
      <YouTubeAISuggestions
        type="title"
        context="My Video Title"
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "AI Suggest" }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "YouTube AI suggestion Failed",
          variant: "destructive",
        }),
      );
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  describe("chapters audio extraction and subtitle download", () => {
    it("disables audio extraction when videoSourceUrl is missing or a blob URL and shows upload hint", () => {
      const { rerender } = render(
        <YouTubeAISuggestions
          type="chapters"
          durationSeconds={120}
          videoSourceUrl={null}
          onSelect={vi.fn()}
        />,
      );

      const extractBtn = screen.getByRole("button", {
        name: "Extract chapters and subtitles from the video's audio",
      });
      expect(extractBtn).toBeDisabled();
      expect(screen.getByText("Available after the video is uploaded")).toBeInTheDocument();

      rerender(
        <YouTubeAISuggestions
          type="chapters"
          durationSeconds={120}
          videoSourceUrl="blob:https://postora.cloud/local-preview-1"
          onSelect={vi.fn()}
        />,
      );

      expect(
        screen.getByRole("button", {
          name: "Extract chapters and subtitles from the video's audio",
        }),
      ).toBeDisabled();
      expect(screen.getByText("Available after the video is uploaded")).toBeInTheDocument();
      expect(invokeMock).not.toHaveBeenCalled();
    });

    it("extracts timed segments into a 00:00 outline, switches timing to provided, and downloads .srt and .vtt without extra gateway calls", async () => {
      const onAudioSubtitlesReady = vi.fn();
      const segments = [
        { start: 0, end: 12, text: "Welcome and introduction" },
        { start: 35, end: 68, text: "Setting up the pipeline" },
        { start: 95, end: 120, text: "Final checks and conclusion" },
      ];
      invokeMock.mockResolvedValue({
        data: {
          transcript: "Welcome and introduction Setting up the pipeline Final checks and conclusion",
          language: "en",
          duration: 120,
          segments,
        },
        error: null,
      });

      const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:https://postora.cloud/sub-1");
      const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

      try {
        render(
          <YouTubeAISuggestions
            type="chapters"
            durationSeconds={120}
            videoSourceUrl="https://cdn.postora.cloud/uploads/video-123.mp4"
            onSelect={vi.fn()}
            onAudioSubtitlesReady={onAudioSubtitlesReady}
          />,
        );

        expect(screen.queryByText("Available after the video is uploaded")).not.toBeInTheDocument();

        fireEvent.click(screen.getByLabelText("Chapter timing"));
        fireEvent.click(await screen.findByText("Estimate timestamps"));
        expect(screen.getByLabelText("Chapter timing")).toHaveTextContent("Estimate timestamps");

        const extractBtn = screen.getByRole("button", {
          name: "Extract chapters and subtitles from the video's audio",
        });
        expect(extractBtn).toBeEnabled();
        fireEvent.click(extractBtn);

        const downloadSrtBtn = await screen.findByRole("button", { name: "Download .srt" });
        const downloadVttBtn = screen.getByRole("button", { name: "Download .vtt" });

        expect(invokeMock).toHaveBeenCalledTimes(1);
        expect(invokeMock).toHaveBeenCalledWith("transcribe-media", {
          body: { mediaUrl: "https://cdn.postora.cloud/uploads/video-123.mp4" },
        });

        const outlineInput = screen.getByLabelText("Timed outline") as HTMLTextAreaElement;
        expect(outlineInput.value).toBe(
          "00:00 Welcome and introduction\n00:35 Setting up the pipeline\n01:35 Final checks and conclusion",
        );
        expect(screen.getByLabelText("Chapter timing")).toHaveTextContent("Use my timestamps");
        expect(onAudioSubtitlesReady).toHaveBeenCalledWith({
          srt: expect.stringContaining("00:00:00,000 --> 00:00:12,000\nWelcome and introduction"),
          vtt: expect.stringContaining("WEBVTT\n\n00:00:00.000 --> 00:00:12.000\nWelcome and introduction"),
        });

        fireEvent.click(downloadSrtBtn);
        expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
        expect(anchorClickSpy).toHaveBeenCalledTimes(1);
        expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:https://postora.cloud/sub-1");

        fireEvent.click(downloadVttBtn);
        expect(createObjectUrlSpy).toHaveBeenCalledTimes(2);
        expect(anchorClickSpy).toHaveBeenCalledTimes(2);
        expect(revokeObjectUrlSpy).toHaveBeenCalledTimes(2);
        expect(invokeMock).toHaveBeenCalledTimes(1);
      } finally {
        createObjectUrlSpy.mockRestore();
        revokeObjectUrlSpy.mockRestore();
        anchorClickSpy.mockRestore();
      }
    });

    it("shows the no-timing notice and leaves outline and timing untouched when transcribe-media returns no segments", async () => {
      const onAudioSubtitlesReady = vi.fn();
      invokeMock.mockResolvedValue({
        data: {
          transcript: "Plain text transcript without timestamps",
          language: "en",
          duration: 90,
        },
        error: null,
      });

      render(
        <YouTubeAISuggestions
          type="chapters"
          durationSeconds={90}
          videoSourceUrl="https://cdn.postora.cloud/uploads/video-notiming.mp4"
          onSelect={vi.fn()}
          onAudioSubtitlesReady={onAudioSubtitlesReady}
        />,
      );

      const outlineInput = screen.getByLabelText("Timed outline") as HTMLTextAreaElement;
      fireEvent.change(outlineInput, { target: { value: "00:00 Existing notes" } });

      fireEvent.click(screen.getByLabelText("Chapter timing"));
      fireEvent.click(await screen.findByText("Estimate timestamps"));

      fireEvent.click(
        screen.getByRole("button", {
          name: "Extract chapters and subtitles from the video's audio",
        }),
      );

      expect(
        await screen.findByText(
          "This transcription has no timing, so chapters and subtitles cannot be built from it",
        ),
      ).toBeInTheDocument();
      expect(outlineInput.value).toBe("00:00 Existing notes");
      expect(screen.getByLabelText("Chapter timing")).toHaveTextContent("Estimate timestamps");
      expect(screen.queryByRole("button", { name: "Download .srt" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Download .vtt" })).not.toBeInTheDocument();
      expect(onAudioSubtitlesReady).toHaveBeenCalledWith(null);
    });

    it("ignores late transcription completions and clears auto-filled outline when videoSourceUrl changes", async () => {
      let resolveFirst: ((value: unknown) => void) | null = null;
      invokeMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      );

      const { rerender } = render(
        <YouTubeAISuggestions
          type="chapters"
          durationSeconds={120}
          videoSourceUrl="https://cdn.postora.cloud/uploads/video-a.mp4"
          onSelect={vi.fn()}
        />,
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: "Extract chapters and subtitles from the video's audio",
        }),
      );

      rerender(
        <YouTubeAISuggestions
          type="chapters"
          durationSeconds={180}
          videoSourceUrl="https://cdn.postora.cloud/uploads/video-b.mp4"
          onSelect={vi.fn()}
        />,
      );

      resolveFirst?.({
        data: {
          transcript: "Stale video A transcript",
          language: "en",
          duration: 120,
          segments: [{ start: 0, end: 10, text: "Stale video A segment" }],
        },
        error: null,
      });

      await waitFor(() => {
        expect(invokeMock).toHaveBeenCalledTimes(1);
      });

      const outlineInput = screen.getByLabelText("Timed outline") as HTMLTextAreaElement;
      expect(outlineInput.value).toBe("");
      expect(screen.queryByRole("button", { name: "Download .srt" })).not.toBeInTheDocument();
    });
  });
});
