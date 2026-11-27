/**
 * Published-video edit lifecycle.
 *
 * This is the real application logic, deliberately independent of any HTTP
 * handler or provider SDK: a fake provider can exercise the whole snapshot ->
 * plan -> conditional write -> same-ID verification sequence offline, while
 * the live adapter stays disabled until an authorized If-Match rehearsal.
 *
 * The rules come from the approved spec: Google is authoritative, nothing is
 * cached in the database, an omitted boolean is not a false declaration, and
 * every writable sibling of a touched part is carried into the write.
 */

export interface ProviderVideo {
  id: string;
  etag: string;
  snippet: {
    channelId: string;
    title: string;
    description: string;
    tags?: string[];
    categoryId?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
    localized?: Record<string, unknown>;
  };
  status: {
    privacyStatus: string;
    embeddable?: boolean;
    license?: string;
    publicStatsViewable?: boolean;
    selfDeclaredMadeForKids?: boolean;
    containsSyntheticMedia?: boolean;
    publishAt?: string;
  };
}

export interface WritableProjection {
  title: string;
  description: string;
  tags: string[];
  categoryId: string | null;
  privacyStatus: string;
  embeddable: boolean | null;
  license: string | null;
  publicStatsViewable: boolean | null;
  selfDeclaredMadeForKids: boolean | null;
  containsSyntheticMedia: boolean | null;
  defaultLanguage: string | null;
  publishAt: string | null;
}

export interface EditSnapshot {
  revision: string;
  fetchedAt: string;
  videoId: string;
  channelId: string;
  values: WritableProjection;
  restrictions: { scheduleProtected: boolean; unknownFieldsBlocked: boolean };
}

export interface EditChanges {
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  privacyStatus?: "private" | "unlisted" | "public";
}

export interface UpdatePlan {
  parts: string[];
  body: Record<string, unknown>;
  ifMatch: string;
  expectedPrivacy: string;
}

export type EditFailureCode =
  | "edit_conflict"
  | "invalid_request"
  | "provider_unsupported"
  | "reconnect_required"
  | "rate_limited"
  | "quota_exceeded"
  | "upstream_unavailable"
  | "outcome_unknown";

export class EditFailure extends Error {
  readonly retryAfterSeconds?: number;
  constructor(readonly code: EditFailureCode, message: string, options?: { retryAfterSeconds?: number }) {
    super(message);
    this.name = "EditFailure";
    if (options?.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

const KNOWN_UNKNOWN_FIELDS = ["paidProductPlacementDetails", "recordingDetails"] as const;

function projectionOf(video: ProviderVideo): WritableProjection {
  const snippet = video.snippet;
  const status = video.status;
  return {
    title: snippet.title,
    description: snippet.description,
    tags: snippet.tags ?? [],
    categoryId: snippet.categoryId ?? null,
    privacyStatus: status.privacyStatus,
    embeddable: typeof status.embeddable === "boolean" ? status.embeddable : null,
    license: status.license ?? null,
    publicStatsViewable: typeof status.publicStatsViewable === "boolean" ? status.publicStatsViewable : null,
    selfDeclaredMadeForKids: typeof status.selfDeclaredMadeForKids === "boolean"
      ? status.selfDeclaredMadeForKids
      : null,
    containsSyntheticMedia: typeof status.containsSyntheticMedia === "boolean"
      ? status.containsSyntheticMedia
      : null,
    defaultLanguage: snippet.defaultLanguage ?? null,
    publishAt: status.publishAt ?? null,
  };
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A fresh owner-bound snapshot. No value is invented for an absent field. */
export async function createEditSnapshot(args: {
  video: ProviderVideo;
  ownerId: string;
  accountId: string;
  expectedChannelId: string;
  fetchedAt: string;
}): Promise<EditSnapshot> {
  const { video, expectedChannelId } = args;
  if (video.id.length === 0 || video.snippet.channelId !== expectedChannelId) {
    throw new EditFailure("invalid_request", "The video does not belong to the selected channel.");
  }
  const values = projectionOf(video);
  const revision = await digest({
    version: 1,
    ownerId: args.ownerId,
    accountId: args.accountId,
    channelId: expectedChannelId,
    videoId: video.id,
    values,
  });
  return {
    revision,
    fetchedAt: args.fetchedAt,
    videoId: video.id,
    channelId: expectedChannelId,
    values,
    restrictions: {
      scheduleProtected: values.publishAt !== null,
      unknownFieldsBlocked: KNOWN_UNKNOWN_FIELDS.some((field) => field in (video as unknown as Record<string, unknown>)),
    },
  };
}

export function validateEditChanges(changes: EditChanges, snapshot: EditSnapshot): void {
  const keys = Object.keys(changes);
  if (keys.length === 0) throw new EditFailure("invalid_request", "No changes were supplied.");
  for (const key of keys) {
    if (!(key in snapshot.values)) throw new EditFailure("invalid_request", `Unknown field: ${key}`);
  }
  if (changes.title !== undefined && (changes.title.trim().length === 0 || changes.title.length > 100 || /[<>]/.test(changes.title))) {
    throw new EditFailure("invalid_request", "Invalid title.");
  }
  if (changes.description !== undefined && (changes.description.length > 5000 || /[<>]/.test(changes.description))) {
    throw new EditFailure("invalid_request", "Invalid description.");
  }
  if (changes.tags !== undefined) {
    if (
      !Array.isArray(changes.tags) ||
      changes.tags.some((tag) => typeof tag !== "string" || tag.trim().length === 0 || tag.trim() !== tag || /[<>]/.test(tag)) ||
      changes.tags.reduce((total, tag) => total + tag.length, 0) > 500
    ) {
      throw new EditFailure("invalid_request", "Invalid tags.");
    }
  }
  if (changes.categoryId !== undefined && !/^\d{1,4}$/.test(changes.categoryId)) {
    throw new EditFailure("invalid_request", "Invalid category.");
  }
  if (changes.privacyStatus !== undefined && snapshot.restrictions.scheduleProtected) {
    throw new EditFailure("invalid_request", "A scheduled video's privacy is protected.");
  }
}

/**
 * Builds one conditional update from a verified base snapshot.
 *
 * A title-only change never includes `status`; a status change carries every
 * writable sibling including an explicit false. The revision is recomputed
 * from the SAME fresh provider representation before the plan is returned.
 */
export async function planEditUpdate(args: {
  snapshot: EditSnapshot;
  changes: EditChanges;
  freshVideo: ProviderVideo;
  ownerId: string;
  accountId: string;
  privacyConfirmation: { to: string } | null;
  /** The provider's assignable category ids for the creator's region. */
  assignableCategoryIds?: ReadonlySet<string>;
}): Promise<UpdatePlan> {
  validateEditChanges(args.changes, args.snapshot);
  if (args.changes.categoryId !== undefined && args.assignableCategoryIds &&
      !args.assignableCategoryIds.has(args.changes.categoryId)) {
    throw new EditFailure("invalid_request", "The selected category is not assignable in this region.");
  }
  const fresh = await createEditSnapshot({
    video: args.freshVideo,
    ownerId: args.ownerId,
    accountId: args.accountId,
    expectedChannelId: args.snapshot.channelId,
    fetchedAt: args.snapshot.fetchedAt,
  });
  if (fresh.revision !== args.snapshot.revision) {
    throw new EditFailure("edit_conflict", "The video changed since it was opened.");
  }
  if (fresh.restrictions.unknownFieldsBlocked) {
    throw new EditFailure("provider_unsupported", "A writable sibling is not yet understood.");
  }

  const body: Record<string, unknown> = {};
  const parts: string[] = [];
  const usesSnippet = ["title", "description", "tags", "categoryId"].some((key) => key in args.changes);
  if (usesSnippet) {
    const snippet: Record<string, unknown> = {
      title: args.changes.title ?? fresh.values.title,
      description: args.changes.description ?? fresh.values.description,
      tags: args.changes.tags ?? fresh.values.tags,
      categoryId: args.changes.categoryId ?? fresh.values.categoryId,
    };
    if (fresh.values.defaultLanguage !== null) snippet.defaultLanguage = fresh.values.defaultLanguage;
    body.snippet = snippet;
    parts.push("snippet");
  }

  if (args.changes.privacyStatus !== undefined) {
    if (!args.privacyConfirmation || args.privacyConfirmation.to !== args.changes.privacyStatus) {
      throw new EditFailure("invalid_request", "The privacy change was not confirmed.");
    }
    const status: Record<string, unknown> = { privacyStatus: args.changes.privacyStatus };
    for (const key of ["embeddable", "license", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia"] as const) {
      if (fresh.values[key] !== null) status[key === "selfDeclaredMadeForKids" ? "selfDeclaredMadeForKids" : key] = fresh.values[key];
    }
    body.status = status;
    parts.push("status");
  }

  return { parts, body, ifMatch: args.freshVideo.etag, expectedPrivacy: args.changes.privacyStatus ?? fresh.values.privacyStatus };
}

/** Verifies the provider's answer and the same-ID reread after a write. */
export function verifyEditResult(args: {
  responseId: string;
  reread: ProviderVideo;
  expectedVideoId: string;
  plan: UpdatePlan;
}): void {
  if (args.responseId !== args.expectedVideoId || args.reread.id !== args.expectedVideoId) {
    throw new EditFailure("outcome_unknown", "The provider did not confirm the same video.");
  }
  if (args.plan.body.snippet) {
    const snippet = args.plan.body.snippet as Record<string, unknown>;
    for (const key of ["title", "description", "tags", "categoryId"] as const) {
      if (key in snippet && JSON.stringify(args.reread.snippet[key as keyof ProviderVideo["snippet"]]) !== JSON.stringify(snippet[key])) {
        throw new EditFailure("outcome_unknown", `The verified ${key} does not match the request.`);
      }
    }
  }
  if (args.plan.body.status) {
    const status = args.plan.body.status as Record<string, unknown>;
    if (args.reread.status.privacyStatus !== args.plan.expectedPrivacy) {
      throw new EditFailure("outcome_unknown", "The verified privacy does not match the request.");
    }
    for (const key of ["embeddable", "license", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia"] as const) {
      if (key in status && JSON.stringify(args.reread.status[key]) !== JSON.stringify(status[key])) {
        throw new EditFailure("outcome_unknown", `The verified ${key} does not match the request.`);
      }
    }
  }
}
