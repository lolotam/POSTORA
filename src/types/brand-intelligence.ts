import type { CompetitorSourceValue } from "@/features/competitor-tracking";

export type BrandPlatform = 'instagram' | 'threads' | 'facebook' | 'tiktok';
export type MediaType = 'IMAGE' | 'VIDEO' | 'REEL' | 'CAROUSEL' | 'TEXT';
export type ContentTone = 'professional' | 'casual' | 'inspirational' | 'educational' | 'humorous';
export type ContentLanguage = 'arabic' | 'english' | 'both';

/**
 * The provenance of one observation.
 *
 * The vocabulary is the competitor tracking feature's own source
 * vocabulary, so a brand intelligence card and a tracked competitor row
 * say the same thing about the same thing. There is ONE definition of
 * it (ARCHITECTURE §22) and it is the feature's.
 *
 * `unknown` is a real answer, not a stand-in for a missing one: it
 * means the producer recorded no source.
 */
export type BrandProfileSource = CompetitorSourceValue;

/**
 * Reads a source the producer STATED.
 *
 * A value this code does not know is `unknown` and never a guess. The
 * source of an observation is never inferred from the handle, from the
 * platform or from the strategy the scrape happened to use: a cached
 * answer, an official-looking handle and a Meta API strategy are all
 * facts about HOW the data was fetched, not about where the numbers
 * came from (T8-01).
 */
export function resolveBrandProfileSource(value: unknown): BrandProfileSource {
  if (value === "official" || value === "apify" || value === "graph_own") return value;
  return "unknown";
}

export interface BrandProfile {
  id: string;
  username: string;
  fullName: string;
  bio: string;
  avatarUrl: string;
  followersCount: number | null;
  followingCount: number | null;
  postsCount: number | null;
  isVerified: boolean;
  website?: string;
  platform: BrandPlatform;
  totalHearts?: number;
  /**
   * The source of this observation, when the producer recorded one.
   *
   * The field is absent until the producer publishes it; the card then
   * says "unknown" rather than guessing (T8-01).
   */
  source?: BrandProfileSource;
}

export interface BrandPost {
  id: string;
  mediaType: MediaType;
  thumbnailUrl: string;
  mediaUrl?: string;
  caption: string;
  likesCount: number | null;
  commentsCount: number | null;
  videoViewCount?: number | null;
  sharesCount?: number | null;
  savesCount?: number | null;
  bookmarksCount?: number | null;
  engagementScore: number | null;
  timestamp: string;
  permalink: string;
  // TikTok-specific
  hashtags?: string[];
  songTitle?: string;
  duration?: number;
}

export interface BrandScrapeFilters {
  sortBy: 'engagement' | 'likes' | 'comments' | 'views' | 'newest' | 'oldest' | 'shares' | 'saves';
  mediaType: 'all' | 'image' | 'video' | 'carousel' | 'reel';
  period: '30d' | '3m' | '6m' | '1y' | 'all';
  minEngagement: number;
}

export interface BrandScrapeSession {
  id: string;
  user_id: string;
  platform: string;
  username: string;
  profile_data: BrandProfile | null;
  posts_data: BrandPost[] | null;
  total_posts_fetched: number | null;
  /**
   * The strategy the scrape used: `official`, `apify`, `cache` or
   * `unknown`. It says HOW the data was fetched.
   */
  strategy_used: string | null;
  /**
   * The source of the observation, when the session recorded one.
   *
   * It is NOT derived from `strategy_used`: a cached session does not
   * become "official" because a cache entry looks official.
   */
  source?: BrandProfileSource | null;
  api_endpoint: string | null;
  scraped_at: string | null;
  created_at: string | null;
}

export interface GeneratedContent {
  captions: string[];
  imagePrompts: string[];
  videoPrompts: string[];
}
