import { createElement } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  getSafeHttpsUrl,
  getSafePlatformPostUrl,
  getSafeTikTokEmbedUrl,
  openSafePlatformPostUrl,
} from "@/lib/safeExternalUrl";
import { ProfileCard } from "../ProfileCard";
import { PostDetailDrawer } from "../PostDetailDrawer";
import BrandIntelligencePost from "@/pages/BrandIntelligencePost";
import type { BrandPost, BrandProfile } from "@/types/brand-intelligence";

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: unknown }) => createElement("div", null, children),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: null }),
}));

vi.mock("@/hooks/useTranscription", () => ({
  useTranscription: () => ({
    transcript: null,
    language: null,
    duration: null,
    isTranscribing: false,
    error: null,
    transcribe: vi.fn(),
    reset: vi.fn(),
  }),
}));

vi.mock("@/hooks/useOwnedThreadsAccounts", () => ({
  useOwnedThreadsAccounts: () => ({
    ownsUsername: () => null,
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }),
    }),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const baseProfile = (overrides: Partial<BrandProfile> = {}): BrandProfile => ({
  id: "prof-1",
  username: "testbrand",
  fullName: "Test Brand",
  bio: "Bio text",
  avatarUrl: "https://cdn.example.com/avatar.jpg",
  followersCount: 100,
  followingCount: 10,
  postsCount: 5,
  isVerified: false,
  platform: "instagram",
  ...overrides,
});

const basePost = (overrides: Partial<BrandPost> = {}): BrandPost => ({
  id: "post-1",
  mediaType: "VIDEO",
  thumbnailUrl: "https://cdn.example.com/thumb.jpg",
  mediaUrl: "https://www.tiktok.com/embed/v2/123456",
  caption: "Test caption",
  likesCount: 42,
  commentsCount: 3,
  engagementScore: 45,
  timestamp: "2026-10-30T08:00:00Z",
  permalink: "https://www.instagram.com/p/abc123/",
  ...overrides,
});

function renderBrandIntelligencePostPage(post: BrandPost, platform = "tiktok") {
  return render(
    createElement(
      MemoryRouter,
      { initialEntries: [{ pathname: `/brand-intelligence/post/${post.id}`, state: { post, platform } }] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/brand-intelligence/post/:postId",
          element: createElement(BrandIntelligencePost),
        }),
      ),
    ),
  );
}

describe("safeExternalUrl validation", () => {
  it.each([
    ["javascript:alert(1)"],
    ["javascript://instagram.com/%0aalert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["http://www.instagram.com/p/abc/"],
    ["https://user:pass@www.instagram.com/p/abc/"],
    [""],
    ["   "],
    [null],
    [undefined],
  ])("getSafeHttpsUrl rejects non-https or malformed URL %s", (raw) => {
    expect(getSafeHttpsUrl(raw)).toBeNull();
  });

  it("getSafeHttpsUrl accepts valid https website URLs", () => {
    expect(getSafeHttpsUrl("https://brand.example.com/shop?ref=bio")).toBe(
      "https://brand.example.com/shop?ref=bio",
    );
  });

  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["http://www.instagram.com/p/abc/"],
    ["https://evil.example/instagram.com/p/123"],
    ["https://instagram.com.evil.example/p/123"],
    ["https://evil.example/?next=https://www.tiktok.com/@u/video/1"],
  ])("getSafePlatformPostUrl rejects untrusted or spoofed post URL %s", (raw) => {
    expect(getSafePlatformPostUrl(raw)).toBeNull();
  });

  it.each([
    ["https://www.instagram.com/p/abc/"],
    ["https://www.tiktok.com/@user/video/123"],
    ["https://www.threads.net/@user/post/123"],
    ["https://www.threads.com/@user/post/123"],
    ["https://www.facebook.com/reel/123"],
  ])("getSafePlatformPostUrl accepts valid platform post URL %s", (raw) => {
    expect(getSafePlatformPostUrl(raw)).toBe(raw);
  });

  it.each([
    ["https://evil.example/tiktok.com/embed/123"],
    ["https://tiktok.com.evil.example/embed/123"],
    ["http://www.tiktok.com/embed/123"],
    ["javascript://tiktok.com/embed/123"],
    ["https://www.tiktok.com/@user/video/123"],
  ])("getSafeTikTokEmbedUrl rejects unanchored or non-embed URL %s", (raw) => {
    expect(getSafeTikTokEmbedUrl(raw)).toBeNull();
  });

  it.each([
    ["https://www.tiktok.com/embed/v2/123456"],
    ["https://tiktok.com/player/v1/123456"],
  ])("getSafeTikTokEmbedUrl accepts legitimate TikTok embed URL %s", (raw) => {
    expect(getSafeTikTokEmbedUrl(raw)).toBe(raw);
  });

  it("openSafePlatformPostUrl passes noopener,noreferrer for valid platform URLs and blocks unsafe ones", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    openSafePlatformPostUrl("https://evil.example/threads.net/post/1");
    openSafePlatformPostUrl("javascript:alert(1)");
    expect(openSpy).not.toHaveBeenCalled();

    openSafePlatformPostUrl("https://www.threads.net/@user/post/123");
    expect(openSpy).toHaveBeenCalledWith(
      "https://www.threads.net/@user/post/123",
      "_blank",
      "noopener,noreferrer",
    );
  });
});

describe("brand-intelligence component URL rendering guards", () => {
  it("ProfileCard hides unsafe website link and renders safe https website link with noopener noreferrer", () => {
    const { rerender } = render(
      createElement(ProfileCard, {
        profile: baseProfile({ website: "javascript:alert(1)" }),
        isLoading: false,
      }),
    );
    expect(screen.queryByRole("link", { name: /Website/i })).not.toBeInTheDocument();

    rerender(
      createElement(ProfileCard, {
        profile: baseProfile({ website: "https://acme.example.com/" }),
        isLoading: false,
      }),
    );
    const websiteLink = screen.getByRole("link", { name: /Website/i });
    expect(websiteLink).toHaveAttribute("href", "https://acme.example.com/");
    expect(websiteLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("PostDetailDrawer blocks spoofed TikTok iframe and spoofed permalink while allowing legitimate ones", () => {
    const { rerender } = render(
      createElement(PostDetailDrawer, {
        isOpen: true,
        onClose: () => undefined,
        post: basePost({
          mediaUrl: "https://evil.example/tiktok.com/embed/v2/123",
          permalink: "https://instagram.com.evil.example/p/abc",
        }),
      }),
    );

    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("link", { name: /View Original/i })).not.toBeInTheDocument();

    rerender(
      createElement(PostDetailDrawer, {
        isOpen: true,
        onClose: () => undefined,
        post: basePost({
          mediaUrl: "https://www.tiktok.com/embed/v2/123456",
          permalink: "https://www.instagram.com/p/abc123/",
        }),
      }),
    );

    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute("src", "https://www.tiktok.com/embed/v2/123456");

    const originalLink = screen.getByRole("link", { name: /View Original/i });
    expect(originalLink).toHaveAttribute("href", "https://www.instagram.com/p/abc123/");
    expect(originalLink).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("BrandIntelligencePost blocks spoofed TikTok iframe and spoofed permalink while allowing legitimate ones", () => {
    renderBrandIntelligencePostPage(
      basePost({
        mediaUrl: "https://evil.example/tiktok.com/embed/v2/123",
        permalink: "https://tiktok.com.evil.example/@user/video/123",
      }),
    );

    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("link", { name: /View on TikTok/i })).not.toBeInTheDocument();

    cleanup();

    renderBrandIntelligencePostPage(
      basePost({
        mediaUrl: "https://www.tiktok.com/embed/v2/123456",
        permalink: "https://www.tiktok.com/@user/video/123456",
      }),
    );

    const iframe = document.querySelector("iframe");
    expect(iframe).not.toBeNull();
    expect(iframe).toHaveAttribute("src", "https://www.tiktok.com/embed/v2/123456");

    const tiktokLink = screen.getByRole("link", { name: /View on TikTok/i });
    expect(tiktokLink).toHaveAttribute("href", "https://www.tiktok.com/@user/video/123456");
    expect(tiktokLink).toHaveAttribute("rel", "noopener noreferrer");
  });
});
