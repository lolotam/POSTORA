import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { handleCorsOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { callAiWithFallback, fetchAiSettings, logAiCall } from "../_shared/ai-fallback.ts";
import { timingSafeTokenEqual } from "../_shared/auth-helper.ts";

// A user id that reaches the database has to be a uuid: an id that is not one
// makes the write of the log row fail with 22P02, and the AI call is then
// logged against nobody.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return handleCorsOptions();
  }

  try {
    // Parse + validate body before touching any field. Previously this
    // function crashed with "Cannot read properties of undefined (reading
    // 'join')" when `platforms` or `historicalData` was missing.
    let body: { platforms?: unknown; historicalData?: unknown; user_id?: unknown } = {};
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return errorResponse('Malformed JSON body', 400);
    }

    const platforms = Array.isArray(body.platforms)
      ? body.platforms.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [];
    if (platforms.length === 0) {
      return errorResponse('platforms is required and must be a non-empty array of strings', 400);
    }

    const hd = (body.historicalData ?? {}) as Record<string, unknown>;
    const historicalData = {
      hourCounts: (hd.hourCounts as Record<string, number> | undefined) ?? {},
      dayCounts: (hd.dayCounts as Record<string, number> | undefined) ?? {},
      totalPosts: typeof hd.totalPosts === 'number' ? hd.totalPosts : 0,
    };

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    // Get user from auth header if available
    let userId: string | null = null;
    const authHeader = req.headers.get('Authorization');
    const bearerToken = authHeader ? authHeader.replace('Bearer ', '').trim() : '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const bodyUserId = typeof body.user_id === 'string' ? body.user_id.trim() : '';

    // A service-role call carries no user JWT, so the owner of the API key is
    // named in the body instead. The bearer token is the service-role key, so
    // the caller is authenticated as the service role and the id may be used;
    // a user_id from any other caller is ignored.
    if (
      serviceRoleKey.length > 0 &&
      timingSafeTokenEqual(bearerToken, serviceRoleKey) &&
      UUID_RE.test(bodyUserId)
    ) {
      userId = bodyUserId;
    } else if (authHeader) {
      const token = authHeader.replace('Bearer ', '');
      const supabaseClient = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user } } = await supabaseClient.auth.getUser(token);
      userId = user?.id || null;
    }

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

    // Log AI call
    await logAiCall(supabaseAdmin, 'best_times_suggestion', 'suggest-best-times', userId, aiSuccess, aiResult, {
      platforms,
    });

    if (!aiSuccess) {
      const errorText = await aiResult.response.text();
      console.error('All AI tiers failed for best times:', errorText);
      return errorResponse('AI suggestion failed after all fallbacks. Please try again later.');
    }

    const data = await aiResult.response.json();
    const content = data.choices?.[0]?.message?.content || '[]';
    console.log(`Best times generated using ${aiResult.tierUsed} tier (${aiResult.modelUsed})`);

    // Parse JSON from response
    let suggestions = [];
    // An answer that cannot be read is not an empty answer: the flag tells the
    // caller that the list is missing because the model's answer failed to
    // parse, not because the model had nothing to say.
    let parseFailed = false;
    try {
      const jsonStr = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) {
        suggestions = parsed;
      } else {
        parseFailed = true;
      }
    } catch (parseError) {
      console.error('JSON parse error:', parseError, 'Content:', content);
      parseFailed = true;
      suggestions = [];
    }

    console.log('Generated suggestions:', suggestions.length);

    return jsonResponse({ suggestions, ...(parseFailed ? { parse_failed: true } : {}) });

  } catch (error: unknown) {
    console.error('Error suggesting best times:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(message);
  }
});
