import { supabase } from "@/integrations/supabase/client";
import { getErrorStatus, handleAIError } from "@/lib/aiErrorHandler";
import type { PackagingScore } from "../../supabase/functions/_shared/youtubePackagingScore";

export type { PackagingScore };

export interface RequestYouTubePackagingScoreInput {
  title: string;
  thumbnailText?: string;
  description?: string;
  language?: "english" | "arabic";
  notifyOnError?: boolean;
}

function isScoreNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBetterTitlesTuple(value: unknown): value is [string, string, string] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 100)
  );
}

export function isValidPackagingScore(raw: unknown): raw is PackagingScore {
  if (!raw || typeof raw !== "object") return false;
  const candidate = raw as Record<string, unknown>;
  if (!isScoreNumber(candidate.overall_score)) return false;

  const breakdown = candidate.breakdown;
  if (!breakdown || typeof breakdown !== "object") return false;
  const parts = breakdown as Record<string, unknown>;
  if (
    !isScoreNumber(parts.hook) ||
    !isScoreNumber(parts.clarity) ||
    !isScoreNumber(parts.mobile_length)
  ) {
    return false;
  }
  if (parts.thumbnail_synergy !== null && !isScoreNumber(parts.thumbnail_synergy)) {
    return false;
  }

  if (!isStringArray(candidate.strengths) || !isStringArray(candidate.fixes)) {
    return false;
  }
  if (!isBetterTitlesTuple(candidate.better_titles)) {
    return false;
  }

  return true;
}

export async function requestYouTubePackagingScore(
  input: RequestYouTubePackagingScoreInput,
): Promise<PackagingScore> {
  const title = input.title.trim();
  const thumbnailText = input.thumbnailText?.trim() ?? "";
  const description = input.description?.trim() ?? "";

  if (!title || title.length > 100) {
    throw new Error("Enter a video title (1–100 characters) to score packaging.");
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.user) {
    throw new Error("Please sign in to use AI features.");
  }

  const contextPayload: {
    title: string;
    thumbnail_text?: string;
    description?: string;
  } = {
    title: title.slice(0, 100),
    ...(thumbnailText ? { thumbnail_text: thumbnailText.slice(0, 300) } : {}),
    ...(description ? { description: description.slice(0, 1000) } : {}),
  };

  const { data, error } = await supabase.functions.invoke("generate-caption", {
    body: {
      requestType: "youtube_title_thumbnail_score",
      platform: "youtube",
      language: input.language ?? "english",
      context: JSON.stringify(contextPayload),
    },
  });

  const notifyOnError = input.notifyOnError ?? true;

  if (error) {
    const status = getErrorStatus(error);
    const message =
      error &&
      typeof error === "object" &&
      typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "Failed to score packaging";
    const normalizedError = Object.assign(new Error(message), status !== undefined ? { status } : {});
    if (notifyOnError) {
      handleAIError({ ...(status !== undefined ? { status } : {}), message }, "YouTube Packaging Score");
    }
    throw normalizedError;
  }

  const record = (data && typeof data === "object" ? data : null) as Record<string, unknown> | null;
  if (record?.error || record?.success === false) {
    const message =
      (typeof record.message === "string" && record.message) ||
      (typeof record.error === "string" && record.error) ||
      "Failed to score packaging";
    const err = new Error(message);
    if (notifyOnError) {
      handleAIError({ message }, "YouTube Packaging Score");
    }
    throw err;
  }

  const score = record?.score;
  if (!isValidPackagingScore(score)) {
    const err = new Error("Invalid packaging score response");
    if (notifyOnError) {
      handleAIError({ message: err.message }, "YouTube Packaging Score");
    }
    throw err;
  }

  return score;
}
