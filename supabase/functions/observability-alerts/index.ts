import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { verifyCronAuth } from "../_shared/cron-auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface AlertConfig {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  metric_type: string | null;
  metric_name: string | null;
  threshold_value: number;
  threshold_operator: string;
  time_window_minutes: number;
  notification_channels: string[];
  notification_emails: string[];
  webhook_url: string | null;
  cooldown_minutes: number;
  last_triggered_at: string | null;
  is_active: boolean;
}

interface HealthSnapshot {
  overall_health_score: number;
  edge_functions_health: number | null;
  database_health: number | null;
  token_health: number | null;
  cron_health: number | null;
  active_errors_count: number;
  failed_functions_count: number;
  metrics_breakdown: Record<string, any>;
}

function compareValue(value: number, threshold: number, operator: string): boolean {
  switch (operator) {
    case "gt": return value > threshold;
    case "gte": return value >= threshold;
    case "lt": return value < threshold;
    case "lte": return value <= threshold;
    case "eq": return value === threshold;
    default: return value >= threshold;
  }
}

function determineSeverity(triggerType: string, value: number, threshold: number): string {
  const ratio = triggerType.includes("health") ? (threshold - value) / threshold : (value - threshold) / threshold;
  if (ratio > 0.5) return "critical";
  if (ratio > 0.2) return "warning";
  return "info";
}

// Send Slack notification
async function sendSlackNotification(
  webhookUrl: string,
  alertName: string,
  triggerType: string,
  currentValue: number,
  threshold: number,
  operator: string,
  severity: string,
  description?: string | null
): Promise<boolean> {
  try {
    const severityEmoji = severity === "critical" ? "🚨" : severity === "warning" ? "⚠️" : "ℹ️";
    const severityColor = severity === "critical" ? "#ef4444" : severity === "warning" ? "#eab308" : "#3b82f6";

    const payload = {
      attachments: [
        {
          color: severityColor,
          blocks: [
            {
              type: "header",
              text: {
                type: "plain_text",
                text: `${severityEmoji} Alert: ${alertName}`,
                emoji: true,
              },
            },
            {
              type: "section",
              fields: [
                {
                  type: "mrkdwn",
                  text: `*Trigger Type:*\n${triggerType.replace(/_/g, " ")}`,
                },
                {
                  type: "mrkdwn",
                  text: `*Severity:*\n${severity.toUpperCase()}`,
                },
                {
                  type: "mrkdwn",
                  text: `*Current Value:*\n${currentValue}`,
                },
                {
                  type: "mrkdwn",
                  text: `*Threshold:*\n${operator} ${threshold}`,
                },
              ],
            },
            ...(description ? [{
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Description:*\n${description}`,
              },
            }] : []),
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "View Dashboard",
                    emoji: true,
                  },
                  url: "https://postora.cloud/admin/observability",
                  style: "primary",
                },
              ],
            },
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Triggered at ${new Date().toISOString()}`,
                },
              ],
            },
          ],
        },
      ],
    };

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error("[OBSERVABILITY-ALERTS] Slack webhook error:", await response.text());
      return false;
    }

    console.log("[OBSERVABILITY-ALERTS] Slack notification sent successfully");
    return true;
  } catch (error) {
    console.error("[OBSERVABILITY-ALERTS] Slack error:", error);
    return false;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // P1-1: require CRON_SECRET (or service-role) before doing any work.
  // This function is invoked exclusively by pg_cron; any unauthenticated
  // caller would be able to drain email/Slack quota and trigger admin spam.
  const __cronAuth = verifyCronAuth(req);
  if (!__cronAuth.ok) return __cronAuth.response;


  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    console.log("[OBSERVABILITY-ALERTS] Evaluating alert rules...");

    // Check admin email settings for both general observability and token health
    const { data: emailSettingRows } = await supabase
      .from("app_settings")
      .select("key, value")
      .in("key", ["admin_email_observability_alerts", "admin_email_token_health_alerts"]);

    const settingsMap: Record<string, boolean> = {};
    for (const row of emailSettingRows || []) {
      let val = row.value;
      if (typeof val === "string") {
        try { val = JSON.parse(val); } catch { /* keep as-is */ }
      }
      settingsMap[row.key] = val === true || val === "true";
    }
    // Default true if not set
    const adminEmailObservabilityEnabled = settingsMap["admin_email_observability_alerts"] ?? true;
    const adminEmailTokenHealthEnabled = settingsMap["admin_email_token_health_alerts"] ?? true;

    // Fetch active alert configs
    const { data: alertConfigs, error: configError } = await supabase
      .from("observability_alert_configs")
      .select("*")
      .eq("is_active", true);

    if (configError) throw configError;
    if (!alertConfigs || alertConfigs.length === 0) {
      console.log("[OBSERVABILITY-ALERTS] No active alert rules found");
      return new Response(
        JSON.stringify({ success: true, message: "No active alerts" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch latest health snapshot
    const { data: latestHealth, error: healthError } = await supabase
      .from("observability_health_snapshots")
      .select("*")
      .order("captured_at", { ascending: false })
      .limit(1)
      .single();

    if (healthError && healthError.code !== "PGRST116") throw healthError;

    const alertsTriggered: string[] = [];
    const now = new Date();

    // Evaluate each alert config
    for (const config of alertConfigs as AlertConfig[]) {
      // Check cooldown
      if (config.last_triggered_at) {
        const lastTriggered = new Date(config.last_triggered_at);
        const cooldownEnd = new Date(lastTriggered.getTime() + config.cooldown_minutes * 60 * 1000);
        if (now < cooldownEnd) {
          console.log(`[OBSERVABILITY-ALERTS] Skipping ${config.name} - in cooldown`);
          continue;
        }
      }

      let currentValue: number | null = null;
      let shouldTrigger = false;

      switch (config.trigger_type) {
        case "error_rate": {
          // Calculate error rate from recent logs
          const windowStart = new Date(now.getTime() - config.time_window_minutes * 60 * 1000).toISOString();
          const { data: logs } = await supabase
            .from("system_logs")
            .select("level")
            .gte("created_at", windowStart);
          
          const total = logs?.length || 0;
          const errors = logs?.filter(l => l.level === "error").length || 0;
          currentValue = total > 0 ? Math.round((errors / total) * 100) : 0;
          shouldTrigger = compareValue(currentValue, config.threshold_value, config.threshold_operator);
          break;
        }

        case "response_time": {
          // Use database query time as proxy for system response time
          currentValue = latestHealth?.metrics_breakdown?.db_query_time_ms || 0;
          shouldTrigger = compareValue(currentValue ?? 0, config.threshold_value, config.threshold_operator);
          break;
        }

        case "function_failure": {
          currentValue = latestHealth?.failed_functions_count || 0;
          shouldTrigger = compareValue(currentValue ?? 0, config.threshold_value, config.threshold_operator);
          break;
        }

        case "health_score": {
          currentValue = latestHealth?.overall_health_score ?? 100;
          shouldTrigger = compareValue(currentValue ?? 0, config.threshold_value, config.threshold_operator);
          break;
        }

        case "token_health": {
          currentValue = latestHealth?.token_health ?? 100;
          shouldTrigger = compareValue(currentValue ?? 0, config.threshold_value, config.threshold_operator);
          break;
        }

        case "cron_failure": {
          const windowStart = new Date(now.getTime() - config.time_window_minutes * 60 * 1000).toISOString();
          const { data: cronLogs } = await supabase
            .from("token_refresh_history")
            .select("status")
            .gte("created_at", windowStart)
            .eq("status", "failed");
          
          currentValue = cronLogs?.length || 0;
          shouldTrigger = compareValue(currentValue, config.threshold_value, config.threshold_operator);
          break;
        }

        default:
          console.log(`[OBSERVABILITY-ALERTS] Unknown trigger type: ${config.trigger_type}`);
          continue;
      }

      if (shouldTrigger && currentValue !== null) {
        const severity = determineSeverity(config.trigger_type, currentValue, config.threshold_value);
        
        console.log(`[OBSERVABILITY-ALERTS] Triggering alert: ${config.name} (value: ${currentValue}, threshold: ${config.threshold_value})`);

        // Create alert history entry
        const { data: alertEntry, error: alertError } = await supabase
          .from("observability_alert_history")
          .insert({
            alert_config_id: config.id,
            alert_name: config.name,
            trigger_type: config.trigger_type,
            triggered_value: currentValue,
            threshold_value: config.threshold_value,
            metric_type: config.metric_type,
            metric_name: config.metric_name,
            severity,
            details: {
              operator: config.threshold_operator,
              time_window_minutes: config.time_window_minutes,
              health_snapshot: latestHealth ? {
                overall: latestHealth.overall_health_score,
                functions: latestHealth.edge_functions_health,
                database: latestHealth.database_health,
                tokens: latestHealth.token_health,
                cron: latestHealth.cron_health,
              } : null,
            },
          })
          .select()
          .single();

        if (alertError) {
          console.error(`[OBSERVABILITY-ALERTS] Error creating alert entry:`, alertError);
          continue;
        }

        const notificationsSent: string[] = [];
        let notificationError: string | null = null;

        // Determine which toggle applies for this alert type
        const emailToggleForAlert = config.trigger_type === "token_health"
          ? adminEmailTokenHealthEnabled
          : adminEmailObservabilityEnabled;

        // Send email notification
        if (emailToggleForAlert && config.notification_channels.includes("email") && config.notification_emails?.length > 0 && resendApiKey) {
          try {
            const resend = new Resend(resendApiKey);
            
            const severityEmoji = severity === "critical" ? "🚨" : severity === "warning" ? "⚠️" : "ℹ️";
            const severityColor = severity === "critical" ? "#ef4444" : severity === "warning" ? "#eab308" : "#3b82f6";

            await resend.emails.send({
              from: "Postora Alerts <alerts@postora.cloud>",
              to: config.notification_emails,
              subject: `${severityEmoji} [${severity.toUpperCase()}] ${config.name}`,
              html: `
                <div style="font-family: system-ui, sans-serif; max-width: 600px; margin: 0 auto;">
                  <div style="background: ${severityColor}; color: white; padding: 20px; border-radius: 8px 8px 0 0;">
                    <h1 style="margin: 0; font-size: 20px;">${severityEmoji} Alert Triggered: ${config.name}</h1>
                  </div>
                  <div style="background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px;">
                    <table style="width: 100%; border-collapse: collapse;">
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Trigger Type</td>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;">${config.trigger_type.replace(/_/g, " ")}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Current Value</td>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; color: ${severityColor}; font-weight: bold;">${currentValue}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Threshold</td>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;">${config.threshold_operator} ${config.threshold_value}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb; font-weight: 600;">Severity</td>
                        <td style="padding: 8px 0; border-bottom: 1px solid #e5e7eb;">${severity.toUpperCase()}</td>
                      </tr>
                      <tr>
                        <td style="padding: 8px 0; font-weight: 600;">Time</td>
                        <td style="padding: 8px 0;">${now.toISOString()}</td>
                      </tr>
                    </table>
                    ${config.description ? `<p style="margin-top: 16px; color: #6b7280;">${config.description}</p>` : ""}
                    <div style="margin-top: 20px;">
                      <a href="https://postora.cloud/admin/observability" 
                         style="display: inline-block; background: #6366f1; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500;">
                        View Dashboard
                      </a>
                    </div>
                  </div>
                </div>
              `,
            });

            notificationsSent.push("email");
            console.log(`[OBSERVABILITY-ALERTS] Email sent for: ${config.name}`);
          } catch (emailError: unknown) {
            console.error(`[OBSERVABILITY-ALERTS] Email error:`, emailError);
            notificationError = emailError instanceof Error ? emailError.message : String(emailError);
          }
        }

        // Send Slack notification
        if (config.notification_channels.includes("slack") && config.webhook_url) {
          const slackSuccess = await sendSlackNotification(
            config.webhook_url,
            config.name,
            config.trigger_type,
            currentValue,
            config.threshold_value,
            config.threshold_operator,
            severity,
            config.description
          );
          
          if (slackSuccess) {
            notificationsSent.push("slack");
          } else {
            notificationError = notificationError 
              ? `${notificationError}; Slack failed` 
              : "Slack notification failed";
          }
        }

        // Update alert entry with notification status
        await supabase
          .from("observability_alert_history")
          .update({ 
            notification_sent: notificationsSent.length > 0, 
            notification_channel: notificationsSent.join(","),
            notification_error: notificationError,
          })
          .eq("id", alertEntry.id);

        // Update last triggered timestamp
        await supabase
          .from("observability_alert_configs")
          .update({ last_triggered_at: now.toISOString() })
          .eq("id", config.id);

        alertsTriggered.push(config.name);
      }
    }

    console.log(`[OBSERVABILITY-ALERTS] Evaluation complete. Alerts triggered: ${alertsTriggered.length}`);

    return new Response(
      JSON.stringify({
        success: true,
        alertsTriggered,
        totalEvaluated: alertConfigs.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("[OBSERVABILITY-ALERTS] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
