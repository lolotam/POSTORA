import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CaptionSection } from "../CaptionSection";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock supabase
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: {
      invoke: vi.fn().mockResolvedValue({ data: { caption: "Generated caption" } }),
    },
  },
}));

// CaptionSection renders HashtagSuggestions, which reads useAuth and therefore
// requires an AuthProvider. Mocking the hook keeps this a focused unit test.
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "test@example.com" },
    profile: { id: "user-1", full_name: "Test User" },
    session: null,
    loading: false,
  }),
}));

// Mock useFeatureFlags hook
vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({
    flags: {
      aiCaption: true,
      aiHashtags: true,
      aiImage: true,
      aiThumbnails: true,
      // Gates the "Required for all media posts" label asserted below.
      titleRequired: true,
      imageCrop: true,
      videoCompress: true,
      tiktokTranscode: true,
    },
    isLoading: false,
    broadcastRefresh: vi.fn(),
  }),
}));

// Mock the child components
vi.mock("../HashtagSuggestions", () => ({
  HashtagSuggestions: ({ caption, platform, onAddHashtags }: any) => (
    <div data-testid="hashtag-suggestions">
      <span>Caption length: {caption.length}</span>
      <span>Platform: {platform}</span>
      <button onClick={() => onAddHashtags(["#test", "#vitest"])}>
        Add Hashtags
      </button>
    </div>
  ),
}));

vi.mock("../CharacterCounter", () => ({
  CharacterCounter: ({ caption, selectedPlatforms }: any) => (
    <div data-testid="character-counter">
      <span>{caption.length} chars</span>
      <span>{selectedPlatforms.length} platforms</span>
    </div>
  ),
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe("CaptionSection", () => {
  const defaultProps = {
    caption: "",
    setCaption: vi.fn(),
    selectedPlatforms: ["instagram"] as any[],
    aiModel: "gpt-4",
    showSuccessToast: vi.fn(),
  };

  it("renders caption textarea", () => {
    render(<CaptionSection {...defaultProps} />, { wrapper: createWrapper() });
    expect(screen.getByPlaceholderText("Enter title for your post")).toBeInTheDocument();
  });

  it("displays current caption in textarea", () => {
    render(<CaptionSection {...defaultProps} caption="Hello world" />, { wrapper: createWrapper() });
    const textarea = screen.getByPlaceholderText("Enter title for your post");
    expect(textarea).toHaveValue("Hello world");
  });

  it("calls setCaption when typing in textarea", () => {
    const setCaption = vi.fn();
    render(<CaptionSection {...defaultProps} setCaption={setCaption} />, { wrapper: createWrapper() });
    
    const textarea = screen.getByPlaceholderText("Enter title for your post");
    fireEvent.change(textarea, { target: { value: "New caption" } });
    
    expect(setCaption).toHaveBeenCalledWith("New caption");
  });

  it("renders HashtagSuggestions component", () => {
    render(<CaptionSection {...defaultProps} />, { wrapper: createWrapper() });
    expect(screen.getByTestId("hashtag-suggestions")).toBeInTheDocument();
  });

  it("renders CharacterCounter component", () => {
    render(<CaptionSection {...defaultProps} />, { wrapper: createWrapper() });
    expect(screen.getByTestId("character-counter")).toBeInTheDocument();
  });

  it("passes caption to child components", () => {
    render(<CaptionSection {...defaultProps} caption="Test caption here" />, { wrapper: createWrapper() });
    expect(screen.getByText("Caption length: 17")).toBeInTheDocument();
    expect(screen.getByText("17 chars")).toBeInTheDocument();
  });

  it("passes first platform to HashtagSuggestions", () => {
    render(
      <CaptionSection
        {...defaultProps}
        selectedPlatforms={["tiktok", "instagram"]}
      />,
      { wrapper: createWrapper() }
    );
    expect(screen.getByText("Platform: tiktok")).toBeInTheDocument();
  });

  it("uses instagram as default platform when none selected", () => {
    render(<CaptionSection {...defaultProps} selectedPlatforms={[]} />, { wrapper: createWrapper() });
    expect(screen.getByText("Platform: instagram")).toBeInTheDocument();
  });

  it("renders AI generate button", () => {
    render(<CaptionSection {...defaultProps} />, { wrapper: createWrapper() });
    expect(screen.getByText("Generate with AI")).toBeInTheDocument();
  });

  it("shows required label for title", () => {
    render(<CaptionSection {...defaultProps} />, { wrapper: createWrapper() });
    expect(screen.getByText("Required for all media posts")).toBeInTheDocument();
  });

  it("updates caption when hashtags are added", () => {
    const setCaption = vi.fn();
    render(
      <CaptionSection {...defaultProps} setCaption={setCaption} caption="My post" />,
      { wrapper: createWrapper() }
    );
    
    const addButton = screen.getByText("Add Hashtags");
    fireEvent.click(addButton);
    
    expect(setCaption).toHaveBeenCalledWith("My post\n\n#test #vitest");
  });
});
