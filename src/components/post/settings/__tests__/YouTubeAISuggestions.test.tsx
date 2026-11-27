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
});
