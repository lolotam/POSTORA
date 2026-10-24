import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { corsHeaders, handleCorsOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { callAiWithFallback, fetchAiSettings, logAiCall } from "../_shared/ai-fallback.ts";
import { timingSafeTokenEqual } from "../_shared/auth-helper.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import { checkUserRateLimit, rateLimitExceededResponse } from "../_shared/rate-limiter.ts";
import { createLogger } from "../_shared/logging.ts";

// A user id that reaches the database has to be a uuid: an id that is not one
// makes the write of the log row fail with 22P02, and the AI call is then
// logged against nobody.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The platforms one request may name. The request makes one AI call whatever
// the count, so the cap bounds the prompt, not the number of calls. It sits
// above anything the dashboard can select: the web app sends its whole
// selection in one call and has no fallback when it is refused. n8n-api keeps
// its own, tighter cap of 6.
const MAX_PLATFORMS = 20;

// The length of one platform name. A platform name is a short word, so a
// longer one is not a platform. It matches the cap n8n-api's BestTimesSchema
// puts on the same field, so a name the API accepts is never refused here.
const MAX_PLATFORM_NAME_LENGTH = 50;

// The serialized size of historicalData, which goes into the prompt verbatim.
const MAX_HISTORY_CHARS = 2_000;

// The whole body: 20 platforms of 50 characters plus the history fit well
// inside it.
const MAX_BODY_CHARS = 16_000;

// The budget of one signed-in user, per hour, for calls made with the user's
// own token. Service-role calls from n8n-api are not counted here: that route
// calls this function once per platform and keeps its own 5/hour limit, so
// counting them twice would refuse a caller the API had already admitted.
const USER_RATE_LIMIT_REQUESTS = 20;
const USER_RATE_LIMIT_WINDOW_SECONDS = 3600;

// Every refusal writes a warn row (AGENTS.md: an early return that refuses
// work must leave a log row), but some refusals come before the caller is
// known, so a loop of bad requests must not become a row per request. At most
// one row per (reason, owner) per window is written; all anonymous callers
// share one owner key. The map is per worker and is cleared when it grows past
// its cap, the same bound the MCP refusal throttle uses.
const REFUSAL_LOG_WINDOW_MS = 60_000;
const REFUSAL_LOG_MAX_KEYS = 10_000;
const lastRefusalLogAt = new Map<string, number>();

function shouldLogRefusal(reason: string, userId: string | null, now: number): boolean {
  const key = `${reason}:${userId ?? 'anonymous'}`;
  const last = lastRefusalLogAt.get(key);
  if (last !== undefined && now - last < REFUSAL_LOG_WINDOW_MS) return false;
  if (lastRefusalLogAt.size >= REFUSAL_LOG_MAX_KEYS) lastRefusalLogAt.clear();
  lastRefusalLogAt.set(key, now);
  return true;
}

// Writes the (throttled) refusal row. The writer never throws, so a failed log
// write never changes the answer.
function refusalLogger(log: ReturnType<typeof createLogger>) {
  return async (
    reason: string,
    userId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<void> => {
    if (shouldLogRefusal(reason, userId, Date.now())) {
      await log.warn(`refused: ${reason}`, metadata, userId ?? undefined);
    }
  };
}

// Who is calling. A service-role call carries no user JWT, so the owner of the
// API key is named in the body instead: the bearer token is the service-role
// key, so the caller is authenticated as the service role and the id may be
// used. A user_id from any other caller is ignored.
async function resolveCaller(
  req: Request,
  body: { user_id?: unknown },
): Promise<{ userId: string | null; isServiceRoleCall: boolean; hadAuthHeader: boolean }> {
  const authHeader = req.headers.get('Authorization');
  const bearerToken = authHeader ? authHeader.replace('Bearer ', '').trim() : '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const bodyUserId = typeof body.user_id === 'string' ? body.user_id.trim() : '';

  if (
    serviceRoleKey.length > 0 &&
    timingSafeTokenEqual(bearerToken, serviceRoleKey) &&
    UUID_RE.test(bodyUserId)
  ) {
    return { userId: bodyUserId, isServiceRoleCall: true, hadAuthHeader: true };
  }
  if (!authHeader) {
    return { userId: null, isServiceRoleCall: false, hadAuthHeader: false };
  }
  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user } } = await supabaseClient.auth.getUser(authHeader.replace('Bearer ', ''));
  return { userId: user?.id || null, isServiceRoleCall: false, hadAuthHeader: true };
}

// The day a suggestion names is a weekday: "Funday" is not a day the caller
// can schedule on, and an empty one is not a day either. The model's spelling
// is not trusted, so the day is checked against the seven real ones instead of
// against a pattern that would accept any word.
const BEST_TIME_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

// The time is a wall-clock time in one of the two formats a caller writes: the
// 12-hour format the model is asked for ("11:00 AM") and the 24-hour format
// ("18:30"). "25:90" is not a time, and neither is "13:00 PM": the hour of a
// 12-hour clock never goes past twelve, and the minutes never past fifty-nine.
const BEST_TIME_12_HOUR_RE = /^(0?[1-9]|1[0-2]):[0-5]\d\s?(AM|PM)$/i;
const BEST_TIME_24_HOUR_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function isBestTimeDay(value: string): boolean {
  return BEST_TIME_DAYS.includes(value.trim().toLowerCase());
}

function isBestTimeClock(value: string): boolean {
  const trimmed = value.trim();
  return BEST_TIME_12_HOUR_RE.test(trimmed) || BEST_TIME_24_HOUR_RE.test(trimmed);
}

// A suggestion is only usable when every field the caller schedules from is
// there and carries a value: the platform, the day, the time, a score between
// 0 and 100, and the reason. The model is asked for that shape, but the answer
// is whatever came back, so the shape is checked rather than assumed.
// The check mirrors isBestTimeSuggestion in ../n8n-api/postActions.ts, which
// the API applies to the answers this service sends.
function isWellFormedSuggestion(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  // A field of the right type is not enough: an empty platform, day, time or
  // reason carries nothing the caller can schedule from, so it is refused the
  // same way a missing field is.
  if (typeof item.platform !== 'string' || item.platform.trim().length === 0) return false;
  if (typeof item.day !== 'string' || !isBestTimeDay(item.day)) return false;
  if (typeof item.time !== 'string' || !isBestTimeClock(item.time)) return false;
  if (typeof item.reason !== 'string' || item.reason.trim().length === 0) return false;
  return typeof item.score === 'number' &&
    Number.isFinite(item.score) &&
    item.score >= 0 && item.score <= 100;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handleCorsOptions();
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    const logRefusal = refusalLogger(createLogger(supabaseAdmin, 'suggest-best-times'));
    const refuse = async (
      reason: string,
      userId: string | null,
      message: string,
      status: number,
      metadata: Record<string, unknown> = {},
    ): Promise<Response> => {
      await logRefusal(reason, userId, { status, ...metadata });
      return errorResponse(message, status);
    };

    // Parse + validate body before touching any field. Previously this
    // function crashed with "Cannot read properties of undefined (reading
    // 'join')" when `platforms` or `historicalData` was missing.
    let body: { platforms?: unknown; historicalData?: unknown; user_id?: unknown } = {};
    try {
      const text = await req.text();
      if (text.length > MAX_BODY_CHARS) {
        return await refuse('body too large', null, 'Request body is too large', 413);
      }
      const parsed: unknown = text ? JSON.parse(text) : {};
      // JSON that is not an object (null, a number, an array) has no fields.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SyntaxError('body is not a JSON object');
      }
      body = parsed as typeof body;
    } catch {
      return await refuse('malformed JSON', null, 'Malformed JSON body', 400);
    }

    const { userId, isServiceRoleCall, hadAuthHeader } = await resolveCaller(req, body);

    // An anonymous caller gets no suggestion: the call is paid for, so it
    // needs an owner before it runs. The service role names the owner in the
    // body and a user names it with their own token; nobody else gets one.
    if (!userId) {
      return await refuse('no authenticated user', null, 'Authentication required', 401, {
        had_auth_header: hadAuthHeader,
      });
    }

    // See USER_RATE_LIMIT_REQUESTS for why service-role calls are not counted.
    if (!isServiceRoleCall) {
      // This file pins supabase-js 2.7.1 while the limiter types its client with
      // the current 2.x; only .rpc() is used, which both versions share.
      const rateLimit = await checkUserRateLimit(
        supabaseAdmin as unknown as Parameters<typeof checkUserRateLimit>[0],
        'suggest-best-times',
        userId,
        USER_RATE_LIMIT_REQUESTS,
        USER_RATE_LIMIT_WINDOW_SECONDS,
      );
      if (!rateLimit.allowed) {
        await logRefusal('hourly per-user limit reached', userId, {
          status: 429,
          retry_after_seconds: rateLimit.retryAfter,
        });
        return rateLimitExceededResponse(rateLimit, corsHeaders);
      }
    }

    const platforms = Array.isArray(body.platforms)
      ? body.platforms.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [];
    if (platforms.length === 0) {
      return await refuse('no platforms', userId,
        'platforms is required and must be a non-empty array of strings', 400);
    }
    if (platforms.length > MAX_PLATFORMS) {
      return await refuse('too many platforms', userId,
        `platforms may list at most ${MAX_PLATFORMS} platforms`, 400, { platform_count: platforms.length });
    }
    if (platforms.some((platform) => platform.length > MAX_PLATFORM_NAME_LENGTH)) {
      return await refuse('platform name too long', userId,
        `each platform name must be at most ${MAX_PLATFORM_NAME_LENGTH} characters`, 400);
    }
    // The history is written into the prompt as it is, so its size is the
    // size of the prompt. A real histogram (24 hours, 7 days) is far below
    // this; anything larger is not a posting history.
    if (JSON.stringify(body.historicalData ?? {}).length > MAX_HISTORY_CHARS) {
      return await refuse('historicalData too large', userId,
        `historicalData must be at most ${MAX_HISTORY_CHARS} characters`, 400);
    }

    const hd = (body.historicalData ?? {}) as Record<string, unknown>;
    const historicalData = {
      hourCounts: (hd.hourCounts as Record<string, number> | undefined) ?? {},
      dayCounts: (hd.dayCounts as Record<string, number> | undefined) ?? {},
      totalPosts: typeof hd.totalPosts === 'number' ? hd.totalPosts : 0,
    };

    // Fetch AI settings from app_settings
    const aiSettings = await fetchAiSettings(supabaseAdmin);

    console.log('Generating best time suggestions for:', platforms);

    const systemPrompt = `You are a social media analytics expert. Analyze the user's posting history and recommend optimal posting times.

You must return a JSON array of suggestions with this exact format:
[
  {
    "platform": "instagram",
    "day": "Monday",
    "time": "11:00 AM",
    "score": 95,
    "reason": "Brief explanation"
  }
]

Platform-specific best practices:
- Instagram: Lunch hours (11am-1pm), evenings (7-9pm), weekdays perform better
- Facebook: Mid-week (Tue-Thu), 1-4pm for B2C, mornings for B2B
- TikTok: Evenings (7-11pm), weekends, Gen-Z active hours
- Twitter: Morning news cycle (8-10am), lunch (12-1pm), after work (5-6pm)
- LinkedIn: Business hours, Tuesday-Thursday, 10am-12pm

Return 3 suggestions per platform, ordered by score (highest first).
Return ONLY valid JSON, no markdown or explanations.`;

    const userPrompt = `Generate best posting time suggestions for these platforms: ${platforms.join(', ')}

User's historical posting data:
- Hour distribution: ${JSON.stringify(historicalData.hourCounts)}
- Day distribution: ${JSON.stringify(historicalData.dayCounts)}
- Total successful posts: ${historicalData.totalPosts}

Combine industry best practices with the user's historical patterns to suggest optimal times.
Return a JSON array of suggestions.`;

    const requestBody = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
    };

    // 3-tier AI call
    const aiResult = await callAiWithFallback(
      requestBody,
      aiSettings.primaryProvider,
      aiSettings.primaryModel,
      aiSettings.fallbackProvider,
      aiSettings.fallbackModel,
    );

    const aiSuccess = aiResult.response.ok;

    if (!aiSuccess) {
      // The provider answered with an error, so the call failed. It is logged
      // on this path because nothing after it runs: the body is read for the
      // error message and the request ends.
      await logAiCall(supabaseAdmin, 'best_times_suggestion', 'suggest-best-times', userId, false, aiResult, {
        platforms,
      });
      const errorText = await aiResult.response.text();
      console.error('All AI tiers failed for best times:', errorText);
      return errorResponse('AI suggestion failed after all fallbacks. Please try again later.');
    }

    // The call is deliberately not logged yet: the log is written after the
    // answer has been validated, because an answer that cannot be used is a
    // failed call and not a successful one. A 2xx only says the provider
    // answered, not that the caller received a suggestion it can schedule.
    let rawContent: unknown;
    try {
      const data = await aiResult.response.json();
      rawContent = data.choices?.[0]?.message?.content;
    } catch (error) {
      // The body could not be read, or is not a shape that can be read: there
      // is nothing to validate, so the call is recorded as failed and the
      // error is re-thrown to the handler's catch, which answers the caller
      // exactly as it did before.
      await logAiCall(supabaseAdmin, 'best_times_suggestion', 'suggest-best-times', userId, false, aiResult, {
        platforms,
        parse_failed: true,
      }, {
        // The provider answered, so the answer itself is what was unusable.
        failureMessage: 'AI best_times_suggestion answered but the answer was not usable',
        failureLevel: 'warn',
      });
      throw error;
    }
    console.log(`Best times generated using ${aiResult.tierUsed} tier (${aiResult.modelUsed})`);

    // Parse JSON from response
    let suggestions = [];
    // The number of items in the answer that were not suggestions. The count is
    // reported, so a caller can tell a thin answer from a broken one.
    let droppedInvalid = 0;
    // An answer that cannot be read is not an empty answer: the flag tells the
    // caller that the list is missing because the model's answer failed to
    // parse, not because the model had nothing to say.
    let parseFailed = false;
    // Only an explicitly returned answer counts. A missing, null, empty or
    // non-string answer (a refusal, for instance) is a failed answer, not an
    // empty list of suggestions.
    const content = typeof rawContent === 'string' ? rawContent.trim() : '';
    if (content.length === 0) {
      console.error('Best times: the model returned no content');
      parseFailed = true;
      suggestions = [];
    } else {
      try {
        const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          // The model is asked for a fixed shape, but the answer is whatever
          // came back: an item without a day, a time or a score cannot be
          // scheduled, so it is dropped instead of being handed to the caller.
          const wellFormed = parsed.filter((value: unknown) => isWellFormedSuggestion(value));
          // A suggestion for a platform nobody asked for cannot be scheduled
          // for the caller, so it is not a usable suggestion either: it is
          // dropped the same way a malformed one is, and the platforms are
          // compared the way they were asked for, trimmed and lowercased.
          const requestedPlatforms = new Set(
            platforms.map((platform) => String(platform).trim().toLowerCase()),
          );
          const usable = wellFormed.filter((value: unknown) => {
            const item = value as { platform: string };
            return requestedPlatforms.has(String(item.platform).trim().toLowerCase());
          });
          droppedInvalid = parsed.length - usable.length;
          if (parsed.length > 0 && usable.length === 0) {
            // A list of items that are not suggestions is an answer that failed
            // to parse, not an answer that had nothing to say.
            parseFailed = true;
            suggestions = [];
            droppedInvalid = 0;
          } else {
            suggestions = usable;
          }
        } else {
          parseFailed = true;
        }
      } catch (parseError) {
        console.error('JSON parse error:', parseError, 'Content:', content);
        parseFailed = true;
        suggestions = [];
      }
    }

    // The answer has been read and checked, so the outcome of the call is
    // known: it succeeded only when a usable suggestion came back. This is
    // the one place the successful path logs, so every request that made an
    // AI call records it exactly once.
    //
    // An answer that parsed but carries no suggestion is not a successful
    // call: the provider answered, and the answer held nothing the caller can
    // schedule. It is told apart from a parse failure, which is a different
    // fault with a different fix.
    const emptyResult = !parseFailed && suggestions.length === 0;
    await logAiCall(supabaseAdmin, 'best_times_suggestion', 'suggest-best-times', userId, !parseFailed && suggestions.length > 0, aiResult, {
      platforms,
      ...(parseFailed ? { parse_failed: true } : {}),
      ...(emptyResult ? { empty_result: true } : {}),
      ...(droppedInvalid > 0 ? { dropped_invalid: droppedInvalid } : {}),
    }, {
      // The provider answered, so this is not an outage: the answer itself was
      // unusable. These options apply to the failed rows only.
      failureMessage: 'AI best_times_suggestion answered but the answer was not usable',
      failureLevel: 'warn',
    });

    console.log('Generated suggestions:', suggestions.length);

    return jsonResponse({
      suggestions,
      ...(parseFailed ? { parse_failed: true } : {}),
      ...(emptyResult ? { empty_result: true } : {}),
      ...(droppedInvalid > 0 ? { dropped_invalid: droppedInvalid } : {}),
    });

  } catch (error: unknown) {
    console.error('Error suggesting best times:', error);
    // The whole error stays in the log; the caller gets the sanitized one, so
    // a database or a provider message never reaches the caller as it is.
    return errorResponse(sanitizeErrorMessage(error));
  }
});
