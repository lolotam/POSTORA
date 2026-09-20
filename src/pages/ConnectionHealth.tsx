import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PlatformIcon, getPlatformName, ExtendedPlatform } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { PLATFORM_TOKEN_INFO } from "@/lib/tokenExpiryConstants";
import { useProfileOAuth } from "@/hooks/useProfileOAuth";
import {
    RefreshCw,
    CheckCircle2,
    AlertCircle,
    Clock,
    XCircle,
    Loader2,
    Activity,
    Shield,
    Zap,
    Link2,
    ExternalLink,
    Info,
    RotateCcw,
    Mail,
} from "lucide-react";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCopyToClipboard } from "@/hooks/shared";
import {
    isMessagingPlatform,
    resolveWebhookIdentity,
    useInboundActivity,
} from "@/features/webhook-observability";

interface SocialAccountHealth {
    id: string;
    platform: Platform;
    platform_username: string | null;
    avatar_url: string | null;
    token_expires_at: string | null;
    updated_at: string;
    connected_at: string;
    is_active: boolean;
    needs_reauth: boolean;
    failure_count: number;
    last_refresh_error: string | null;
    social_profile_id: string | null;
    platform_user_id: string | null;
    account_metadata: unknown;
}

type HealthStatus = "healthy" | "expired" | "unknown" | "needs_reauth" | "disconnected";

function getTokenHealth(expiresAt: string | null, platform: string, needsReauth: boolean | undefined, isActive: boolean, t: TFunction): { status: HealthStatus; daysLeft: number | null; hoursLeft: number | null; message: string } {
    // Ahead of every token check on purpose. A disconnected account can still hold a
    // perfectly valid token, so judging it on expiry alone renders it "Active" and offers
    // Refresh -- while webhooks for it are being dropped, because both account resolvers
    // filter is_active = true. The row has to say what is actually wrong with it.
    if (!isActive) {
        return { status: "disconnected", daysLeft: null, hoursLeft: null, message: t("health.message.disconnected", "Disconnected - reconnect to receive events") };
    }

    // Check needs_reauth first
    if (needsReauth) {
        return { status: "needs_reauth", daysLeft: null, hoursLeft: null, message: t("health.message.reconnectionRequired", "Reconnection required") };
    }

    if (!expiresAt) {
        return { status: "unknown", daysLeft: null, hoursLeft: null, message: t("health.message.noExpiry", "No expiry info") };
    }

    const now = new Date();
    const expiry = new Date(expiresAt);
    const diffMs = expiry.getTime() - now.getTime();
    const hoursLeft = Math.ceil(diffMs / (1000 * 60 * 60));
    const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    // Get platform-specific threshold
    const platformInfo = PLATFORM_TOKEN_INFO[platform.toLowerCase()];
    const thresholdDays = platformInfo ? Math.ceil(platformInfo.refreshWindowSeconds / 86400) : 7;

    if (hoursLeft < 0) {
        return { status: "expired", daysLeft: 0, hoursLeft: 0, message: t("health.message.tokenExpired", "Token expired") };
    } else {
        return { status: "healthy", daysLeft, hoursLeft, message: t("health.message.validFor", "Valid for {{days}} days", { days: daysLeft }) };
    }
}

function getStatusIcon(status: HealthStatus) {
    switch (status) {
        case "healthy":
            return <CheckCircle2 className="w-5 h-5 text-green-500" />;
        case "expired":
            return <XCircle className="w-5 h-5 text-destructive" />;
        case "needs_reauth":
            return <RefreshCw className="w-5 h-5 text-red-600" />;
        case "disconnected":
            return <Link2 className="w-5 h-5 text-amber-500" />;
        default:
            return <Clock className="w-5 h-5 text-muted-foreground" />;
    }
}

function getStatusBadge(status: HealthStatus, t: TFunction) {
    const variants: Record<HealthStatus, { variant: "default" | "secondary" | "destructive" | "outline"; className: string }> = {
        healthy: { variant: "default", className: "bg-green-500/10 text-green-500 border-green-500/30 hover:bg-green-500/20" },
        expired: { variant: "destructive", className: "" },
        needs_reauth: { variant: "destructive", className: "bg-red-600/10 text-red-600 border-red-600/30" },
        unknown: { variant: "secondary", className: "" },
        disconnected: { variant: "outline", className: "bg-amber-500/10 text-amber-600 border-amber-500/30" },
    };

    const labels: Record<HealthStatus, string> = {
        healthy: t("health.status.active", "Active"),
        expired: t("health.status.expired", "Expired"),
        needs_reauth: t("health.status.needsReconnect", "Needs Reconnect"),
        unknown: t("common:unknown", "Unknown"),
        disconnected: t("health.status.disconnected", "Disconnected"),
    };

    return (
        <Badge variant={variants[status].variant} className={variants[status].className}>
            {labels[status]}
        </Badge>
    );
}

export default function ConnectionHealth() {
    const { t } = useTranslation("accounts");
    const { user } = useAuth();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [testingAccountId, setTestingAccountId] = useState<string | null>(null);
    const [refreshingAccountId, setRefreshingAccountId] = useState<string | null>(null);
    const [isSendingTestNotification, setIsSendingTestNotification] = useState(false);
    const { handleConnectPlatform, connectingPlatform } = useProfileOAuth();
    const { data: inboundActivity } = useInboundActivity();
    const { copy, copiedId } = useCopyToClipboard({ showToast: true, successMessage: t("health.toast.webhookCopied", "Webhook identity copied") });

    const { data: accounts = [], isLoading, error } = useQuery({
        queryKey: ["connection_health", user?.id],
        queryFn: async () => {
            if (!user) return [];

            const { data, error } = await supabase
                .from("social_accounts")
                .select("id, platform, platform_username, avatar_url, token_expires_at, updated_at, connected_at, is_active, needs_reauth, failure_count, last_refresh_error, social_profile_id, platform_user_id, account_metadata")
                .eq("user_id", user.id)
                // Inactive accounts are listed rather than filtered out. This page is
                // where a user comes to fix a broken connection, and an account that is
                // disconnected is exactly the case where its events are being dropped --
                // hiding it left the one actionable row invisible.
                .order("platform", { ascending: true });

            if (error) throw error;
            return (data || []) as SocialAccountHealth[];
        },
        enabled: !!user,
        retry: false,
    });

    const testConnectionMutation = useMutation({
        mutationFn: async (accountId: string) => {
            setTestingAccountId(accountId);
            const { data, error } = await supabase.functions.invoke("check-connection-health", {
                body: { account_id: accountId, action: "test" },
            });
            if (error) throw error;
            return data;
        },
        onSuccess: (data) => {
            toast({
                title: data.success ? t("health.toast.working", "Connection Working") : t("health.toast.issue", "Connection Issue"),
                description: data.message || (data.success ? t("health.toast.healthy", "API connection is healthy") : t("health.toast.unhealthy", "Failed to verify connection")),
                variant: data.success ? "default" : "destructive",
            });
        },
        onError: (error) => {
            toast({
                title: t("health.toast.testFailed", "Test Failed"),
                description: error instanceof Error ? error.message : t("health.toast.testFailedDesc", "Failed to test connection"),
                variant: "destructive",
            });
        },
        onSettled: () => {
            setTestingAccountId(null);
        },
    });

    const refreshTokenMutation = useMutation({
        mutationFn: async (accountId: string) => {
            setRefreshingAccountId(accountId);
            const account = accounts.find(a => a.id === accountId);
            if (!account) throw new Error(t("health.errors.accountNotFound", "Account not found"));

            const { data, error } = await supabase.functions.invoke(`${account.platform}-oauth`, {
                body: { action: "refresh", account_id: accountId },
            });
            if (error) throw error;
            return data;
        },
        onSuccess: () => {
            toast({
                title: t("health.toast.tokenRefreshed", "Token Refreshed"),
                description: t("health.toast.tokenRefreshedDesc", "Access token has been refreshed successfully."),
            });
            queryClient.invalidateQueries({ queryKey: ["connection_health"] });
        },
        onError: (error) => {
            toast({
                title: t("health.toast.refreshFailed", "Refresh Failed"),
                description: error instanceof Error ? error.message : t("health.toast.refreshFailedDesc", "Failed to refresh token"),
                variant: "destructive",
            });
        },
        onSettled: () => {
            setRefreshingAccountId(null);
        },
    });

    const testNotificationMutation = useMutation({
        mutationFn: async () => {
            setIsSendingTestNotification(true);
            const { data, error } = await supabase.functions.invoke("send-token-expiry-notifications");
            if (error) throw error;
            return data;
        },
        onSuccess: (data) => {
            toast({
                title: t("health.toast.notifComplete", "Notification Check Complete"),
                description: data.message || t("health.toast.sentEmails", "Sent {{count}} notification email(s)", { count: data.sent || 0 }),
            });
        },
        onError: (error) => {
            toast({
                title: t("health.toast.notifFailed", "Notification Check Failed"),
                description: error instanceof Error ? error.message : t("health.toast.notifFailedDesc", "Failed to run notification check"),
                variant: "destructive",
            });
        },
        onSettled: () => {
            setIsSendingTestNotification(false);
        },
    });

    // Calculate overall health stats
    const healthStats = accounts.reduce(
        (acc, account) => {
            const { status } = getTokenHealth(account.token_expires_at, account.platform, account.needs_reauth, account.is_active, t);
            acc[status] = (acc[status] || 0) + 1;
            acc.total += 1;
            return acc;
        },
        { healthy: 0, expired: 0, unknown: 0, needs_reauth: 0, disconnected: 0, total: 0 } as Record<string, number>
    );

    const healthPercentage = healthStats.total > 0
        ? Math.round((healthStats.healthy / healthStats.total) * 100)
        : 0;

    return (
        <DashboardLayout>
            <div className="space-y-8">
                {/* Header */}
                <div className="flex items-center justify-between flex-wrap gap-4">
                    <div>
                        <h1 className="text-3xl font-bold flex items-center gap-3">
                            <Activity className="w-8 h-8 text-primary" />
                            {t("health.header.title", "Connection Health")}
                        </h1>
                        <p className="text-muted-foreground mt-1">
                            {t("health.header.subtitle", "Monitor the health and status of your connected social accounts.")}
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="gap-2"
                            onClick={() => testNotificationMutation.mutate()}
                            disabled={isSendingTestNotification}
                        >
                            {isSendingTestNotification ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <Mail className="w-4 h-4" />
                            )}
                            {t("health.actions.testNotifications", "Test Notifications")}
                        </Button>
                        <Link to="/docs/token-expiry">
                            <Button variant="outline" size="sm" className="gap-2">
                                <Info className="w-4 h-4" />
                                {t("health.actions.tokenGuide", "Token Expiry Guide")}
                                <ExternalLink className="w-3 h-3" />
                            </Button>
                        </Link>
                    </div>
                </div>

                {/* Health Overview Cards */}
                <div className="grid md:grid-cols-4 gap-4">
                    <Card>
                        <CardHeader className="pb-2">
                            <CardDescription>{t("health.stats.overall", "Overall Health")}</CardDescription>
                            <CardTitle className="text-3xl">{healthPercentage}%</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <Progress value={healthPercentage} className="h-2" />
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="pb-2">
                            <CardDescription className="flex items-center gap-2">
                                <CheckCircle2 className="w-4 h-4 text-green-500" />
                                {t("health.stats.active", "Active")}
                            </CardDescription>
                            <CardTitle className="text-3xl text-green-500">{healthStats.healthy}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-xs text-muted-foreground">{t("health.stats.tokensValid", "Tokens valid")}</p>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="pb-2">
                            <CardDescription className="flex items-center gap-2">
                                <XCircle className="w-4 h-4 text-destructive" />
                                {t("health.stats.expired", "Expired")}
                            </CardDescription>
                            <CardTitle className="text-3xl text-destructive">{healthStats.expired}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-xs text-muted-foreground">{t("health.stats.tokenExpired", "Token expired")}</p>
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader className="pb-2">
                            <CardDescription className="flex items-center gap-2">
                                <RotateCcw className="w-4 h-4 text-red-600" />
                                {t("health.stats.needsReconnect", "Needs Reconnect")}
                            </CardDescription>
                            <CardTitle className="text-3xl text-red-600">{healthStats.needs_reauth || 0}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <p className="text-xs text-muted-foreground">{t("health.stats.reconnectionRequired", "Reconnection required")}</p>
                        </CardContent>
                    </Card>
                </div>

                {/* Accounts Table */}
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Shield className="w-5 h-5" />
                            {t("health.table.title", "Connected Accounts")}
                        </CardTitle>
                        <CardDescription>
                            {t("health.table.desc", "Check token status and test connections for each platform")}
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {isLoading ? (
                            <div className="flex items-center justify-center py-12">
                                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                            </div>
                        ) : error ? (
                            <div className="text-center py-12 space-y-2">
                                <AlertCircle className="w-10 h-10 text-destructive mx-auto" />
                                <p className="text-sm font-medium text-destructive">
                                    {t("health.errors.loadFailed", "Failed to load connection data")}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                    {error instanceof Error ? error.message : t("health.errors.unexpected", "An unexpected error occurred. Try refreshing the page.")}
                                </p>
                            </div>
                        ) : accounts.length === 0 ? (
                            <div className="text-center py-12 text-muted-foreground">
                                {t("health.empty", "No connected accounts. Go to Profiles to connect your social accounts.")}
                            </div>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>{t("health.table.account", "Account")}</TableHead>
                                        <TableHead>{t("health.table.status", "Status")}</TableHead>
                                        <TableHead>{t("health.table.tokenExpiry", "Token Expiry")}</TableHead>
                                        <TableHead>{t("health.table.webhookIdentity", "Webhook Identity")}</TableHead>
                                        <TableHead>{t("health.table.lastInbound", "Last Inbound Event")}</TableHead>
                                        <TableHead>{t("health.table.lastUpdated", "Last Updated")}</TableHead>
                                        <TableHead className="text-right">{t("health.table.actions", "Actions")}</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {accounts.map((account) => {
                                        const health = getTokenHealth(account.token_expires_at, account.platform, account.needs_reauth, account.is_active, t);
                                        const platformInfo = PLATFORM_TOKEN_INFO[account.platform.toLowerCase()];
                                        const messaging = isMessagingPlatform(account.platform);
                                        const webhookIdentity = messaging ? resolveWebhookIdentity(account) : null;
                                        const activity = inboundActivity?.get(account.id);

                                        return (
                                            <TableRow key={account.id}>
                                                <TableCell>
                                                    <div className="flex items-center gap-3">
                                                        <Avatar className="h-9 w-9">
                                                            {account.avatar_url ? (
                                                                <AvatarImage src={account.avatar_url} alt={account.platform_username || account.platform} />
                                                            ) : null}
                                                            <AvatarFallback>
                                                                <PlatformIcon platform={account.platform as ExtendedPlatform} size="sm" />
                                                            </AvatarFallback>
                                                        </Avatar>
                                                        <div>
                                                            <div className="font-medium">{account.platform_username || t("common:unknown", "Unknown")}</div>
                                                            <div className="text-xs text-muted-foreground flex items-center gap-1">
                                                                <PlatformIcon platform={account.platform as ExtendedPlatform} size="xs" />
                                                                {getPlatformName(account.platform as ExtendedPlatform)}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center gap-2">
                                                        {getStatusIcon(health.status)}
                                                        {getStatusBadge(health.status, t)}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex flex-col">
                                                        <span className={`text-sm ${health.status === "expired" ? "text-destructive" : ""}`}>
                                                            {health.message}
                                                        </span>
                                                        {platformInfo && (
                                                            <Tooltip>
                                                                <TooltipTrigger asChild>
                                                                    <button type="button" className="text-xs text-muted-foreground cursor-help hover:underline bg-transparent border-none p-0">
                                                                        {t("health.table.accessToken", "{{expiry}} access token", { expiry: platformInfo.accessTokenExpiry })}
                                                                    </button>
                                                                </TooltipTrigger>
                                                                <TooltipContent>
                                                                    <p>{t("health.table.access", "Access: {{expiry}}", { expiry: platformInfo.accessTokenExpiry })}</p>
                                                                    <p>{t("health.table.refresh", "Refresh: {{expiry}}", { expiry: platformInfo.refreshTokenExpiry })}</p>
                                                                </TooltipContent>
                                                            </Tooltip>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    {webhookIdentity ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => copy(webhookIdentity, account.id)}
                                                            className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
                                                            title={t("health.table.copyTitle", "Copy the id this platform uses to address your account")}
                                                        >
                                                            {copiedId === account.id ? t("common:copied", "Copied") : webhookIdentity}
                                                        </button>
                                                    ) : (
                                                        <span className="text-xs text-muted-foreground">&mdash;</span>
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    {!messaging ? (
                                                        <span className="text-xs text-muted-foreground">&mdash;</span>
                                                    ) : activity ? (
                                                        <span className="text-sm text-muted-foreground">
                                                            {new Date(activity.last_event_at).toLocaleString()}
                                                        </span>
                                                    ) : (
                                                        // The headline diagnostic. An account that has never received
                                                        // an inbound event is either not subscribed on the platform
                                                        // side or is not the account being messaged at all.
                                                        <span className="text-sm text-amber-600 dark:text-amber-500">
                                                            {t("health.table.neverInbound", "Never received an inbound event")}
                                                        </span>
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    <span className="text-sm text-muted-foreground">
                                                        {new Date(account.updated_at).toLocaleDateString()}
                                                    </span>
                                                </TableCell>
                                                <TableCell className="text-right">
                                                    <div className="flex items-center justify-end gap-2">
                                                        <Button
                                                            variant="outline"
                                                            size="sm"
                                                            onClick={() => testConnectionMutation.mutate(account.id)}
                                                            disabled={testingAccountId === account.id}
                                                        >
                                                            {testingAccountId === account.id ? (
                                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                            ) : (
                                                                <Zap className="w-4 h-4" />
                                                            )}
                                                            <span className="ml-1.5 hidden sm:inline">{t("health.actions.test", "Test")}</span>
                                                        </Button>
                                                        {health.status === "expired" || health.status === "needs_reauth" ? (
                                                            <Button
                                                                variant="default"
                                                                size="sm"
                                                                onClick={() => handleConnectPlatform(account.social_profile_id || "", account.platform)}
                                                                disabled={connectingPlatform === account.platform}
                                                                className="bg-destructive hover:bg-destructive/90"
                                                            >
                                                                {connectingPlatform === account.platform ? (
                                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                                ) : (
                                                                    <RotateCcw className="w-4 h-4" />
                                                                )}
                                                                <span className="ml-1.5 hidden sm:inline">{t("health.actions.reconnect", "Reconnect")}</span>
                                                            </Button>
                                                        ) : (
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                onClick={() => refreshTokenMutation.mutate(account.id)}
                                                                disabled={refreshingAccountId === account.id}
                                                            >
                                                                {refreshingAccountId === account.id ? (
                                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                                ) : (
                                                                    <RefreshCw className="w-4 h-4" />
                                                                )}
                                                                <span className="ml-1.5 hidden sm:inline">{t("common:refresh", "Refresh")}</span>
                                                            </Button>
                                                        )}
                                                    </div>
                                                </TableCell>
                                            </TableRow>
                                        );
                                    })}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>
            </div>
        </DashboardLayout>
    );
}
