import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { callAiWithFallback, fetchAiSettings, logAiCall } from "../_shared/ai-fallback.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth verification
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: { user }, error: userError } = await supabaseClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check admin
    const { data: role } = await supabaseAdmin
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('role', 'admin')
      .maybeSingle();

    if (!role) {
      return new Response(
        JSON.stringify({ error: 'Admin access required' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { log } = await req.json();
    if (!log) {
      return new Response(
        JSON.stringify({ error: 'Missing log data' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ─── Fetch enriched context ───────────────────────────────────────────

    // 1. User profile if user_id exists
    let userProfile: { email?: string; full_name?: string; plan?: string } | null = null;
    if (log.user_id) {
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('email, full_name')
        .eq('id', log.user_id)
        .maybeSingle();

      const { data: subscription } = await supabaseAdmin
        .from('user_subscriptions')
        .select('subscription_plans(name)')
        .eq('user_id', log.user_id)
        .eq('status', 'active')
        .maybeSingle();

      userProfile = {
        email: profile?.email,
        full_name: profile?.full_name,
        plan: (subscription?.subscription_plans as any)?.name || 'Free',
      };
    }

    // 2. Recent related logs (last 5 from same source or user)
    let recentLogs: any[] = [];
    try {
      let query = supabaseAdmin
        .from('system_logs')
        .select('level, source, message, created_at, metadata')
        .order('created_at', { ascending: false })
        .limit(5)
        .neq('id', log.id);

      if (log.user_id) {
        query = query.eq('user_id', log.user_id);
      } else {
        query = query.eq('source', log.source);
      }

      const { data } = await query;
      recentLogs = data || [];
    } catch { /* non-critical */ }

    // ─── Fetch AI model config ────────────────────────────────────────────

    const aiSettings = await fetchAiSettings(supabaseAdmin);

    // ─── Build prompts with full context ──────────────────────────────────

    const systemPrompt = `You are a senior full-stack debugger for Postora, a social media management platform built with React 18, TypeScript, Vite, Tailwind CSS, Supabase (PostgreSQL + Edge Functions in Deno), and TanStack Query.

You have access to the full user context, event metadata, and recent related logs. Use all available information to produce accurate, actionable analysis.

Analyze the provided system log entry and return a JSON object with exactly three fields:
- "explanation": A clear, non-technical explanation of what happened (2-3 sentences max). Reference the specific user and platform if available.
- "root_cause": The most likely technical root cause and why it happened (2-4 sentences). Consider the user's plan, account state, and recent log history for patterns.
- "lovable_prompt": A detailed, actionable prompt that an admin can paste into the Lovable AI chat to investigate and fix this issue. Include specific file paths, function names, and what changes are needed. Be specific and reference the Postora codebase structure (supabase/functions/ for edge functions, src/pages/ for pages, src/hooks/ for hooks). If the issue is user-specific (bad token, expired account), say so instead of suggesting code changes.

Return ONLY valid JSON, no markdown formatting.`;

    // Build rich user prompt
    const userPromptParts = [
      `Analyze this system log entry:`,
      ``,
      `Level: ${log.level}`,
      `Category: ${log.category || 'unknown'}`,
      `Source: ${log.source || 'unknown'}`,
      `Message: ${log.message}`,
      `Timestamp: ${log.created_at}`,
    ];

    // Add user context
    if (userProfile) {
      userPromptParts.push(``);
      userPromptParts.push(`── User Context ──`);
      userPromptParts.push(`Email: ${userProfile.email || 'Unknown'}`);
      userPromptParts.push(`Name: ${userProfile.full_name || 'Unknown'}`);
      userPromptParts.push(`Plan: ${userProfile.plan || 'Free'}`);
    } else if (log.userEmail) {
      userPromptParts.push(`User: ${log.userEmail}`);
    } else {
      userPromptParts.push(`User: System (no user associated)`);
    }

    // Add full metadata
    userPromptParts.push(``);
    userPromptParts.push(`── Full Metadata/Details ──`);
    userPromptParts.push(JSON.stringify(log.metadata || {}, null, 2));

    // Add recent related logs for pattern detection
    if (recentLogs.length > 0) {
      userPromptParts.push(``);
      userPromptParts.push(`── Recent Related Logs (last ${recentLogs.length}) ──`);
      for (const rl of recentLogs) {
        userPromptParts.push(`[${rl.level}] ${rl.created_at} | ${rl.source}: ${rl.message}`);
        if (rl.metadata && Object.keys(rl.metadata).length > 0) {
          userPromptParts.push(`  metadata: ${JSON.stringify(rl.metadata)}`);
        }
      }
    }

    const userPrompt = userPromptParts.join('\n');

    // ─── Call AI with 3-tier fallback ─────────────────────────────────────

    const requestBody = {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'analyze_log',
            description: 'Return structured analysis of a system log entry',
            parameters: {
              type: 'object',
              properties: {
                explanation: { type: 'string', description: 'Plain-language explanation of what happened' },
                root_cause: { type: 'string', description: 'Technical root cause analysis' },
                lovable_prompt: { type: 'string', description: 'Actionable prompt for Lovable AI to fix the issue' },
              },
              required: ['explanation', 'root_cause', 'lovable_prompt'],
              additionalProperties: false,
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'analyze_log' } },
    };

    const aiResult = await callAiWithFallback(
      requestBody,
      aiSettings.primaryProvider,
      aiSettings.primaryModel,
      aiSettings.fallbackProvider,
      aiSettings.fallbackModel,
    );

    const aiSuccess = aiResult.response.ok;

    // Log AI call
    await logAiCall(supabaseAdmin, 'log_analysis', 'analyze-log', user.id, aiSuccess, aiResult, {
      log_id: log.id,
      log_level: log.level,
      log_source: log.source,
    });

    if (!aiSuccess) {
      const errorText = await aiResult.response.text();
      console.error('All AI tiers failed for log analysis:', errorText);
      return new Response(
        JSON.stringify({ error: `AI analysis failed after all fallback tiers. Last error: ${errorText.substring(0, 200)}` }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const data = await aiResult.response.json();
    console.log(`Log analyzed using ${aiResult.tierUsed} tier (${aiResult.modelUsed})`);
    
    // Extract from tool call response
    let analysis = null;
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      try {
        analysis = JSON.parse(toolCall.function.arguments);
      } catch {
        console.error('Failed to parse tool call arguments');
      }
    }

    // Fallback: try parsing from content
    if (!analysis) {
      const content = data.choices?.[0]?.message?.content || '';
      try {
        analysis = JSON.parse(content);
      } catch {
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
          try { analysis = JSON.parse(jsonMatch[1].trim()); } catch { /* give up */ }
        }
      }
    }

    if (!analysis) {
      return new Response(
        JSON.stringify({ error: 'Failed to get structured analysis from AI' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const result = {
      explanation: analysis.explanation || 'No explanation available',
      root_cause: analysis.root_cause || 'No root cause identified',
      lovable_prompt: analysis.lovable_prompt || 'No prompt generated',
    };

    // Persist analysis to database
    try {
      await supabaseAdmin
        .from('log_analyses')
        .upsert({
          log_id: log.id,
          explanation: result.explanation,
          root_cause: result.root_cause,
          lovable_prompt: result.lovable_prompt,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'log_id' });
    } catch (e) {
      console.error('Failed to persist analysis:', e);
    }

    return new Response(
      JSON.stringify(result),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error analyzing log:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
