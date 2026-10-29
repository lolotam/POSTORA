/**
 * The bounded Graph provider for the captured Page-token reconciliation.
 *
 * WHAT THIS MODULE OWNS
 *
 *   Three outbound calls and nothing else:
 *
 *     1. the captured User token against `/me`, to prove it still belongs to
 *        the captured Facebook User subject;
 *     2. the SAME captured User token against `/me/accounts`, to derive the
 *        operational Page token of the ONE protected Page;
 *     3. that DERIVED Page token against the exact Page, to prove the Page
 *        identity and, for Instagram, the exact linked Instagram identity.
 *
 *   It is not a User-grant renewal, not a grant-only rotation, not a
 *   Page-token `fb_exchange_token`, not a `/debug_token` probe and not a
 *   second capture. It never asks the provider for a token the captured grant
 *   does not already authorize.
 *
 * WHY THE SHAPE IS STRICT
 *
 *   The Page identity is already protected: it comes from the verified
 *   binding and from the captured canonical account identity, never from
 *   metadata, a username or "the first Instagram account that looks right".
 *   So the procedure does NOT have to prove uniqueness across the whole
 *   portfolio. It has to find the exact target and prove it. Everything else
 *   is a bounded, finite amount of work.
 *
 * CURSORS
 *
 *   A provider `next` URL is never fetched. Only the opaque
 *   `paging.cursors.after` value is used, and only to rebuild the SAME fixed
 *   endpoint. A cursor is length-, control- and repeat-checked. A `next` that
 *   points at another host, a repeated cursor, an over-long cursor and a
 *   `next` without a usable cursor all end the enumeration as an incomplete
 *   result, never as a request to an arbitrary host.
 *
 * SECRETS
 *
 *   The credential travels in the query string, so the URL is a secret.
 *   Nothing here logs a URL, a request body, a provider body or a thrown
 *   error. The provider text is discarded and only a stable category or a
 *   stable reason survives.
 */

import {
  protectedFetchJson,
  ProtectedProviderFailure,
} from "../_shared/metaOAuthProtectedBoundary.ts";
import { classifyProviderFailure } from "./metaRefreshProvider.ts";
import type { MetaRefreshErrorCategory } from "./metaRefreshStore.ts";
import { cleanPageIdentifier, cleanPageToken } from "./metaPageReconciliationStore.ts";

/** The one trusted host. There is no second host and no arbitrary host. */
export const PAGE_GRAPH_HOST = "graph.facebook.com";

/**
 * The accepted default Graph version.
 *
 * The configuration value `FACEBOOK_GRAPH_API_VERSION` wins when it is
 * valid. A malformed value REFUSES: it never silently selects another
 * version, because a wrong version is a different provider contract.
 */
export const DEFAULT_FACEBOOK_GRAPH_API_VERSION = "v22.0";

const GRAPH_VERSION_PATTERN = /^v\d{2,3}\.\d$/;

/**
 * Resolves the configured Graph version.
 *
 * `null` means "the configured value is malformed". `undefined` and an empty
 * string mean "never configured", which is the accepted default.
 */
export function resolveGraphApiVersion(configured: string | null | undefined): string | null {
  if (configured === undefined || configured === null || configured === "") {
    return DEFAULT_FACEBOOK_GRAPH_API_VERSION;
  }
  if (!GRAPH_VERSION_PATTERN.test(configured)) return null;
  return configured;
}

/** One request, headers and body together. */
export const PAGE_PROVIDER_REQUEST_TIMEOUT_MS = 4_000;

/**
 * The persistence reserve.
 *
 * The provider stops while this much of the account budget is still left, so
 * the capture can still be consumed and the outcome logged. It is NOT a
 * promise that PostgreSQL finishes inside four seconds.
 */
export const PAGE_PROVIDER_RESERVE_MS = 4_000;

/** At most two listing pages. */
export const PAGE_MAX_LISTING_PAGES = 2;

/** At most fifty candidates in total. */
export const PAGE_MAX_CANDIDATES = 50;

/** The accepted page size of one listing request. */
export const PAGE_LISTING_LIMIT = 25;

/** At most four relationship requests. */
export const PAGE_MAX_RELATIONSHIP_REQUESTS = 4;

/** At most six HTTP requests in total. */
export const PAGE_MAX_TOTAL_REQUESTS = 6;

/** The longest opaque cursor this module will rebuild a request from. */
export const PAGE_MAX_CURSOR_LENGTH = 512;

/** The budget is exhausted. No provider work may start. */
export class PageBudgetExhausted extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "PageBudgetExhausted";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

export type PageRequestKind = "identity" | "listing" | "relationship";

/**
 * One deadline for the WHOLE account operation.
 *
 * The budget starts BEFORE the capture, before the protected reads and before
 * the provider, and it counts every elapsed millisecond. It is not a fresh
 * budget per step: six independent four-second requests would consume the
 * persistence reserve that the accepted ceilings require.
 */
export interface PageReconciliationBudget {
  /** Milliseconds left for the whole operation. */
  remainingMs(): number;
  /**
   * Reserves provider time. The persistence reserve is never consumed here.
   * Throws `PageBudgetExhausted` when too little is left.
   */
  takeProviderMs(requestedMs: number): number;
  /**
   * Reserves persistence and logging time. Throws `PageBudgetExhausted` when
   * the budget is gone.
   */
  takePersistenceMs(requestedMs: number): number;
  /** Counts one HTTP request against the total and the per-kind ceilings. */
  countRequest(kind: PageRequestKind): void;
  /** Counts the candidates of one listing page. */
  addCandidates(count: number): void;
  /** How many listing pages were read. */
  listingPages(): number;
}

/**
 * Creates the one budget of one account operation.
 *
 * `totalMs` is the accepted account ceiling (24 seconds). The provider
 * reserve (4 seconds) is carved out of it, so the provider can never spend
 * the time the capture consume and the log line need.
 */
export function createPageReconciliationBudget(
  totalMs: number,
  now: () => number = Date.now,
  reserveMs: number = PAGE_PROVIDER_RESERVE_MS,
): PageReconciliationBudget {
  const startedAt = now();
  const deadline = startedAt + totalMs;
  let requests = 0;
  let listings = 0;
  let relationships = 0;
  let candidates = 0;

  const remaining = (): number => deadline - now();

  return {
    remainingMs: remaining,

    takeProviderMs(requestedMs: number): number {
      const usable = remaining() - reserveMs;
      if (!Number.isFinite(requestedMs) || requestedMs <= 0 || usable <= 0) {
        throw new PageBudgetExhausted("page_budget_exhausted");
      }
      return Math.max(1, Math.min(requestedMs, usable));
    },

    takePersistenceMs(requestedMs: number): number {
      const usable = remaining();
      if (!Number.isFinite(requestedMs) || requestedMs <= 0 || usable <= 0) {
        throw new PageBudgetExhausted("page_budget_exhausted");
      }
      return Math.max(1, Math.min(requestedMs, usable));
    },

    countRequest(kind: PageRequestKind): void {
      requests += 1;
      if (kind === "listing") listings += 1;
      if (kind === "relationship") relationships += 1;
      if (requests > PAGE_MAX_TOTAL_REQUESTS) {
        throw new PageBudgetExhausted("page_request_cap");
      }
      if (listings > PAGE_MAX_LISTING_PAGES) {
        throw new PageBudgetExhausted("page_listing_cap");
      }
      if (relationships > PAGE_MAX_RELATIONSHIP_REQUESTS) {
        throw new PageBudgetExhausted("page_relationship_cap");
      }
    },

    addCandidates(count: number): void {
      candidates += count;
      if (candidates > PAGE_MAX_CANDIDATES) {
        throw new PageBudgetExhausted("page_candidate_cap");
      }
    },

    listingPages: () => listings,
  };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * A provider problem.
 *
 * `classified_failure` is the ONLY outcome that may become a counted
 * failure. It requires a recognized structured provider error that is
 * attributable to this captured grant or to this exact selected Page.
 *
 * Everything else — an unknown body, an identity mismatch, a malformed
 * listing, a cursor problem, a transport failure, an exhausted budget — is
 * `unclassified_failure` or `incomplete`. Those never move a health counter
 * and never send an alert.
 */
export type PageProviderProblem =
  | { kind: "classified_failure"; category: MetaRefreshErrorCategory }
  | { kind: "unclassified_failure" }
  | { kind: "incomplete"; reason: string };

export type PageUserIdentityOutcome =
  | { kind: "verified"; subject: string }
  | PageProviderProblem;

export type PageDiscoveryOutcome =
  | { kind: "found"; pageToken: string }
  | PageProviderProblem;

export type PageProofOutcome =
  | { kind: "verified"; pageToken: string }
  | PageProviderProblem;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface MetaPageReconciliationProvider {
  /** Proves the captured User token still belongs to the captured subject. */
  verifyUserSubject(input: {
    capturedToken: string;
    subject: string;
    budget: PageReconciliationBudget;
  }): Promise<PageUserIdentityOutcome>;
  /** Derives the operational Page token of the ONE protected Page. */
  findProtectedPage(input: {
    capturedToken: string;
    pageId: string;
    budget: PageReconciliationBudget;
  }): Promise<PageDiscoveryOutcome>;
  /** Proves the exact Page identity and, for Instagram, the exact IG identity. */
  verifyPageIdentity(input: {
    pageToken: string;
    pageId: string;
    /** The captured Instagram identity, or null for a Facebook Page. */
    instagramUserId: string | null;
    budget: PageReconciliationBudget;
  }): Promise<PageProofOutcome>;
}

export interface MetaPageReconciliationProviderOptions {
  /** The configured Graph version, or null/undefined for the accepted default. */
  graphVersion?: string | null;
  /** Injected for tests. The production path uses the global fetch. */
  fetcher?: typeof fetch;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Builds one trusted Graph URL.
 *
 * The credential travels in the query string, so the URL is a secret. It is
 * never logged.
 */
function buildGraphUrl(
  version: string,
  path: string,
  fields: string,
  accessToken: string,
  options: { limit?: number; after?: string } = {},
): string {
  const url = new URL(`https://${PAGE_GRAPH_HOST}/${version}/${path}`);
  url.searchParams.set("fields", fields);
  if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));
  if (options.after !== undefined) url.searchParams.set("after", options.after);
  url.searchParams.set("access_token", accessToken);
  return url.toString();
}

/**
 * One bounded Graph request.
 *
 * Sequential, no retry, `redirect: 'error'`, one deadline over the headers
 * and the body. A transport failure and a timeout are NOT provider evidence:
 * they are incomplete, because nothing is proven about the grant.
 */
async function requestGraph(input: {
  url: string;
  budget: PageReconciliationBudget;
  kind: PageRequestKind;
  fetcher?: typeof fetch;
}): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; problem: PageProviderProblem }> {
  let timeoutMs: number;
  try {
    input.budget.countRequest(input.kind);
    timeoutMs = input.budget.takeProviderMs(PAGE_PROVIDER_REQUEST_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof PageBudgetExhausted) {
      return { ok: false, problem: { kind: "incomplete", reason: error.reason } };
    }
    throw error;
  }

  let response: { status: number; ok: boolean; body: unknown };
  try {
    response = await protectedFetchJson(
      input.url,
      { method: "GET", redirect: "error" },
      { timeoutMs, fetcher: input.fetcher },
    );
  } catch (error) {
    // A transport failure, a timeout and an abort are never permanent
    // evidence about the grant.
    if (error instanceof ProtectedProviderFailure) {
      return { ok: false, problem: { kind: "incomplete", reason: "provider_transport" } };
    }
    return { ok: false, problem: { kind: "incomplete", reason: "provider_transport" } };
  }

  if (!response.ok) {
    const classified = classifyProviderFailure({
      status: response.status,
      body: response.body,
    });
    if (classified.category === null) {
      return { ok: false, problem: { kind: "unclassified_failure" } };
    }
    return { ok: false, problem: { kind: "classified_failure", category: classified.category } };
  }

  if (!isPlainRecord(response.body)) {
    return { ok: false, problem: { kind: "incomplete", reason: "provider_malformed" } };
  }
  const errorDescriptor = Object.getOwnPropertyDescriptor(response.body, "error");
  if (errorDescriptor !== undefined && "value" in errorDescriptor && errorDescriptor.value) {
    // A successful HTTP status that carries a provider error is malformed.
    return { ok: false, problem: { kind: "incomplete", reason: "provider_malformed" } };
  }
  return { ok: true, body: response.body };
}

/**
 * Reads the opaque continuation cursor of one listing page.
 *
 * Only `paging.cursors.after` is read. A provider `next` URL is never
 * followed. A missing, malformed, over-long or repeated cursor ends the
 * enumeration.
 */
function readAfterCursor(paging: unknown): string | null {
  if (paging === undefined || paging === null) return null;
  if (!isPlainRecord(paging)) return null;
  const cursorsDescriptor = Object.getOwnPropertyDescriptor(paging, "cursors");
  if (cursorsDescriptor === undefined || !("value" in cursorsDescriptor)) return null;
  if (!isPlainRecord(cursorsDescriptor.value)) return null;
  const afterDescriptor = Object.getOwnPropertyDescriptor(cursorsDescriptor.value, "after");
  if (afterDescriptor === undefined || !("value" in afterDescriptor)) return null;
  const after = afterDescriptor.value;
  if (typeof after !== "string") return null;
  if (after.length === 0 || after.length > PAGE_MAX_CURSOR_LENGTH) return null;
  if (after.trim() !== after) return null;
  for (let index = 0; index < after.length; index += 1) {
    const code = after.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return null;
  }
  return after;
}

/**
 * Creates the provider.
 *
 * A malformed configured Graph version makes every operation refuse. It never
 * selects another version.
 */
export function createMetaPageReconciliationProvider(
  options: MetaPageReconciliationProviderOptions = {},
): MetaPageReconciliationProvider {
  const version = resolveGraphApiVersion(options.graphVersion);
  const fetcher = options.fetcher;

  const versionRefused: PageProviderProblem = {
    kind: "incomplete",
    reason: "graph_version_invalid",
  };

  return {
    async verifyUserSubject(input) {
      if (version === null) return versionRefused;
      const url = buildGraphUrl(version, "me", "id", input.capturedToken);
      const response = await requestGraph({
        url,
        budget: input.budget,
        kind: "identity",
        fetcher,
      });
      if (!response.ok) return response.problem;

      const id = cleanPageIdentifier(response.body.id);
      if (id === null) return { kind: "incomplete", reason: "provider_malformed" };
      if (id !== input.subject) {
        // The token belongs to somebody else. That is an identity ambiguity,
        // not proof that the grant was revoked.
        return { kind: "incomplete", reason: "user_subject_mismatch" };
      }
      return { kind: "verified", subject: id };
    },

    async findProtectedPage(input) {
      if (version === null) return versionRefused;
      const usedCursors = new Set<string>();
      let after: string | undefined;

      for (let page = 0; page < PAGE_MAX_LISTING_PAGES; page += 1) {
        const url = buildGraphUrl(
          version,
          "me/accounts",
          "id,access_token",
          input.capturedToken,
          { limit: PAGE_LISTING_LIMIT, after },
        );
        const response = await requestGraph({
          url,
          budget: input.budget,
          kind: "listing",
          fetcher,
        });
        if (!response.ok) return response.problem;

        const entries = response.body.data;
        if (!Array.isArray(entries)) {
          return { kind: "incomplete", reason: "page_listing_malformed" };
        }
        if (entries.length > PAGE_LISTING_LIMIT) {
          return { kind: "incomplete", reason: "page_listing_oversized" };
        }
        try {
          input.budget.addCandidates(entries.length);
        } catch (error) {
          if (error instanceof PageBudgetExhausted) {
            return { kind: "incomplete", reason: error.reason };
          }
          throw error;
        }

        // Validate the WHOLE page before acting on it. An unrelated malformed
        // candidate is never target permission evidence; it makes the
        // enumeration untrustworthy.
        const candidates: Array<{ id: string; token: string }> = [];
        for (const entry of entries) {
          if (!isPlainRecord(entry)) {
            return { kind: "incomplete", reason: "page_listing_malformed" };
          }
          const id = cleanPageIdentifier(entry.id);
          const token = cleanPageToken(entry.access_token);
          if (id === null || token === null) {
            return { kind: "incomplete", reason: "page_listing_malformed" };
          }
          candidates.push({ id, token });
        }

        // The target is the KNOWN protected Page, never "the first Instagram
        // account that looks right".
        const matches = candidates.filter((candidate) => candidate.id === input.pageId);
        if (matches.length > 0) {
          const first = matches[0];
          for (const match of matches) {
            if (match.token !== first.token) {
              // Two different tokens for the same Page: the enumeration
              // contradicts itself.
              return { kind: "incomplete", reason: "page_target_conflict" };
            }
          }
          return { kind: "found", pageToken: first.token };
        }

        const cursor = readAfterCursor(response.body.paging);
        if (cursor === null) {
          // No usable continuation: the enumeration is over and the target was
          // not in it.
          return { kind: "incomplete", reason: "page_target_not_found" };
        }
        if (usedCursors.has(cursor)) {
          return { kind: "incomplete", reason: "page_cursor_repeated" };
        }
        usedCursors.add(cursor);
        after = cursor;
      }

      return { kind: "incomplete", reason: "page_listing_cap" };
    },

    async verifyPageIdentity(input) {
      if (version === null) return versionRefused;
      const fields =
        input.instagramUserId === null ? "id" : "id,instagram_business_account{id}";
      const url = buildGraphUrl(
        version,
        encodeURIComponent(input.pageId),
        fields,
        input.pageToken,
      );
      const response = await requestGraph({
        url,
        budget: input.budget,
        kind: "relationship",
        fetcher,
      });
      if (!response.ok) return response.problem;

      const id = cleanPageIdentifier(response.body.id);
      if (id === null) return { kind: "incomplete", reason: "provider_malformed" };
      if (id !== input.pageId) {
        return { kind: "incomplete", reason: "page_identity_mismatch" };
      }

      if (input.instagramUserId !== null) {
        const relationship = response.body.instagram_business_account;
        if (!isPlainRecord(relationship)) {
          return { kind: "incomplete", reason: "page_instagram_missing" };
        }
        const instagramId = cleanPageIdentifier(relationship.id);
        if (instagramId === null) {
          return { kind: "incomplete", reason: "page_instagram_missing" };
        }
        if (instagramId !== input.instagramUserId) {
          return { kind: "incomplete", reason: "page_instagram_mismatch" };
        }
      }

      return { kind: "verified", pageToken: input.pageToken };
    },
  };
}
