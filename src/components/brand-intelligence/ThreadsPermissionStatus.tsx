import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useThreadsCapabilities } from "@/hooks/useThreadsCapabilities";

interface ThreadsPermissionStatusProps {
  feature: "analyze" | "discovery" | "keyword_search" | "insights";
}

const FEATURE_META: Record<string, { label: string; scope: string; endpoint: string; note?: string }> = {
  analyze: {
    label: "Analyze",
    scope: "threads_profile_discovery",
    endpoint: "GET /v1.0/profile_posts",
    note: "Analyze uses the same endpoint as Discovery. Without advanced access, only public profiles with ≥100 followers and certain Meta-owned accounts are retrievable.",
  },
  discovery: {
    label: "Discovery",
    scope: "threads_profile_discovery",
    endpoint: "GET /v1.0/profile_posts",
    note: "Under standard access, only Meta accounts (@meta, @threads, @instagram, @facebook) are retrievable until Meta approves advanced access.",
  },
  keyword_search: {
    label: "Keyword Search",
    scope: "threads_keyword_search",
    endpoint: "GET /v1.0/keyword_search",
    note: "Without approval, search is limited to posts owned by the authenticated user.",
  },
  insights: {
    label: "Insights",
    scope: "threads_manage_insights",
    endpoint: "GET /{user-id}/threads_insights",
  },
};

export function ThreadsPermissionStatus({ feature }: ThreadsPermissionStatusProps) {
  const { t } = useTranslation("analytics");
  const navigate = useNavigate();
  const { data: caps, isLoading, refetch } = useThreadsCapabilities();
  const meta = FEATURE_META[feature];
  const featureLabel =
    feature === "analyze" ? t("header.analyze", "Analyze")
    : feature === "discovery" ? t("header.discovery", "Discovery")
    : feature === "keyword_search" ? t("header.keywordSearch", "Keyword Search")
    : t("header.insights", "Insights");
  const featureNote =
    feature === "analyze" ? t("permissions.analyzeNote", "Analyze uses the same endpoint as Discovery. Without advanced access, only public profiles with ≥100 followers and certain Meta-owned accounts are retrievable.")
    : feature === "discovery" ? t("permissions.discoveryNote", "Under standard access, only Meta accounts (@meta, @threads, @instagram, @facebook) are retrievable until Meta approves advanced access.")
    : feature === "keyword_search" ? t("permissions.keywordNote", "Without approval, search is limited to posts owned by the authenticated user.")
    : null;

  if (isLoading) return null;

  if (!caps?.connected) {
    return (
      <Alert variant="destructive">
        <XCircle className="h-4 w-4" />
        <AlertTitle>{t("permissions.notConnected", "Threads not connected")}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{t("permissions.needConnect", "You need to connect a Threads account before using {{feature}}.", { feature: featureLabel })}</p>
          <Button size="sm" variant="outline" onClick={() => navigate("/profiles")}>
            {t("actions.connectThreads", "Connect Threads")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const featureFlag: Record<string, boolean | null> = {
    analyze: caps.canUseDiscovery,
    discovery: caps.canUseDiscovery,
    keyword_search: caps.canUseKeywordSearch,
    insights: caps.canViewInsights,
  };

  const access = featureFlag[feature]; // true | false | null
  const hasAccess = access === true;
  const verifiedMissing = access === false;
  // Stored capability flags are advisory only. The live edge function is the
  // source of truth — a stale `false` from an earlier probe must not render a
  // destructive blocking banner before the user even tries a search.
  const tone: "default" | "destructive" = hasAccess ? "default" : "default";
  const badgeVariant: "default" | "secondary" | "outline" = hasAccess
    ? "default"
    : verifiedMissing
      ? "outline"
      : "secondary";
  const badgeLabel = hasAccess
    ? t("permissions.available", "Available")
    : verifiedMissing
      ? t("permissions.mayReconnect", "May require reconnect")
      : t("permissions.notVerified", "Not yet verified");

  return (
    <Alert variant={tone}>
      {hasAccess ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
      <AlertTitle className="flex items-center gap-2 flex-wrap">
        {featureLabel}
        <Badge variant={badgeVariant} className="text-xs">
          {badgeLabel}
        </Badge>
        <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{meta.scope}</code>
      </AlertTitle>
      <AlertDescription className="space-y-2 mt-2">
        <p className="text-xs font-mono text-muted-foreground">{meta.endpoint}</p>
        {!hasAccess && (
          <p className="text-sm text-muted-foreground">
            {verifiedMissing
              ? t("permissions.staleProbe", "An earlier probe didn't see {{scope}} on this token. Try a search — the live request will return the precise reason if Meta still rejects it. If it does, reconnect Threads to refresh the scope.", { scope: meta.scope })
              : t("permissions.capabilityUnverified", "Capability not yet verified for this token — try a search; we'll show the precise reason if Meta rejects it.")}
          </p>
        )}
        {featureNote && (
          <p className="text-sm text-muted-foreground italic">ℹ️ {featureNote}</p>
        )}
        <div className="flex gap-2 pt-1 flex-wrap">
          <Button size="sm" variant="outline" onClick={() => navigate("/profiles")}>
            <RefreshCw className="w-3.5 h-3.5 me-1.5" /> {t("actions.reconnectThreads", "Reconnect Threads")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => refetch()}>
            {t("actions.recheckCapabilities", "Re-check capabilities")}
          </Button>
          <a
            href="https://developers.facebook.com/docs/threads/overview"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
          >
            {t("permissions.docs", "Meta Threads docs")} <ExternalLink className="w-3 h-3 ms-1" />
          </a>
        </div>
        {caps.username && (
          <p className="text-xs text-muted-foreground">
            {t("permissions.connectedAsPlain", "Connected as @{{username}}", { username: caps.username })}
            {caps.probedAt && t("permissions.probedAt", " · capabilities probed {{date}}", { date: new Date(caps.probedAt).toLocaleString() })}
          </p>
        )}
      </AlertDescription>
    </Alert>
  );
}
