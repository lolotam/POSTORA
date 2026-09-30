import type { ReviewBlocker } from "../domain/reviewRules";
import { ReviewGatewayError } from "../application/ports";

type Translate = (key: string, defaultText: string) => string;

export function describeError(t: Translate, error: unknown): string {
  if (error instanceof ReviewGatewayError) {
    return t(`tiktokReview.error.${error.code}`, error.message);
  }
  if (error instanceof Error && error.message) return error.message;
  return t("tiktokReview.error.unknown", "Something went wrong.");
}

export function describeBlocker(t: Translate, blocker: ReviewBlocker): string {
  return t(`tiktokReview.blocker.${blocker.code}`, blocker.message);
}

export function captionTitle(caption: string, fallback: string): string {
  const line = caption.split(/\r?\n/).find((part) => part.trim().length > 0);
  return line?.trim() || fallback;
}
