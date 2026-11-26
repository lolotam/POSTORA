import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { YouTubeAISuggestions } from "../YouTubeAISuggestions";
import i18n from "@/i18n";

const { getSessionMock, invokeMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  invokeMock: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: getSessionMock },
    functions: { invoke: invokeMock },
  },
}));

const chapterBlock = "00:00 Introduction\n00:30 Main topic\n01:30 Conclusion";

function renderChapters(description = "Existing description", onSelect = vi.fn()) {
  render(
    <YouTubeAISuggestions
      type="chapters"
      context={chapterBlock}
      currentDescription={description}
      durationSeconds={120}
      onSelect={onSelect}
    />,
  );
  return onSelect;
}

async function generate(timing: "provided" | "estimated" = "provided") {
  const outlineInput = screen.getByLabelText("Timed outline");
  fireEvent.change(outlineInput, { target: { value: chapterBlock } });
  invokeMock.mockResolvedValue({
    data: { suggestions: [chapterBlock], timing },
    error: null,
  });
  fireEvent.click(screen.getByRole("button", { name: "Generate chapters" }));
  expect((await screen.findByLabelText("Chapter preview")).textContent).toBe(chapterBlock);
}

beforeEach(() => {
  invokeMock.mockReset();
  getSessionMock.mockReset();
  getSessionMock.mockResolvedValue({ data: { session: { user: { id: "user-1" } } } });
  void i18n.changeLanguage("en");
});

describe("YouTubeAISuggestions chapters", () => {
  it("generates a preview and inserts it only after explicit confirmation", async () => {
    const onSelect = renderChapters();
    expect(screen.getByText("Video duration: 02:00")).toBeInTheDocument();
    await generate();
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Insert chapters" }));
    expect(onSelect).toHaveBeenCalledWith(`Existing description\n\n${chapterBlock}`);
    expect(invokeMock).toHaveBeenCalledWith("generate-caption", {
      body: {
        context: chapterBlock,
        platform: "youtube",
        language: "english",
        requestType: "youtube_chapters",
        durationSeconds: 120,
        timing: "provided",
      },
    });
  });

  it("replaces an existing chapter block and preserves surrounding text", async () => {
    const description = `Before\n\n00:00 Old one\n00:10 Old two\n00:20 Old three\n\nAfter`;
    const onSelect = renderChapters(description);
    await generate();

    fireEvent.click(screen.getByRole("button", { name: "Insert chapters" }));
    expect(onSelect).toHaveBeenCalledWith(`Before\n\n${chapterBlock}\n\nAfter`);
  });

  it("refuses insertion when the description would exceed 5000 characters", async () => {
    const onSelect = renderChapters("x".repeat(4990));
    await generate();

    fireEvent.click(screen.getByRole("button", { name: "Insert chapters" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The description would exceed 5,000 characters");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps an estimate warning visible on the preview", async () => {
    renderChapters();
    fireEvent.click(screen.getByLabelText("Chapter timing"));
    fireEvent.click(await screen.findByText("Estimate timestamps"));
    await generate("estimated");

    expect(screen.getByRole("alert")).toHaveTextContent("These times are estimates. Check them against your video before publishing.");
    expect(invokeMock).toHaveBeenCalledWith("generate-caption", expect.objectContaining({
      body: expect.objectContaining({ timing: "estimated" }),
    }));
  });

  it("shows an invalid-chapters error and inserts nothing after a 422", async () => {
    const onSelect = renderChapters();
    fireEvent.change(screen.getByLabelText("Timed outline"), { target: { value: chapterBlock } });
    invokeMock.mockResolvedValue({ data: null, error: { status: 422, message: "Unprocessable entity" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate chapters" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The AI returned invalid chapters");
    expect(screen.queryByLabelText("Chapter preview")).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("shows Unknown when duration metadata is unavailable and starts the outline empty", () => {
    render(
      <YouTubeAISuggestions
        type="chapters"
        context="Video Title Should Not Prefill Outline"
        currentDescription=""
        durationSeconds={null}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Video duration: Unknown")).toBeInTheDocument();
    expect((screen.getByLabelText("Timed outline") as HTMLTextAreaElement).value).toBe("");
  });

  it("detects video duration from a videoSourceUrl via detached video metadata and forwards it to generate-caption", async () => {
    const originalCreateElement = document.createElement.bind(document);
    const createElementSpy = vi.spyOn(document, "createElement").mockImplementation(((tagName: string) => {
      const element = originalCreateElement(tagName);
      if (tagName === "video") {
        Object.defineProperty(element, "duration", { configurable: true, value: 185.7 });
        queueMicrotask(() => element.dispatchEvent(new Event("loadedmetadata")));
      }
      return element;
    }) as typeof document.createElement);

    try {
      render(
        <YouTubeAISuggestions
          type="chapters"
          context="Video Title"
          currentDescription=""
          videoSourceUrl="blob:https://postora.cloud/fixture-video"
          onSelect={vi.fn()}
        />,
      );
      expect(await screen.findByText("Video duration: 03:05")).toBeInTheDocument();
      await generate();
      expect(invokeMock).toHaveBeenCalledWith("generate-caption", expect.objectContaining({
        body: expect.objectContaining({ durationSeconds: 185 }),
      }));
    } finally {
      createElementSpy.mockRestore();
    }
  });

  it("does not call the provider for invalid output returned as data", async () => {
    const onSelect = renderChapters();
    fireEvent.change(screen.getByLabelText("Timed outline"), { target: { value: chapterBlock } });
    invokeMock.mockResolvedValue({ data: { error: "chapters_invalid" }, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Generate chapters" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The AI returned invalid chapters"));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
