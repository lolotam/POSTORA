import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { YouTubeSettings, type YouTubeSettingsState } from "../YouTubeSettings";

// The component reads its copy from the postsettings namespace and interpolates
// a few values; the mock keeps the English defaults and fills the placeholders
// so the assertions can read the sentences a creator actually sees.
const translate = vi.hoisted(() => (
  key: string,
  fallback?: string | Record<string, unknown>,
  options?: Record<string, unknown>,
) => {
  const template = typeof fallback === "string" ? fallback : key;
  const vars = typeof fallback === "string" ? options : fallback;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate, i18n: { language: "en" } }),
}));
vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: { aiThumbnails: false } }),
}));
vi.mock("@/hooks/useResolvedImageModels", () => ({
  useResolvedImageModels: () => ({ tiers: [], isLoading: false }),
}));
vi.mock("@/hooks/useYouTubeCategories", () => ({
  useYouTubeCategories: () => ({
    categories: [],
    loading: false,
    unavailable: false,
    region: "US",
    retry: vi.fn(),
  }),
}));
vi.mock("../YouTubeAISuggestions", () => ({ YouTubeAISuggestions: () => null }));
vi.mock("../../MediaLibraryPicker", () => ({ MediaLibraryPicker: () => null }));
vi.mock("../../StockMediaPicker", () => ({ StockMediaPicker: () => null }));
// The card list is only shown inside the thumbnail dialog and pulls the real
// i18next bundle in, which this suite deliberately keeps out of the way.
vi.mock("@/components/ai/ResolvedModelCards", () => ({ ResolvedModelCards: () => null }));

afterEach(cleanup);

const BASE_SETTINGS: YouTubeSettingsState = {
  videoType: "video",
  title: "A video",
  description: "A description",
  visibility: "public",
  tags: "",
  category: "22",
  madeForKids: false,
  allowEmbedding: true,
  publicStatsViewable: true,
  containsSyntheticMedia: false,
  hasPaidPromotion: false,
  notifySubscribers: true,
  commentsEnabled: true,
  commentModeration: "none",
  whoCanComment: "anyone",
  commentSortBy: "top",
  showLikeCount: true,
  shortsRemixing: "none",
  recordingDate: "",
  videoLocation: "",
  license: "youtube",
  videoLanguage: "",
  audioLanguage: "",
  captionCertification: "none",
  titleDescLanguage: "",
  thumbnailMode: "auto",
  thumbnailUrl: "",
  thumbnailMediaId: null,
  thumbnailFile: null,
  playlist: "",
  allowedCountries: "",
  blockedCountries: "",
  firstComment: "",
  enableFirstComment: false,
};

interface TestAccount {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
  auth_provider?: "native" | "composio";
}

/**
 * Renders the settings the way the post form does: the parent owns the state
 * and writes every change back, so the component sees its own output.
 */
function renderSettings(
  overrides: Partial<YouTubeSettingsState> = {},
  selectedAccounts: TestAccount[] = [],
) {
  const onSettingsChange = vi.fn();

  function Harness() {
    const [settings, setSettings] = useState<YouTubeSettingsState>({
      ...BASE_SETTINGS,
      ...overrides,
    });
    return (
      <YouTubeSettings
        settings={settings}
        onSettingsChange={(changes) => {
          onSettingsChange(changes);
          setSettings((current) => ({ ...current, ...changes }));
        }}
        hasVideo={false}
        autoThumbnails={[]}
        selectedAutoThumbnail={null}
        onSelectAutoThumbnail={vi.fn()}
        onGenerateAutoThumbnails={vi.fn()}
        aiGeneratedThumbnails={[]}
        onGenerateAiThumbnail={vi.fn()}
        isGeneratingAiThumbnail={false}
        onDownloadThumbnail={vi.fn()}
        selectedAccounts={selectedAccounts}
      />
    );
  }

  render(<Harness />);
  return { onSettingsChange };
}

/** The privacy `<Select>` lives in the block labelled "Privacy". */
function privacySelect() {
  const block = screen.getByText("Privacy").closest("div");
  return within(block as HTMLElement).queryByRole("combobox");
}

function preview() {
  return screen.getByTestId("youtube-send-preview");
}

function scheduleRadio() {
  return screen.getByRole("radio", { name: "Schedule on YouTube" });
}

function privacyRadio() {
  return screen.getByRole("radio", { name: "Use the privacy above" });
}

function publishAtInput() {
  return screen.getByLabelText("YouTube publish date and time") as HTMLInputElement;
}

/** The `datetime-local` value the browser speaks: local wall-clock, minute precision. */
function localDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function minutesFromNow(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

function yearsFromNow(years: number): Date {
  const date = new Date();
  date.setFullYear(date.getFullYear() + years);
  return date;
}

describe("YouTubeSettings native scheduling (status.publishAt)", () => {
  it("keeps the privacy control and hides every scheduling affordance by default", () => {
    renderSettings();

    expect(privacySelect()).not.toBeNull();
    expect(screen.queryByLabelText("YouTube publish date and time")).toBeNull();
    expect(screen.queryByTestId("youtube-scheduled-privacy-notice")).toBeNull();
    expect(preview()).toHaveTextContent("Requested privacy: public");
    expect(preview()).not.toHaveTextContent("Scheduled on YouTube");
    expect(privacyRadio()).toBeChecked();
  });

  it("replaces the privacy control with the fixed line and asks for a time", () => {
    renderSettings();

    fireEvent.click(scheduleRadio());

    expect(privacySelect()).toBeNull();
    expect(screen.getByTestId("youtube-scheduled-privacy-notice")).toHaveTextContent(
      "Private until then. YouTube makes it public at the scheduled time.",
    );
    expect(
      screen.getByText(
        "Postora's schedule decides when the upload starts; YouTube's decides when the uploaded video becomes public.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("youtube-publish-at-error")).toHaveTextContent(
      "Choose a YouTube scheduled publish date and time.",
    );
  });

  it("converts the picked local time to a UTC timestamp and previews it as private", () => {
    const { onSettingsChange } = renderSettings();

    fireEvent.click(scheduleRadio());

    const localValue = localDateTimeValue(minutesFromNow(24 * 60));
    const expectedIso = new Date(localValue).toISOString();

    fireEvent.change(publishAtInput(), { target: { value: localValue } });

    const emitted = onSettingsChange.mock.calls.at(-1)?.[0] as { publishAt?: string } | undefined;
    expect(emitted?.publishAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(emitted?.publishAt).toBe(expectedIso);
    expect(preview()).toHaveTextContent("Requested privacy: private");
    expect(preview()).toHaveTextContent(`Scheduled on YouTube: ${expectedIso}`);
    expect(screen.queryByTestId("youtube-publish-at-error")).toBeNull();
  });

  it.each([
    {
      scenario: "inside YouTube's 15-minute lead time",
      valueAt: () => minutesFromNow(5),
      message: "YouTube scheduled publish time must be at least 15 minutes in the future.",
    },
    {
      scenario: "more than two years ahead",
      valueAt: () => yearsFromNow(3),
      message: "YouTube scheduled publish time cannot be more than 2 years in the future.",
    },
  ])("refuses a schedule $scenario", ({ valueAt, message }) => {
    renderSettings();

    fireEvent.click(scheduleRadio());
    fireEvent.change(publishAtInput(), {
      target: { value: localDateTimeValue(valueAt()) },
    });

    expect(screen.getByTestId("youtube-publish-at-error")).toHaveTextContent(message);
  });

  it("reports a stored timestamp that is already too soon", () => {
    const tooSoon = minutesFromNow(5).toISOString();
    renderSettings({ publishAt: tooSoon });

    expect(screen.getByTestId("youtube-publish-at-error")).toHaveTextContent(
      "YouTube scheduled publish time must be at least 15 minutes in the future.",
    );
    expect(preview()).toHaveTextContent("Requested privacy: private");
  });

  it("clears the timestamp when the creator returns to the privacy above", () => {
    const scheduled = minutesFromNow(24 * 60).toISOString();
    const { onSettingsChange } = renderSettings({ publishAt: scheduled, scheduleRequested: true });

    expect(preview()).toHaveTextContent(`Scheduled on YouTube: ${scheduled}`);

    fireEvent.click(privacyRadio());

    expect(onSettingsChange).toHaveBeenCalledWith({
      publishAt: "",
      scheduleRequested: false,
    });
    expect(privacySelect()).not.toBeNull();
    expect(screen.queryByLabelText("YouTube publish date and time")).toBeNull();
    expect(preview()).not.toHaveTextContent("Scheduled on YouTube");
    expect(preview()).toHaveTextContent("Requested privacy: public");
  });

  it("disables the schedule for a channel this provider cannot publish from", () => {
    renderSettings({}, [
      {
        id: "account-1",
        platform_username: "managed",
        avatar_url: null,
        auth_provider: "composio",
      },
    ]);

    expect(scheduleRadio()).toBeDisabled();
    expect(
      screen.getByText(
        "Native YouTube scheduling is not available for managed accounts. Use a native channel.",
      ),
    ).toBeInTheDocument();
    expect(preview()).toHaveTextContent("Requested privacy: public");
    expect(preview()).not.toHaveTextContent("Scheduled on YouTube");
  });

  it("does not promise a YouTube schedule for a managed channel that still holds a timestamp", () => {
    const scheduled = minutesFromNow(24 * 60).toISOString();
    renderSettings({ publishAt: scheduled }, [
      {
        id: "account-1",
        platform_username: "managed",
        avatar_url: null,
        auth_provider: "composio",
      },
    ]);

    // The key never reaches a managed channel, so the preview must not claim
    // the video will go public on YouTube at that time.
    expect(scheduleRadio()).toBeDisabled();
    expect(screen.queryByLabelText("YouTube publish date and time")).toBeNull();
    expect(preview()).not.toHaveTextContent("Scheduled on YouTube");
    expect(preview()).toHaveTextContent("Requested privacy: public");
  });
});
