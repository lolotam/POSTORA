import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlertTriangle, Info, RefreshCw, AtSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export type ThreadsReason =
  | "no_account"
  | "invalid_token"
  | "expired_token"
  | "wrong_account"
  | "missing_scope"
  | "permission_not_approved"
  | "not_eligible"
  | "not_found"
  | "rate_limited"
  | "transient"
  | "unknown";

export interface ThreadsErrorState {
  reason: ThreadsReason;
  message: string;
  meta?: { code?: number; subcode?: number; type?: string };
  needsConnection?: boolean;
  needsReauth?: boolean;
  branch?: "own_account_posts" | "public_profile_discovery";
}

type Tone = "amber" | "grey" | "red";

interface DisplayInfo {
  tone: Tone;
  title: string;
  body: string;
  action?: { label: string; href: string; icon?: any };
}

export function mapThreadsReason(
  body: { reason?: string; message?: string; meta?: any; needsConnection?: boolean; needsReauth?: boolean; branch?: string },
  feature: "discovery" | "keyword_search" | "insights",
): ThreadsErrorState {
  return {
    reason: (body.reason as ThreadsReason) || "unknown",
    message: body.message || "",
    meta: body.meta,
    needsConnection: body.needsConnection,
    needsReauth: body.needsReauth,
    branch: body.branch as ThreadsErrorState["branch"],
  };
}

function info(state: ThreadsErrorState, t: TFunction<"analytics">): DisplayInfo {
  const isOwn = state.branch === "own_account_posts";
  switch (state.reason) {
    case "no_account":
      return {
        tone: "amber",
        title: t("threads.connectAccount", "Connect Your Threads Account"),
        body: t("threads.connectToUse", "To use this feature, connect your Threads account on the Profiles page."),
        action: { label: t("actions.goToProfiles", "Go to Profiles"), href: "/profiles", icon: AtSign },
      };
    case "permission_not_approved":
      if (isOwn) {
        return {
          tone: "amber",
          title: t("threads.ownTokenTitle", "Token can't read your own posts"),
          body: state.message || t("threads.ownTokenRejected", "Your Threads token was rejected when reading your own posts. Try reconnecting Threads on the Profiles page."),
          action: { label: t("actions.reconnectThreads", "Reconnect Threads"), href: "/profiles", icon: RefreshCw },
        };
      }
      return {
        tone: "amber",
        title: t("threads.scopePendingTitle", "Meta has not approved this scope yet"),
        body: state.message || t("threads.scopePending", "This Threads permission is pending Meta approval for the app."),
      };
    case "missing_scope":
      if (isOwn) {
        return {
          tone: "amber",
          title: t("actions.reconnectThreads", "Reconnect Threads"),
          body: state.message || t("threads.missingScopeOwn", "Your Threads token can't read your own posts — try reconnecting on the Profiles page."),
          action: { label: t("actions.reconnectThreads", "Reconnect Threads"), href: "/profiles", icon: RefreshCw },
        };
      }
      return {
        tone: "amber",
        title: t("threads.missingScopeTitle", "Reconnect Threads to grant this scope"),
        body: state.message || t("threads.missingScopePublic", "Your token is missing the required Threads scope. Reconnect Threads on the Profiles page so the new scope is included."),
        action: { label: t("actions.reconnectThreads", "Reconnect Threads"), href: "/profiles", icon: RefreshCw },
      };
    case "invalid_token":
    case "expired_token":
    case "wrong_account":
      return {
        tone: "amber",
        title: t("threads.reconnectTitle", "Reconnect this Threads account"),
        body: state.message || t("threads.reconnectAccount", "This Threads token is no longer valid. Disconnect and reconnect to refresh it."),
        action: { label: t("actions.reconnectThreads", "Reconnect Threads"), href: "/profiles", icon: RefreshCw },
      };
    case "not_eligible":
      return {
        tone: "grey",
        title: t("threads.notEligibleTitle", "Profile not eligible"),
        body: state.message || t("threads.notEligible", "This profile isn't eligible for Profile Discovery (needs ≥100 followers and a public profile)."),
      };
    case "not_found":
      return {
        tone: "grey",
        title: t("threads.notFoundTitle", "Not found"),
        body: state.message || t("threads.notFound", "No matching Threads post or profile. It may have been deleted already."),
      };
    case "rate_limited":
      return {
        tone: "grey",
        title: t("threads.rateLimitedTitle", "Rate limited"),
        body: state.message || t("threads.rateLimited", "Meta rate-limited the app. Please try again in a minute."),
      };
    case "transient":
      return {
        tone: "grey",
        title: t("threads.temporaryTitle", "Temporary issue"),
        body: state.message || t("threads.temporary", "Meta returned a temporary error. Please retry."),
      };
    default:
      return {
        tone: "red",
        title: t("threads.threadsError", "Threads error"),
        body: state.message || t("errors.unknown", "Unknown error"),
      };
  }
}

export function ThreadsErrorCard({ state }: { state: ThreadsErrorState }) {
  const { t } = useTranslation("analytics");
  const d = info(state, t);

  const toneClass = d.tone === "amber"
    ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400"
    : d.tone === "grey"
      ? "border-border bg-muted/40 text-muted-foreground"
      : "border-destructive/30 bg-destructive/10 text-destructive";

  const Icon = d.tone === "red" ? AlertTriangle : Info;

  return (
    <Card className={toneClass}>
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start gap-2">
          <Icon className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="space-y-1 flex-1">
            <p className="text-sm font-medium">{d.title}</p>
            <p className="text-sm opacity-90">{d.body}</p>
            {state.meta?.code !== undefined && (
              <p className="text-[11px] opacity-70 font-mono">
                {t("threads.metaError", "Meta error {{code}}{{sub}}{{type}}", {
                  code: state.meta.code,
                  sub: state.meta.subcode ? `/${state.meta.subcode}` : "",
                  type: state.meta.type ? ` · ${state.meta.type}` : "",
                })}
              </p>
            )}
          </div>
        </div>
        {d.action && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => (window.location.href = d.action!.href)}
            className="gap-2"
          >
            {d.action.icon && <d.action.icon className="w-3.5 h-3.5" />}
            {d.action.label}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
