import { displayMediaName } from "./displayMediaName";
import { maskRecipient } from "./maskRecipient";
import {
  isActiveWhatsAppStatus,
  isCalendarWhatsAppStatus,
  whatsAppChipIsDraggable,
  whatsAppChipIsMuted,
  whatsAppScheduleAction,
  type WhatsAppScheduleAction,
} from "./whatsAppSchedule";

export interface ScheduledPostSource {
  id: string;
  caption: string | null;
  platforms: string[];
  status: string;
  scheduled_at: string | null;
}

export interface ScheduledWhatsAppSource {
  id: string;
  recipient_phone: string;
  recipient_name: string | null;
  message_text: string | null;
  media_url: string | null;
  media_type: string | null;
  media_filename: string | null;
  scheduled_at: string;
  status: string;
  account_name: string | null;
  avatar_url: string | null;
}

export interface WhatsAppCardModel {
  id: string;
  accountName: string;
  avatarUrl: string | null;
  recipientLabel: string;
  preview: string | null;
  mediaType: string | null;
  mediaName: string | null;
  scheduledAt: string;
  status: string;
  action: WhatsAppScheduleAction;
  draggable: boolean;
  muted: boolean;
}

export type ScheduledBoardEntry<TPost extends ScheduledPostSource> =
  | { kind: "post"; id: string; when: string; post: TPost }
  | { kind: "whatsapp"; id: string; when: string; model: WhatsAppCardModel };

export interface ScheduledBoardQuery<TPost extends ScheduledPostSource> {
  posts: TPost[];
  messages: ScheduledWhatsAppSource[];
  search: string;
  platform: string;
  profileId: string;
  status: "all" | "pending" | "overdue";
  now: Date;
  accountFallback: string;
  profileIdsForPost: (post: TPost) => string[];
}

export function isQueuedPost(post: ScheduledPostSource): boolean {
  return (post.status === "pending" || post.status === "scheduled") && Boolean(post.scheduled_at);
}

/** Same overdue cut as the scheduled page: due now or earlier. */
export function isOverdueWhen(when: string, now: Date): boolean {
  return new Date(when).getTime() <= now.getTime();
}

/** Upcoming first, then overdue, each group earliest first. */
export function compareScheduledWhen(aWhen: string, bWhen: string, now: Date): number {
  const dateA = new Date(aWhen);
  const dateB = new Date(bWhen);
  const aIsFuture = dateA > now;
  const bIsFuture = dateB > now;
  if (aIsFuture && !bIsFuture) return -1;
  if (!aIsFuture && bIsFuture) return 1;
  return dateA.getTime() - dateB.getTime();
}

export function toWhatsAppCardModel(message: ScheduledWhatsAppSource, accountFallback: string): WhatsAppCardModel {
  const accountName = message.account_name?.trim() || accountFallback;
  return {
    id: message.id,
    accountName,
    avatarUrl: message.avatar_url,
    recipientLabel: maskRecipient(message.recipient_phone, message.recipient_name),
    preview: message.message_text?.trim() || null,
    mediaType: message.media_type,
    mediaName: displayMediaName(message.media_filename, message.media_url),
    scheduledAt: message.scheduled_at,
    status: message.status,
    action: whatsAppScheduleAction(message.status),
    draggable: whatsAppChipIsDraggable(message.status),
    muted: whatsAppChipIsMuted(message.status),
  };
}

function postMatchesPlatform(platforms: string[], platform: string): boolean {
  if (platform === "all") return true;
  if (platform === "whatsapp") return false;
  return platforms.includes(platform);
}

function textIncludes(haystack: string | null | undefined, needle: string): boolean {
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

function postIsVisible<TPost extends ScheduledPostSource>(post: TPost, query: ScheduledBoardQuery<TPost>): boolean {
  if (!isQueuedPost(post) || !post.scheduled_at) return false;
  if (!postMatchesPlatform(post.platforms, query.platform)) return false;
  if (query.profileId !== "all" && !query.profileIdsForPost(post).includes(query.profileId)) return false;
  if (!textIncludes(post.caption, query.search)) return false;
  const overdue = isOverdueWhen(post.scheduled_at, query.now);
  if (query.status === "pending" && overdue) return false;
  if (query.status === "overdue" && !overdue) return false;
  return true;
}

function whatsAppIsVisible(message: ScheduledWhatsAppSource, query: Pick<ScheduledBoardQuery<ScheduledPostSource>, "search" | "platform" | "profileId" | "status" | "now">): boolean {
  if (!isActiveWhatsAppStatus(message.status)) return false;
  if (query.platform !== "all" && query.platform !== "whatsapp") return false;
  if (query.profileId !== "all") return false;
  const matchesSearch = textIncludes(message.message_text, query.search)
    || textIncludes(message.recipient_name, query.search)
    || textIncludes(message.account_name, query.search);
  if (!matchesSearch) return false;
  const overdue = isOverdueWhen(message.scheduled_at, query.now);
  if (query.status === "pending" && overdue) return false;
  if (query.status === "overdue" && !overdue) return false;
  return true;
}

export function buildScheduledBoard<TPost extends ScheduledPostSource>(
  query: ScheduledBoardQuery<TPost>,
): ScheduledBoardEntry<TPost>[] {
  const posts: ScheduledBoardEntry<TPost>[] = query.posts
    .filter((post) => postIsVisible(post, query))
    .map((post) => ({ kind: "post", id: post.id, when: post.scheduled_at as string, post }));
  const messages: ScheduledBoardEntry<TPost>[] = query.messages
    .filter((message) => whatsAppIsVisible(message, query))
    .map((message) => ({
      kind: "whatsapp",
      id: message.id,
      when: message.scheduled_at,
      model: toWhatsAppCardModel(message, query.accountFallback),
    }));
  return [...posts, ...messages].sort((a, b) => compareScheduledWhen(a.when, b.when, query.now));
}

export function selectablePostIds<TPost extends ScheduledPostSource>(
  entries: ScheduledBoardEntry<TPost>[],
): string[] {
  return entries.flatMap((entry) => (entry.kind === "post" ? [entry.post.id] : []));
}

export interface CalendarPostSource {
  id: string;
  caption: string | null;
  platforms: string[];
  scheduled_at: string | null;
  status: string | null;
  media_file_ids: string[] | null;
}

export type CalendarEntry =
  | { kind: "post"; id: string; when: string; post: CalendarPostSource }
  | { kind: "whatsapp"; id: string; when: string; model: WhatsAppCardModel };

export function buildCalendarEntries(
  posts: CalendarPostSource[],
  messages: ScheduledWhatsAppSource[],
  accountFallback: string,
): CalendarEntry[] {
  const postEntries: CalendarEntry[] = posts
    .filter((post) => Boolean(post.scheduled_at))
    .map((post) => ({ kind: "post", id: post.id, when: post.scheduled_at as string, post }));
  const messageEntries: CalendarEntry[] = messages
    .filter((message) => isCalendarWhatsAppStatus(message.status))
    .map((message) => ({
      kind: "whatsapp",
      id: message.id,
      when: message.scheduled_at,
      model: toWhatsAppCardModel(message, accountFallback),
    }));
  return [...postEntries, ...messageEntries].sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime());
}
