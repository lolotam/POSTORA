import { useState, useEffect, useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { ExtendedPlatform } from "@/components/PlatformIcon";
import { toast } from "sonner";
import {
  Account, ApiResponse, RequestHistoryItem, SelectedPlatformAccount,
  API_BASE, HISTORY_STORAGE_KEY, MAX_HISTORY_ITEMS,
} from "./types";

export function usePlaygroundState() {
  const { user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Core state
  const [apiKey, setApiKey] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<ExtendedPlatform[]>(["instagram"]);
  const [selectedAccounts, setSelectedAccounts] = useState<SelectedPlatformAccount[]>([]);
  const [operation, setOperation] = useState("upload_photos");
  const [caption, setCaption] = useState("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [scheduledDate, setScheduledDate] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [firstComment, setFirstComment] = useState("");

  // Platform-specific settings
  const [instagramShareToFeed, setInstagramShareToFeed] = useState(true);
  const [tiktokPrivacy, setTiktokPrivacy] = useState("PUBLIC_TO_EVERYONE");
  const [youtubePrivacy, setYoutubePrivacy] = useState("public");
  const [youtubeCategoryId, setYoutubeCategoryId] = useState("22");
  const [twitterReplySettings, setTwitterReplySettings] = useState("everyone");
  const [linkedinVisibility, setLinkedinVisibility] = useState("PUBLIC");
  const [pinterestBoardId, setPinterestBoardId] = useState("");
  const [pinterestLink, setPinterestLink] = useState("");

  // Webhook settings
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [isTestingWebhook, setIsTestingWebhook] = useState(false);
  const [webhookTestResult, setWebhookTestResult] = useState<any>(null);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isFetchingAccounts, setIsFetchingAccounts] = useState(false);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [requestBody, setRequestBody] = useState("");
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [requestHistory, setRequestHistory] = useState<RequestHistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [activeTab, setActiveTab] = useState<"post" | "webhook">("post");

  // Load history from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        setRequestHistory(parsed.map((item: any) => ({
          ...item,
          timestamp: new Date(item.timestamp),
        })));
      }
    } catch (e) {
      console.error("Failed to load request history:", e);
    }
  }, []);

  // Save to history
  const saveToHistory = (request: any, response: ApiResponse) => {
    const newItem: RequestHistoryItem = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      request: {
        operation: request.operation,
        platforms: request.platforms,
        user_identifier: request.user_identifier,
        account_ids: request.account_ids,
        caption: request.caption,
        media_urls: request.media_urls,
      },
      response,
    };

    setRequestHistory(prev => {
      const updated = [newItem, ...prev].slice(0, MAX_HISTORY_ITEMS);
      try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(updated));
      } catch (e) {
        console.error("Failed to save request history:", e);
      }
      return updated;
    });
  };

  const clearHistory = () => {
    setRequestHistory([]);
    localStorage.removeItem(HISTORY_STORAGE_KEY);
    toast.success("Request history cleared");
  };

  const exportHistory = () => {
    const data = JSON.stringify(requestHistory, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `api-playground-history-${new Date().toISOString().split("T")[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success("History exported successfully");
  };

  const importHistory = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const imported = JSON.parse(e.target?.result as string);
        if (!Array.isArray(imported)) throw new Error("Invalid format");

        const validItems = imported
          .filter((item: any) => item.id && item.request && item.response)
          .map((item: any) => ({ ...item, timestamp: new Date(item.timestamp) }))
          .slice(0, MAX_HISTORY_ITEMS);

        setRequestHistory(validItems);
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(validItems));
        toast.success(`Imported ${validItems.length} history items`);
      } catch {
        toast.error("Failed to import history: Invalid file format");
      }
    };
    reader.readAsText(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const loadFromHistory = (item: RequestHistoryItem) => {
    setOperation(item.request.operation);
    if (item.request.platforms.length > 0) {
      setSelectedPlatforms(item.request.platforms as ExtendedPlatform[]);
    }
    if (item.request.account_ids && item.request.account_ids.length > 0) {
      const restoredAccounts: SelectedPlatformAccount[] = [];
      item.request.account_ids.forEach((id, index) => {
        const platform = item.request.platforms[index] as ExtendedPlatform;
        const account = accounts.find(a => a.id === id || a.platform_user_id === id);
        if (account) {
          restoredAccounts.push({ platform, accountId: account.id, accountUsername: account.platform_username });
        }
      });
      if (restoredAccounts.length > 0) setSelectedAccounts(restoredAccounts);
    }
    setCaption(item.request.caption || "");
    setMediaUrl(item.request.media_urls || "");
    setResponse(item.response);
    setShowHistory(false);
    toast.success("Request loaded from history");
  };

  // Build request body
  useEffect(() => {
    const body: Record<string, any> = { operation, platforms: selectedPlatforms };
    const accountIds = selectedAccounts.map(sa => sa.accountId);
    if (accountIds.length > 0) body.account_ids = accountIds;
    if (caption) body.caption = caption;
    if (mediaUrl) body.media_urls = mediaUrl;
    if (scheduledDate) body.scheduled_date = scheduledDate;
    if (timezone && scheduledDate) body.timezone = timezone;
    if (firstComment) body.first_comment = firstComment;
    if (webhookUrl) {
      body.webhook_url = webhookUrl;
      if (webhookSecret) body.webhook_secret = webhookSecret;
    }
    if (selectedPlatforms.includes("instagram")) body.instagram_share_to_feed = instagramShareToFeed;
    if (selectedPlatforms.includes("tiktok")) body.tiktok_privacy_level = tiktokPrivacy;
    if (selectedPlatforms.includes("youtube")) {
      body.youtube_privacy_status = youtubePrivacy;
      body.youtube_category_id = youtubeCategoryId;
    }
    if (selectedPlatforms.includes("twitter")) body.twitter_reply_settings = twitterReplySettings;
    if (selectedPlatforms.includes("linkedin")) body.linkedin_visibility = linkedinVisibility;
    if (selectedPlatforms.includes("pinterest")) {
      if (pinterestBoardId) body.pinterest_board_id = pinterestBoardId;
      if (pinterestLink) body.pinterest_link = pinterestLink;
    }
    setRequestBody(JSON.stringify(body, null, 2));
  }, [
    operation, selectedPlatforms, selectedAccounts, caption, mediaUrl,
    scheduledDate, timezone, firstComment, instagramShareToFeed,
    tiktokPrivacy, youtubePrivacy, youtubeCategoryId, twitterReplySettings,
    linkedinVisibility, pinterestBoardId, pinterestLink, webhookUrl, webhookSecret,
  ]);

  // Fetch accounts
  const fetchAccounts = async () => {
    if (!apiKey) { toast.error("Please enter your API key first"); return; }
    setIsFetchingAccounts(true);
    try {
      const res = await fetch(`${API_BASE}/api/v1/accounts`, { headers: { "x-api-key": apiKey } });
      const data = await res.json();
      if (data.success && data.accounts) {
        setAccounts(data.accounts);
        toast.success(`Found ${data.accounts.length} connected accounts`);
      } else {
        toast.error(data.error || "Failed to fetch accounts");
      }
    } catch {
      toast.error("Failed to fetch accounts");
    } finally {
      setIsFetchingAccounts(false);
    }
  };

  // Load API key from profile
  useEffect(() => {
    const loadApiKey = async () => {
      if (!user) return;
      const { data } = await supabase.from("profiles").select("api_key").eq("id", user.id).single();
      if (data?.api_key) setApiKey(data.api_key);
    };
    loadApiKey();
  }, [user]);

  const copyCode = async (code: string, id: string) => {
    await navigator.clipboard.writeText(code);
    setCopiedCode(id);
    setTimeout(() => setCopiedCode(null), 2000);
    toast.success("Copied to clipboard");
  };

  const generateCurl = () => {
    return `curl -X POST "${API_BASE}/api/v1/post" \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${apiKey || "YOUR_API_KEY"}" \\
  -d '${requestBody.replace(/'/g, "'\\''")}'`;
  };

  // Send request
  const sendRequest = async () => {
    if (!apiKey) { toast.error("Please enter your API key"); return; }
    setIsLoading(true);
    setResponse(null);
    const startTime = Date.now();
    try {
      const res = await fetch(`${API_BASE}/api/v1/post`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: requestBody,
      });
      const data = await res.json();
      const duration = Date.now() - startTime;
      const apiResponse: ApiResponse = { ...data, status: res.status, duration };
      setResponse(apiResponse);
      try { saveToHistory(JSON.parse(requestBody), apiResponse); } catch { /* history is best effort; a non-JSON body is not saved */ }
      if (data.success) toast.success("Request successful!");
      else toast.error(data.error || "Request failed");
    } catch (error: any) {
      const duration = Date.now() - startTime;
      const errorResponse: ApiResponse = { success: false, error: error.message, status: 0, duration };
      setResponse(errorResponse);
      try { saveToHistory(JSON.parse(requestBody), errorResponse); } catch { /* history is best effort; a non-JSON body is not saved */ }
      toast.error("Request failed: " + error.message);
    } finally {
      setIsLoading(false);
    }
  };

  // Test webhook
  const testWebhook = async () => {
    if (!apiKey) { toast.error("Please enter your API key first"); return; }
    if (!webhookUrl) { toast.error("Please enter a webhook URL to test"); return; }
    setIsTestingWebhook(true);
    setWebhookTestResult(null);
    try {
      const res = await fetch(`${API_BASE}/api/v1/webhooks/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ webhook_url: webhookUrl }),
      });
      const data = await res.json();
      setWebhookTestResult(data);
      if (data.success) toast.success("Webhook test successful!");
      else toast.error(data.error || "Webhook test failed");
    } catch (error: any) {
      setWebhookTestResult({ success: false, error: error.message });
      toast.error("Webhook test failed: " + error.message);
    } finally {
      setIsTestingWebhook(false);
    }
  };

  // Platform/account toggling
  const togglePlatform = (platform: ExtendedPlatform) => {
    setSelectedPlatforms(prev => {
      if (prev.includes(platform)) {
        setSelectedAccounts(sa => sa.filter(a => a.platform !== platform));
        return prev.filter(p => p !== platform);
      }
      return [...prev, platform];
    });
  };

  const toggleAccountForPlatform = (platform: ExtendedPlatform, account: Account) => {
    setSelectedAccounts(prev => {
      const existing = prev.find(sa => sa.platform === platform && sa.accountId === account.id);
      if (existing) return prev.filter(sa => !(sa.platform === platform && sa.accountId === account.id));
      return [...prev, { platform, accountId: account.id, accountUsername: account.platform_username }];
    });
  };

  const getAccountsForPlatform = (platform: ExtendedPlatform) => accounts.filter(a => a.platform === platform);
  const isAccountSelected = (platform: ExtendedPlatform, accountId: string) =>
    selectedAccounts.some(sa => sa.platform === platform && sa.accountId === accountId);

  return {
    user, fileInputRef,
    apiKey, setApiKey, accounts, fetchAccounts, isFetchingAccounts,
    selectedPlatforms, togglePlatform,
    selectedAccounts, toggleAccountForPlatform, getAccountsForPlatform, isAccountSelected,
    operation, setOperation, caption, setCaption, mediaUrl, setMediaUrl,
    scheduledDate, setScheduledDate, timezone, setTimezone, firstComment, setFirstComment,
    instagramShareToFeed, setInstagramShareToFeed,
    tiktokPrivacy, setTiktokPrivacy,
    youtubePrivacy, setYoutubePrivacy, youtubeCategoryId, setYoutubeCategoryId,
    twitterReplySettings, setTwitterReplySettings,
    linkedinVisibility, setLinkedinVisibility,
    pinterestBoardId, setPinterestBoardId, pinterestLink, setPinterestLink,
    webhookUrl, setWebhookUrl, webhookSecret, setWebhookSecret,
    isTestingWebhook, webhookTestResult, testWebhook,
    isLoading, response, requestBody, copiedCode, copyCode, generateCurl, sendRequest,
    showAdvanced, setShowAdvanced,
    requestHistory, showHistory, setShowHistory,
    clearHistory, exportHistory, importHistory, loadFromHistory,
    activeTab, setActiveTab,
  };
}
