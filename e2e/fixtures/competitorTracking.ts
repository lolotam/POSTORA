/**
 * The mocked-browser fixture of the competitor tracking journeys.
 *
 * WHAT THIS FIXTURE IS
 *
 *   A deterministic, SYNTHETIC stand-in for the three boundaries the
 *   competitor tracking feature talks to:
 *
 *     the report boundary     POST <supabase>/functions/v1/competitor-tracking-report
 *     the owner RPCs          POST <supabase>/rest/v1/rpc/read_own_competitor_quota
 *                             POST <supabase>/rest/v1/rpc/add_competitor_watchlist
 *                             POST <supabase>/rest/v1/rpc/update_competitor_watchlist
 *     the collection boundary POST <supabase>/functions/v1/competitor-snapshot-sync
 *
 *   plus the two reads the reachable page needs before the feature can
 *   render at all: the signed-in owner's profile and the Instagram brand
 *   search that produces the card the Track control lives on.
 *
 * WHAT IT IS NOT
 *
 *   It is NOT live backend validation. Nothing here talks to Postgres, to
 *   Supabase Auth, to Meta or to Apify: every answer is a fixture this
 *   file states in full. The journeys it drives prove the BROWSER
 *   behaviour - the wiring, the states, the copy, the keyboard path - and
 *   they prove NOTHING about the server. The assembled gate (T8-12) still
 *   needs a real local Auth/PostgREST/SQL run, and parent Task 11 still
 *   owns the live Meta probes and the hosted CI.
 *
 * WHY EVERY VALUE IS WRITTEN OUT
 *
 *   Every seeded number is a literal, so an assertion can be an exact
 *   string instead of a comparison that is always true. "count >= 0" is
 *   not an acceptance: it passes on an empty list and on a broken one.
 *
 * WHY THE SESSION IS SEEDED INSTEAD OF LOGGED IN
 *
 *   The repository's own e2e fixture logs in with a real account against
 *   a real backend. This fixture must not need credentials and must not
 *   need a backend, so it writes a SYNTHETIC session into the browser's
 *   storage under the same key the app derives, and every request the
 *   session would have authorised is answered here instead. The app runs
 *   its own real code: its real Supabase client, its real feature hooks,
 *   its real components.
 *
 * THE LOCAL-ONLY GUARD
 *
 *   The app refuses to boot without a Supabase URL, so the dev server
 *   needs one. This fixture insists that the URL is a LOCAL one and
 *   refuses to run against anything else: a mocked journey must never be
 *   pointed at a shared stack and mistaken for a real one.
 */

import type { Page, Route } from "@playwright/test";

/* -------------------------------------------------------------------------- */
/* The synthetic owner                                                         */
/* -------------------------------------------------------------------------- */

/** The synthetic owner every mocked journey runs as. */
export const SYNTHETIC_OWNER = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "competitor-owner@example.test",
  password: "synthetic-owner-password",
} as const;

/** The signed-out owner is a different identity, never this one. */
export const OTHER_OWNER_ID = "99999999-9999-4999-8999-999999999999";

/* -------------------------------------------------------------------------- */
/* The seeded competitor                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The one competitor every list journey starts from.
 *
 * The numbers are chosen so the rendered copy is exact:
 *
 *   followers      12,480   -> "12,480"
 *   7 day growth   +480     -> "+480 (4.0%)"      (12,480 - 12,000 = 480)
 *   30 day growth  +1,280   -> "+1,280 (11.4%)"   (12,480 - 11,200 = 1,280)
 *   weekly rate    3/week   -> "3.0/week"
 */
export const SEEDED = {
  watchlistId: "22222222-2222-4222-8222-222222222222",
  username: "northwind_coffee",
  label: "Northwind Coffee",
  followers: 12480,
  mediaCount: 214,
  capturedAt: "2026-10-28T09:00:00.000Z",
  capturedOn: "2026-10-28",
  baseline7At: "2026-10-21T09:00:00.000Z",
  baseline30At: "2026-09-28T09:00:00.000Z",
  growth7Absolute: 480,
  growth7Percent: 4.0,
  growth30Absolute: 1280,
  growth30Percent: 11.4,
  interval7Days: 7,
  interval30Days: 30,
  weeklyObserved: 3,
  weeklyRate: 3,
  weeklyIntervalStart: "2026-10-21T09:00:00.000Z",
  weeklyIntervalEnd: "2026-10-28T09:00:00.000Z",
  source: "official" as const,
} as const;

/** The exact strings the list renders for the seeded competitor. */
export const SEEDED_RENDERED = {
  handle: "@northwind_coffee",
  followers: "12,480",
  growth7: "+480 (4.0%)",
  growth30: "+1,280 (11.4%)",
  weeklyRate: "3.0/week",
  weeklyCount: "3 observed posts / 7 days",
  source: "Official",
  status: "Up to date",
} as const;

/** The media the seeded competitor's detail shows. */
export const SEEDED_MEDIA = {
  igMediaId: "3311223344556677",
  caption: "Cold brew season",
  likes: 412,
  comments: 18,
  views: null,
  publishedAt: "2026-10-27T14:00:00.000Z",
  permalink: "https://www.instagram.com/p/3311223344556677/",
} as const;

/** The competitor the Track control adds in the "add once" journey. */
export const ADDED = {
  watchlistId: "33333333-3333-4333-8333-333333333333",
  username: "sunrise_bakery",
  fullName: "Sunrise Bakery",
  followers: 8420,
} as const;

/** The competitor the quota refusal journey tries to add and cannot. */
export const REFUSED = {
  username: "harbour_coffee",
  fullName: "Harbour Coffee",
} as const;

/* -------------------------------------------------------------------------- */
/* The fixed instants                                                          */
/* -------------------------------------------------------------------------- */

/** The instant the mocked report is "as of". Fixed, so nothing drifts. */
export const REPORT_AS_OF = "2026-10-30T08:00:00.000Z";

/** The instant a removal is stamped with. Fixed, so nothing drifts. */
export const REMOVED_AT = "2026-10-30T08:00:00.000Z";

/** Ninety elapsed days after the removal marker. */
export const CLEANUP_ELIGIBLE_AT = "2027-01-28T08:00:00.000Z";

/* -------------------------------------------------------------------------- */
/* The payloads                                                                */
/* -------------------------------------------------------------------------- */

export type MockQuota = {
  max_tracked_competitors: number | null;
  unlimited: boolean;
  tracked_active: number;
  remaining: number | null;
};

export type MockEntry = {
  watchlist_id: string;
  username: string;
  label: string | null;
  is_active: boolean;
  removed_at: string | null;
  status: string;
  last_error_code: string | null;
  next_retry_at: string | null;
  cleanup_eligible_at: string | null;
  profile: {
    followers_count: number | null;
    media_count: number | null;
    captured_at: string;
    captured_on: string;
    source: "official" | "apify" | "unknown";
  } | null;
  freshness: {
    last_capture_at: string | null;
    last_full_success_at: string | null;
    last_partial_at: string | null;
    job_status: string | null;
    reason_code: string | null;
  };
  growth_7d: {
    absolute: number | null;
    percent: number | null;
    baseline_at: string | null;
    observed_at: string | null;
    interval_days: number | null;
    reason: string | null;
  };
  growth_30d: {
    absolute: number | null;
    percent: number | null;
    baseline_at: string | null;
    observed_at: string | null;
    interval_days: number | null;
    reason: string | null;
  };
  weekly: {
    observed_count: number;
    posts_per_week: number | null;
    interval_start: string | null;
    interval_end: string | null;
    coverage: "complete" | "partial" | "unknown";
    reason: string | null;
  };
};

/** The one media item of the seeded competitor. */
export const SEEDED_MEDIA_ITEM = {
  ig_media_id: SEEDED_MEDIA.igMediaId,
  published_at: SEEDED_MEDIA.publishedAt,
  captured_at: SEEDED.capturedAt,
  media_product_type: "FEED",
  media_type: "IMAGE",
  thumbnail_url: null,
  permalink: SEEDED_MEDIA.permalink,
  caption: SEEDED_MEDIA.caption,
  like_count: SEEDED_MEDIA.likes,
  comments_count: SEEDED_MEDIA.comments,
  view_count: SEEDED_MEDIA.views,
  source: SEEDED.source,
  outlier: {
    id: SEEDED_MEDIA.igMediaId,
    score: null,
    label: "no_data",
    baselineMedian: null,
    baselineSize: 0,
    metric_basis: null,
    source: SEEDED.source,
    reason: null,
  },
} as const;

/** The seeded competitor, as the report publishes it. */
export function buildSeededEntry(): MockEntry {
  return {
    watchlist_id: SEEDED.watchlistId,
    username: SEEDED.username,
    label: SEEDED.label,
    is_active: true,
    removed_at: null,
    status: "ok",
    last_error_code: null,
    next_retry_at: null,
    cleanup_eligible_at: null,
    profile: {
      followers_count: SEEDED.followers,
      media_count: SEEDED.mediaCount,
      captured_at: SEEDED.capturedAt,
      captured_on: SEEDED.capturedOn,
      source: SEEDED.source,
    },
    freshness: {
      last_capture_at: SEEDED.capturedAt,
      last_full_success_at: SEEDED.capturedAt,
      last_partial_at: null,
      job_status: "completed",
      reason_code: null,
    },
    growth_7d: {
      absolute: SEEDED.growth7Absolute,
      percent: SEEDED.growth7Percent,
      baseline_at: SEEDED.baseline7At,
      observed_at: SEEDED.capturedAt,
      interval_days: SEEDED.interval7Days,
      reason: null,
    },
    growth_30d: {
      absolute: SEEDED.growth30Absolute,
      percent: SEEDED.growth30Percent,
      baseline_at: SEEDED.baseline30At,
      observed_at: SEEDED.capturedAt,
      interval_days: SEEDED.interval30Days,
      reason: null,
    },
    weekly: {
      observed_count: SEEDED.weeklyObserved,
      posts_per_week: SEEDED.weeklyRate,
      interval_start: SEEDED.weeklyIntervalStart,
      interval_end: SEEDED.weeklyIntervalEnd,
      coverage: "complete",
      reason: null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The store                                                                   */
/* -------------------------------------------------------------------------- */

/** Every call the mocked boundaries received. */
export type MockCalls = {
  readonly quota: number;
  readonly add: number;
  readonly update: number;
  readonly report: number;
  readonly sync: number;
  readonly brandScrape: number;
  readonly addArgs: { p_username: string; p_label: string | null }[];
  readonly updateArgs: {
    p_watchlist_id: string;
    p_label: string | null;
    p_is_active: boolean;
  }[];
  readonly syncArgs: { mode: string; watchlist_id: string }[];
};

export type CompetitorMockStore = {
  readonly ownerId: string;
  /** The entries the mocked report publishes. */
  readonly entries: MockEntry[];
  /** The quota the mocked server resolves. */
  maxTracked: number;
  /** Whether the mocked server refuses a new entry. */
  refuseNewEntries: boolean;
  /** The calls the mocked boundaries received. */
  readonly calls: MockCalls;
  /** The entries of one state. */
  list(state: "active" | "removed"): MockEntry[];
  /** The quota of the owner. */
  quota(): MockQuota;
  /** The entry of one watchlist id. */
  find(watchlistId: string): MockEntry | undefined;
};

export type CompetitorMockStoreOptions = {
  readonly ownerId?: string;
  readonly entries?: MockEntry[];
  readonly maxTracked?: number;
  readonly refuseNewEntries?: boolean;
};

/**
 * The in-memory stand-in for the owner's tracked competitors.
 *
 * It behaves like the server on the points the journeys depend on: the
 * handle is normalised the way the database normalises it, a duplicate
 * active handle is NOT a new entry, the quota is a cap on the ACTIVE
 * entries, and a removal is a soft removal that keeps the history.
 */
export function createCompetitorMockStore(
  options: CompetitorMockStoreOptions = {},
): CompetitorMockStore {
  const entries = options.entries ?? [buildSeededEntry()];
  const calls: MockCalls = {
    quota: 0,
    add: 0,
    update: 0,
    report: 0,
    sync: 0,
    brandScrape: 0,
    addArgs: [],
    updateArgs: [],
    syncArgs: [],
  };

  const activeCount = (): number =>
    entries.filter((entry) => entry.is_active).length;

  return {
    ownerId: options.ownerId ?? SYNTHETIC_OWNER.id,
    entries,
    maxTracked: options.maxTracked ?? 5,
    refuseNewEntries: options.refuseNewEntries ?? false,
    calls,

    list(state: "active" | "removed"): MockEntry[] {
      const wanted = state === "active";
      return entries.filter((entry) => entry.is_active === wanted);
    },

    quota(): MockQuota {
      const trackedActive = activeCount();
      return {
        max_tracked_competitors: this.maxTracked,
        unlimited: false,
        tracked_active: trackedActive,
        remaining: Math.max(0, this.maxTracked - trackedActive),
      };
    },

    find(watchlistId: string): MockEntry | undefined {
      return entries.find((entry) => entry.watchlist_id === watchlistId);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The URL patterns                                                            */
/* -------------------------------------------------------------------------- */

/** A PostgREST RPC of the owner. */
const rpc = (name: string): RegExp => new RegExp(`/rest/v1/rpc/${name}(?:\\?|$)`);

/** A PostgREST table. */
const table = (name: string): RegExp => new RegExp(`/rest/v1/${name}(?:\\?|$)`);

/** An Edge Function of this stack. */
const fn = (name: string): RegExp => new RegExp(`/functions/v1/${name}(?:\\?|$)`);

/* -------------------------------------------------------------------------- */
/* The synthetic session                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The Supabase URL the dev server was started with.
 *
 * It has to be a LOCAL one. A shared URL would turn a mocked journey
 * into an accidental request against a real stack.
 */
export function requireLocalSupabaseUrl(): string {
  const url = process.env.VITE_SUPABASE_URL;
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error(
      "VITE_SUPABASE_URL is not set. The competitor tracking e2e journeys run against a " +
        "synthetic LOCAL Supabase URL, for example " +
        "VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_PUBLISHABLE_KEY=synthetic-key",
    );
  }
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) {
    throw new Error(
      `VITE_SUPABASE_URL must be a local URL for the mocked competitor tracking journeys. ` +
        `It is "${url}".`,
    );
  }
  return url;
}

/**
 * The storage key the app derives for its session.
 *
 * This mirrors `deriveAuthStorageKey` in
 * `src/integrations/supabase/client.ts`: the first label of the host,
 * prefixed with `sb-` and suffixed with `-auth-token`.
 */
export function syntheticAuthStorageKey(url = requireLocalSupabaseUrl()): string {
  const host = new URL(url).hostname;
  const ref = host.split(".")[0] || "postora";
  return `sb-${ref}-auth-token`;
}

/**
 * Writes a synthetic session into the browser storage.
 *
 * The shape is the one the GoTrue client reads: an access token, a
 * refresh token and an expiry, plus the user. The refresh token is long
 * enough that the app's own stale-session purge keeps it, and the expiry
 * is in the future, so the client never reaches for the network.
 */
export async function seedSyntheticSession(
  page: Page,
  options: { ownerId?: string; email?: string } = {},
): Promise<void> {
  const ownerId = options.ownerId ?? SYNTHETIC_OWNER.id;
  const email = options.email ?? SYNTHETIC_OWNER.email;
  const storageKey = syntheticAuthStorageKey();

  await page.addInitScript(
    ({ key, session }: { key: string; session: unknown }) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(session));
      } catch {
        /* a browser that refuses storage cannot be signed in */
      }
    },
    {
      key: storageKey,
      session: {
        access_token: `synthetic-access-token.${ownerId}`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: `synthetic-refresh-token.${ownerId}`,
        user: {
          id: ownerId,
          aud: "authenticated",
          role: "authenticated",
          email,
          email_confirmed_at: "2026-01-01T00:00:00.000Z",
          phone: "",
          confirmed_at: "2026-01-01T00:00:00.000Z",
          last_sign_in_at: "2026-10-30T00:00:00.000Z",
          app_metadata: { provider: "email", providers: ["email"] },
          user_metadata: {},
          identities: [],
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      },
    },
  );
}

/* -------------------------------------------------------------------------- */
/* The mocked boundaries                                                       */
/* -------------------------------------------------------------------------- */

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });
}

function readBody(route: Route): Record<string, unknown> {
  try {
    const parsed = route.request().postDataJSON() as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* a body that is not JSON carries nothing */
  }
  return {};
}

/** The PostgREST error envelope of a refused statement. */
function rpcError(route: Route, code: string, message: string): Promise<void> {
  return json(route, 400, { code, details: null, hint: null, message });
}

/**
 * The handle normalisation the database applies.
 */
function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}

/**
 * Installs every mocked boundary on the page.
 *
 * The catch-alls are registered FIRST: Playwright matches the most
 * recently registered route first, so the specific handlers below win
 * over them.
 */
export async function installCompetitorTrackingMocks(
  page: Page,
  store: CompetitorMockStore,
): Promise<void> {
  /* --- the catch-alls ---------------------------------------------- */

  await page.route(/\/rest\/v1\//, (route) => json(route, 200, []));
  await page.route(/\/functions\/v1\//, (route) =>
    json(route, 404, { error: "not_found" }),
  );

  /* --- the reads the page needs before the feature renders --------- */

  await page.route(table("profiles"), (route) =>
    json(route, 200, {
      id: store.ownerId,
      email: SYNTHETIC_OWNER.email,
      full_name: "Synthetic Owner",
      avatar_url: null,
      api_key: null,
      ai_model: null,
      preferred_timezone: "Asia/Kuwait",
      email_notifications_enabled: false,
      notification_sound_enabled: false,
      post_success_notifications_enabled: false,
      post_failure_notifications_enabled: false,
      media_retention_days: null,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }),
  );

  await page.route(table("social_accounts"), (route) => json(route, 200, []));
  await page.route(table("bi_post_content"), (route) => json(route, 200, []));
  await page.route(table("brand_search_history"), (route) => json(route, 200, []));

  /* --- the Instagram brand search ----------------------------------- */

  await page.route(fn("brand-scrape"), async (route) => {
    store.calls.brandScrape += 1;
    const body = readBody(route);
    const username = normalizeHandle(
      typeof body.username === "string" ? body.username : "",
    );
    const isRefused = username === REFUSED.username;

    return json(route, 200, {
      profile: {
        id: `brand-${username}`,
        username,
        fullName: isRefused ? REFUSED.fullName : ADDED.fullName,
        bio: "Synthetic brand profile",
        avatarUrl: "",
        followersCount: isRefused ? 3100 : ADDED.followers,
        followingCount: 210,
        postsCount: 96,
        isVerified: false,
        platform: "instagram",
      },
      posts: [],
      totalPosts: 0,
      hasMore: false,
    });
  });

  /* --- the owner RPCs ----------------------------------------------- */

  await page.route(rpc("read_own_competitor_quota"), (route) => {
    store.calls.quota += 1;
    return json(route, 200, store.quota());
  });

  await page.route(rpc("add_competitor_watchlist"), (route) => {
    store.calls.add += 1;
    const body = readBody(route);
    const username = normalizeHandle(
      typeof body.p_username === "string" ? body.p_username : "",
    );
    const label = typeof body.p_label === "string" ? body.p_label : null;
    store.calls.addArgs.push({ p_username: username, p_label: label });

    const existing = store.entries.find((entry) => entry.username === username);

    if (existing && existing.is_active) {
      // The already-tracked reply legitimately carries NO quota.
      return json(route, 200, {
        watchlist_id: existing.watchlist_id,
        username: existing.username,
        is_active: true,
        status: existing.status,
        reactivated: false,
        already_tracked: true,
      });
    }

    const activeCount = store.entries.filter((entry) => entry.is_active).length;
    if (store.refuseNewEntries || activeCount >= store.maxTracked) {
      return rpcError(
        route,
        "P0001",
        "COMPETITOR_QUOTA_EXCEEDED: the tracked competitor limit is reached",
      );
    }

    if (existing) {
      // A removed handle is reactivated: the SAME row and the SAME id.
      existing.is_active = true;
      existing.removed_at = null;
      existing.cleanup_eligible_at = null;
      existing.status = "pending";
      return json(route, 200, {
        watchlist_id: existing.watchlist_id,
        username: existing.username,
        is_active: true,
        status: existing.status,
        reactivated: true,
        already_tracked: false,
        quota: store.quota(),
      });
    }

    const created: MockEntry = {
      watchlist_id: ADDED.watchlistId,
      username,
      label,
      is_active: true,
      removed_at: null,
      status: "pending",
      last_error_code: null,
      next_retry_at: null,
      cleanup_eligible_at: null,
      profile: null,
      freshness: {
        last_capture_at: null,
        last_full_success_at: null,
        last_partial_at: null,
        job_status: null,
        reason_code: null,
      },
      growth_7d: {
        absolute: null,
        percent: null,
        baseline_at: null,
        observed_at: null,
        interval_days: null,
        reason: "first_observation",
      },
      growth_30d: {
        absolute: null,
        percent: null,
        baseline_at: null,
        observed_at: null,
        interval_days: null,
        reason: "first_observation",
      },
      weekly: {
        observed_count: 0,
        posts_per_week: null,
        interval_start: null,
        interval_end: null,
        coverage: "unknown",
        reason: "coverage_unknown",
      },
    };
    store.entries.push(created);

    return json(route, 200, {
      watchlist_id: created.watchlist_id,
      username: created.username,
      is_active: true,
      status: created.status,
      reactivated: false,
      already_tracked: false,
      quota: store.quota(),
    });
  });

  await page.route(rpc("update_competitor_watchlist"), (route) => {
    store.calls.update += 1;
    const body = readBody(route);
    const watchlistId =
      typeof body.p_watchlist_id === "string" ? body.p_watchlist_id : "";
    const isActive = body.p_is_active === true;
    store.calls.updateArgs.push({
      p_watchlist_id: watchlistId,
      p_label: typeof body.p_label === "string" ? body.p_label : null,
      p_is_active: isActive,
    });

    const entry = store.find(watchlistId);
    if (entry === undefined) {
      return rpcError(
        route,
        "P0002",
        "COMPETITOR_NOT_FOUND: the tracked competitor does not exist",
      );
    }

    if (isActive) {
      // The reactivation clears the removal marker and the cleanup date.
      entry.is_active = true;
      entry.removed_at = null;
      entry.cleanup_eligible_at = null;
      entry.status = "pending";
    } else {
      // The removal is soft: the history stays, the clock starts.
      entry.is_active = false;
      entry.removed_at = REMOVED_AT;
      entry.cleanup_eligible_at = CLEANUP_ELIGIBLE_AT;
    }

    return json(route, 200, {
      watchlist_id: entry.watchlist_id,
      username: entry.username,
      label: entry.label,
      is_active: entry.is_active,
      removed_at: entry.removed_at,
      status: entry.status,
      quota: store.quota(),
    });
  });

  /* --- the report boundary ------------------------------------------ */

  await page.route(fn("competitor-tracking-report"), (route) => {
    store.calls.report += 1;
    const body = readBody(route);
    const quota = store.quota();

    if (body.action === "detail") {
      const watchlistId =
        typeof body.watchlist_id === "string" ? body.watchlist_id : "";
      const entry = store.find(watchlistId) ?? null;
      return json(route, 200, {
        version: 1,
        as_of: REPORT_AS_OF,
        capture_timezone: "Asia/Kuwait",
        quota,
        next_cursor: null,
        entry,
        media: entry === null ? [] : [SEEDED_MEDIA_ITEM],
      });
    }

    const state = body.state === "removed" ? "removed" : "active";
    return json(route, 200, {
      version: 1,
      as_of: REPORT_AS_OF,
      capture_timezone: "Asia/Kuwait",
      quota,
      next_cursor: null,
      entries: store.list(state),
    });
  });

  /* --- the collection boundary --------------------------------------- */

  const statusReads = new Map<string, number>();

  await page.route(fn("competitor-snapshot-sync"), (route) => {
    store.calls.sync += 1;
    const body = readBody(route);
    const mode = typeof body.mode === "string" ? body.mode : "";
    const watchlistId =
      typeof body.watchlist_id === "string" ? body.watchlist_id : "";
    store.calls.syncArgs.push({ mode, watchlist_id: watchlistId });

    if (mode === "status") {
      const reads = (statusReads.get(watchlistId) ?? 0) + 1;
      statusReads.set(watchlistId, reads);
      // The first read is QUEUED. The next one is the finished job.
      const status = reads === 1 ? "queued" : "completed";
      return json(route, 200, {
        target_kind: "competitor",
        target_id: watchlistId,
        captured_on: SEEDED.capturedOn,
        status,
        job_generation: 1,
        attempts: 1,
        due_at: null,
        next_retry_at: null,
        last_attempt_at: SEEDED.capturedAt,
        last_success_at: status === "completed" ? SEEDED.capturedAt : null,
        reason_code: null,
        pending_operations: status === "completed" ? 0 : 1,
      });
    }

    return json(route, 202, {
      accepted: true,
      reason: "queued",
      job_id: `job-${watchlistId}`,
      job_generation: 1,
      status: "queued",
      captured_on: SEEDED.capturedOn,
    });
  });
}

/* -------------------------------------------------------------------------- */
/* The journey helpers                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The instant as the app displays it.
 *
 * It mirrors `formatObservedAt` in
 * `src/features/competitor-tracking/domain/formatters.ts`: the capture
 * timezone, a medium date and a short time. The expectation is computed
 * with the same contract as the rendering, so the assertion is an exact
 * string and not a shape.
 */
export function formatKuwaitInstant(instant: string, locale = "en"): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kuwait",
  }).format(new Date(instant));
}

/**
 * Starts a mocked journey: a synthetic session and the mocked boundaries.
 *
 * It has to run BEFORE the first navigation, because the session is
 * written into the storage the page reads on load.
 */
export async function startCompetitorJourney(
  page: Page,
  options: CompetitorMockStoreOptions = {},
): Promise<CompetitorMockStore> {
  const store = createCompetitorMockStore(options);
  await seedSyntheticSession(page);
  await installCompetitorTrackingMocks(page, store);
  return store;
}

/**
 * Opens the tracked competitors list.
 *
 * The tab is part of the URL, because the URL is the state of that page
 * (spec §2).
 */
export async function openCompetitorsTab(
  page: Page,
  options: { lang?: string } = {},
): Promise<void> {
  const suffix = options.lang === undefined ? "" : `&lang=${options.lang}`;
  await page.goto(`/analytics/instagram?tab=competitors${suffix}`);
  await page.waitForLoadState("domcontentloaded");
}

/**
 * Waits for the tracked list to leave its loading state.
 *
 * The list is never "empty" while it is loading, so the wait is for the
 * row that the fixture seeded.
 */
export async function waitForTrackedList(page: Page, handle: string): Promise<void> {
  await page.getByText(handle, { exact: true }).first().waitFor({ state: "visible" });
}

/** The row of one handle. */
export function trackedRow(page: Page, handle: string) {
  return page.getByRole("row").filter({ hasText: handle }).first();
}

/**
 * The cell of one column of the row of one handle.
 *
 * The column is addressed by its HEADING, not by its position, so a
 * column that moves does not silently turn the assertion into a
 * different one.
 */
export async function trackedCell(
  page: Page,
  handle: string,
  columnHeading: string,
) {
  const table = page.getByRole("table").first();
  const heading = table.getByRole("columnheader", { name: columnHeading }).first();
  const index = await heading.evaluate((element) => {
    const row = element.closest("tr");
    if (row === null) return -1;
    return Array.prototype.indexOf.call(row.children, element);
  });
  return trackedRow(page, handle).locator("td").nth(index);
}
