import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, BarChart3, TrendingUp, Sparkles, Hash, DollarSign, Settings, ChevronDown } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, LineChart, Line, AreaChart, Area } from "recharts";
import { format, subDays, startOfMonth, eachDayOfInterval } from "date-fns";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface UsageData {
  date: string;
  displayDate: string;
  captions: number;
  hashtags: number;
  total: number;
}

// Default token estimates per request (can be customized)
const DEFAULT_TOKENS_PER_CAPTION = 500;
const DEFAULT_TOKENS_PER_HASHTAG = 300;

interface DbModel {
  model_id: string;
  name: string;
  cost_per_1m_input_tokens: number | null;
  cost_per_1m_output_tokens: number | null;
  ai_providers: { provider_code: string; name: string } | null;
}

export function AiUsageAnalytics() {
  const [tokensPerCaption, setTokensPerCaption] = useState(DEFAULT_TOKENS_PER_CAPTION);
  const [tokensPerHashtag, setTokensPerHashtag] = useState(DEFAULT_TOKENS_PER_HASHTAG);
  const [showCostSettings, setShowCostSettings] = useState(false);
  const [selectedComparisonModel, setSelectedComparisonModel] = useState<string | null>(null);

  // Fetch AI models with pricing from database
  const { data: dbModels = [] } = useQuery({
    queryKey: ["ai-models-pricing"],
    queryFn: async (): Promise<DbModel[]> => {
      const { data, error } = await supabase
        .from("ai_models")
        .select("model_id, name, cost_per_1m_input_tokens, cost_per_1m_output_tokens, ai_providers:provider_id (provider_code, name)")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return (data || []) as unknown as DbModel[];
    },
    staleTime: 5 * 60 * 1000,
  });

  // Build pricing lookup from DB: average of input + output cost per 1K tokens
  const modelPricingMap: Record<string, { name: string; pricePerK: number }> = {};
  dbModels.forEach((m) => {
    const inputCost = Number(m.cost_per_1m_input_tokens) || 0;
    const outputCost = Number(m.cost_per_1m_output_tokens) || 0;
    const avgPerMillion = (inputCost + outputCost) / 2;
    const pricePerK = avgPerMillion / 1000; // convert per-1M to per-1K
    const key = m.ai_providers ? `${m.ai_providers.provider_code}/${m.model_id}` : m.model_id;
    modelPricingMap[key] = { name: m.name, pricePerK };
    // Also store by raw model_id for fallback
    modelPricingMap[m.model_id] = { name: m.name, pricePerK };
  });
  const defaultPricePerK = 0.001;

  // Fetch AI usage from system_logs (category = 'ai') for real token data
  const { data: aiLogs = [] } = useQuery({
    queryKey: ["ai-usage-system-logs"],
    queryFn: async () => {
      const thirtyDaysAgo = subDays(new Date(), 30).toISOString();
      const { data, error } = await supabase
        .from("system_logs")
        .select("created_at, message, metadata, category")
        .eq("category", "ai")
        .gte("created_at", thirtyDaysAgo)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    staleTime: 60 * 1000,
  });

  // Fetch current AI model setting
  const { data: aiModelSetting } = useQuery({
    queryKey: ["admin-ai-model-for-analytics"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("value")
        .eq("key", "ai_model")
        .maybeSingle();
      if (error) throw error;
      try {
        return typeof data?.value === "string" ? JSON.parse(data.value) : data?.value;
      } catch {
        return "google/gemini-2.5-flash";
      }
    },
  });

  const currentModel = aiModelSetting || "google/gemini-2.5-flash";
  const pricePerK = modelPricingMap[currentModel]?.pricePerK || defaultPricePerK;
  const comparisonModel = selectedComparisonModel;
  const comparisonPricePerK = comparisonModel ? (modelPricingMap[comparisonModel]?.pricePerK || defaultPricePerK) : null;

  // Fetch daily usage for the last 30 days
  const { data: dailyUsage, isLoading: isLoadingDaily } = useQuery({
    queryKey: ["ai-usage-daily"],
    queryFn: async () => {
      const thirtyDaysAgo = subDays(new Date(), 30).toISOString();
      const { data, error } = await supabase
        .from("api_logs")
        .select("endpoint, created_at")
        .in("endpoint", ["generate-caption", "generate-hashtags"])
        .gte("created_at", thirtyDaysAgo)
        .order("created_at", { ascending: true });
      if (error) throw error;

      const grouped: Record<string, { captions: number; hashtags: number }> = {};
      const days = eachDayOfInterval({ start: subDays(new Date(), 29), end: new Date() });
      days.forEach((day) => {
        grouped[format(day, "yyyy-MM-dd")] = { captions: 0, hashtags: 0 };
      });
      (data || []).forEach((log) => {
        const dateStr = format(new Date(log.created_at), "yyyy-MM-dd");
        if (grouped[dateStr]) {
          if (log.endpoint === "generate-caption") grouped[dateStr].captions++;
          else if (log.endpoint === "generate-hashtags") grouped[dateStr].hashtags++;
        }
      });
      return Object.entries(grouped).map(([date, counts]) => ({
        date,
        displayDate: format(new Date(date), "MMM d"),
        captions: counts.captions,
        hashtags: counts.hashtags,
        total: counts.captions + counts.hashtags,
      }));
    },
    staleTime: 60 * 1000,
  });

  // Fetch monthly usage for the last 6 months
  const { data: monthlyUsage, isLoading: isLoadingMonthly } = useQuery({
    queryKey: ["ai-usage-monthly"],
    queryFn: async () => {
      const sixMonthsAgo = startOfMonth(subDays(new Date(), 180)).toISOString();
      const { data, error } = await supabase
        .from("api_logs")
        .select("endpoint, created_at")
        .in("endpoint", ["generate-caption", "generate-hashtags"])
        .gte("created_at", sixMonthsAgo)
        .order("created_at", { ascending: true });
      if (error) throw error;

      const grouped: Record<string, { captions: number; hashtags: number }> = {};
      (data || []).forEach((log) => {
        const monthStr = format(new Date(log.created_at), "yyyy-MM");
        if (!grouped[monthStr]) grouped[monthStr] = { captions: 0, hashtags: 0 };
        if (log.endpoint === "generate-caption") grouped[monthStr].captions++;
        else if (log.endpoint === "generate-hashtags") grouped[monthStr].hashtags++;
      });
      return Object.entries(grouped)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, counts]) => ({
          month,
          displayMonth: format(new Date(month + "-01"), "MMM yyyy"),
          captions: counts.captions,
          hashtags: counts.hashtags,
          total: counts.captions + counts.hashtags,
        }));
    },
    staleTime: 60 * 1000,
  });

  // Calculate totals
  const totalCaptions = (dailyUsage || []).reduce((sum, d) => sum + d.captions, 0);
  const totalHashtags = (dailyUsage || []).reduce((sum, d) => sum + d.hashtags, 0);
  const todayData = dailyUsage?.find((d) => d.date === format(new Date(), "yyyy-MM-dd"));

  // Calculate cost estimation
  const estimatedTokens30Days = (totalCaptions * tokensPerCaption) + (totalHashtags * tokensPerHashtag);
  const estimatedCost30Days = (estimatedTokens30Days / 1000) * pricePerK;

  const todayCaptions = todayData?.captions || 0;
  const todayHashtags = todayData?.hashtags || 0;
  const estimatedTokensToday = (todayCaptions * tokensPerCaption) + (todayHashtags * tokensPerHashtag);
  const estimatedCostToday = (estimatedTokensToday / 1000) * pricePerK;

  const currentMonthData = monthlyUsage?.find(m => m.month === format(new Date(), "yyyy-MM"));
  const monthCaptions = currentMonthData?.captions || 0;
  const monthHashtags = currentMonthData?.hashtags || 0;
  const estimatedTokensMonth = (monthCaptions * tokensPerCaption) + (monthHashtags * tokensPerHashtag);
  const estimatedCostMonth = (estimatedTokensMonth / 1000) * pricePerK;

  // Get comparable models for dropdown (only those with non-zero pricing)
  const comparableModels = Object.entries(modelPricingMap)
    .filter(([key, val]) => key.includes("/") && val.pricePerK > 0 && key !== currentModel)
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  const isLoading = isLoadingDaily || isLoadingMonthly;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <BarChart3 className="w-5 h-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-lg">AI Usage Analytics</CardTitle>
            <CardDescription>
              Track caption and hashtag generation usage — pricing from database
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-4 rounded-lg border bg-card">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Sparkles className="w-4 h-4" />
                  <span className="text-xs font-medium">Today</span>
                </div>
                <p className="text-2xl font-bold">{todayData?.total || 0}</p>
                <p className="text-xs text-muted-foreground">generations</p>
              </div>
              <div className="p-4 rounded-lg border bg-card">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <TrendingUp className="w-4 h-4" />
                  <span className="text-xs font-medium">Last 30 Days</span>
                </div>
                <p className="text-2xl font-bold">{totalCaptions + totalHashtags}</p>
                <p className="text-xs text-muted-foreground">total generations</p>
              </div>
              <div className="p-4 rounded-lg border bg-card">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Sparkles className="w-4 h-4" />
                  <span className="text-xs font-medium">Captions</span>
                </div>
                <p className="text-2xl font-bold">{totalCaptions}</p>
                <p className="text-xs text-muted-foreground">last 30 days</p>
              </div>
              <div className="p-4 rounded-lg border bg-card">
                <div className="flex items-center gap-2 text-muted-foreground mb-1">
                  <Hash className="w-4 h-4" />
                  <span className="text-xs font-medium">Hashtags</span>
                </div>
                <p className="text-2xl font-bold">{totalHashtags}</p>
                <p className="text-xs text-muted-foreground">last 30 days</p>
              </div>
            </div>

            {/* Cost Estimation Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <DollarSign className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Estimated Costs</span>
                </div>
                <button
                  onClick={() => setShowCostSettings(!showCostSettings)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Settings className="w-3 h-3" />
                  Settings
                </button>
              </div>

              {showCostSettings && (
                <div className="p-3 rounded-lg border bg-muted/50 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Adjust token estimates to improve cost accuracy:
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <Label className="text-xs">Tokens per caption</Label>
                      <Input
                        type="number"
                        value={tokensPerCaption}
                        onChange={(e) => setTokensPerCaption(Number(e.target.value) || DEFAULT_TOKENS_PER_CAPTION)}
                        className="h-8"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Tokens per hashtag</Label>
                      <Input
                        type="number"
                        value={tokensPerHashtag}
                        onChange={(e) => setTokensPerHashtag(Number(e.target.value) || DEFAULT_TOKENS_PER_HASHTAG)}
                        className="h-8"
                      />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Current model: <span className="font-mono">{currentModel}</span> @ ${pricePerK.toFixed(4)}/1K tokens
                  </p>
                </div>
              )}

              <div className="grid grid-cols-3 gap-4">
                <div className="p-4 rounded-lg border bg-gradient-to-br from-green-500/10 to-emerald-500/10 border-green-500/20">
                  <div className="flex items-center gap-2 text-green-600 dark:text-green-400 mb-1">
                    <DollarSign className="w-4 h-4" />
                    <span className="text-xs font-medium">Today</span>
                  </div>
                  <p className="text-xl font-bold text-green-700 dark:text-green-300">
                    ${estimatedCostToday.toFixed(4)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    ~{estimatedTokensToday.toLocaleString()} tokens
                  </p>
                </div>
                <div className="p-4 rounded-lg border bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border-blue-500/20">
                  <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400 mb-1">
                    <DollarSign className="w-4 h-4" />
                    <span className="text-xs font-medium">This Month</span>
                  </div>
                  <p className="text-xl font-bold text-blue-700 dark:text-blue-300">
                    ${estimatedCostMonth.toFixed(4)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    ~{estimatedTokensMonth.toLocaleString()} tokens
                  </p>
                </div>
                <div className="p-4 rounded-lg border bg-gradient-to-br from-purple-500/10 to-pink-500/10 border-purple-500/20">
                  <div className="flex items-center gap-2 text-purple-600 dark:text-purple-400 mb-1">
                    <DollarSign className="w-4 h-4" />
                    <span className="text-xs font-medium">Last 30 Days</span>
                  </div>
                  <p className="text-xl font-bold text-purple-700 dark:text-purple-300">
                    ${estimatedCost30Days.toFixed(4)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    ~{estimatedTokens30Days.toLocaleString()} tokens
                  </p>
                </div>
              </div>
            </div>

            {/* Charts */}
            <Tabs defaultValue="daily" className="w-full">
              <TabsList>
                <TabsTrigger value="daily">Daily (30 days)</TabsTrigger>
                <TabsTrigger value="monthly">Monthly</TabsTrigger>
                <TabsTrigger value="cost-trends">Cost Trends</TabsTrigger>
              </TabsList>

              <TabsContent value="daily" className="mt-4">
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={dailyUsage} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="displayDate" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }} labelStyle={{ color: "hsl(var(--foreground))" }} />
                      <Legend />
                      <Bar dataKey="captions" name="Captions" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="hashtags" name="Hashtags" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </TabsContent>

              <TabsContent value="monthly" className="mt-4">
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={monthlyUsage} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="displayMonth" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }} labelStyle={{ color: "hsl(var(--foreground))" }} />
                      <Legend />
                      <Line type="monotone" dataKey="captions" name="Captions" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ fill: "hsl(var(--primary))" }} />
                      <Line type="monotone" dataKey="hashtags" name="Hashtags" stroke="hsl(var(--accent))" strokeWidth={2} dot={{ fill: "hsl(var(--accent))" }} />
                      <Line type="monotone" dataKey="total" name="Total" stroke="hsl(var(--muted-foreground))" strokeWidth={2} strokeDasharray="5 5" dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </TabsContent>

              <TabsContent value="cost-trends" className="mt-4 space-y-4">
                {/* Model Comparison Dropdown */}
                <div className="flex items-center gap-4 p-3 rounded-lg border bg-muted/50">
                  <div className="flex-1 space-y-1">
                    <Label className="text-xs text-muted-foreground">Compare with another model</Label>
                    <Select
                      value={selectedComparisonModel || "none"}
                      onValueChange={(v) => setSelectedComparisonModel(v === "none" ? null : v)}
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue placeholder="Select model to compare..." />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No comparison</SelectItem>
                        {comparableModels.map(([key, val]) => (
                          <SelectItem key={key} value={key}>
                            {val.name} (${val.pricePerK.toFixed(4)}/1K)
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-muted-foreground">Current model</p>
                    <p className="text-sm font-medium">
                      {modelPricingMap[currentModel]?.name || currentModel}
                    </p>
                    <p className="text-xs text-muted-foreground">${pricePerK.toFixed(4)}/1K tokens</p>
                  </div>
                </div>

                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={(dailyUsage || []).map((d) => {
                        const tokens = ((d.captions * tokensPerCaption) + (d.hashtags * tokensPerHashtag)) / 1000;
                        return {
                          ...d,
                          cost: tokens * pricePerK,
                          comparisonCost: comparisonPricePerK ? tokens * comparisonPricePerK : undefined,
                        };
                      })}
                      margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                    >
                      <defs>
                        <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="hsl(142, 76%, 36%)" stopOpacity={0}/>
                        </linearGradient>
                        <linearGradient id="comparisonGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="hsl(217, 91%, 60%)" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="displayDate" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(value) => `$${value.toFixed(4)}`} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
                        labelStyle={{ color: "hsl(var(--foreground))" }}
                        formatter={(value: number, name: string) => [
                          `$${value.toFixed(6)}`,
                          name === "comparisonCost"
                            ? (modelPricingMap[comparisonModel || ""]?.name || "Comparison")
                            : (modelPricingMap[currentModel]?.name || "Current")
                        ]}
                      />
                      <Legend />
                      <Area type="monotone" dataKey="cost" name={modelPricingMap[currentModel]?.name || "Current Model"} stroke="hsl(142, 76%, 36%)" strokeWidth={2} fill="url(#costGradient)" />
                      {comparisonModel && (
                        <Area type="monotone" dataKey="comparisonCost" name={modelPricingMap[comparisonModel]?.name || "Comparison"} stroke="hsl(217, 91%, 60%)" strokeWidth={2} fill="url(#comparisonGradient)" />
                      )}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                {/* Cost Savings Summary */}
                {comparisonModel && (
                  <div className="p-4 rounded-lg border bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-blue-500/20">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-medium">Cost Comparison (30 days)</p>
                        <p className="text-xs text-muted-foreground">
                          {modelPricingMap[currentModel]?.name} vs {modelPricingMap[comparisonModel]?.name}
                        </p>
                      </div>
                      <div className="text-right">
                        {(() => {
                          const currentTotal = estimatedCost30Days;
                          const comparisonTotal = (estimatedTokens30Days / 1000) * (comparisonPricePerK || 0);
                          const diff = comparisonTotal - currentTotal;
                          const pctDiff = currentTotal > 0 ? (diff / currentTotal) * 100 : 0;
                          return (
                            <>
                              <p className={`text-lg font-bold ${diff > 0 ? "text-green-600" : diff < 0 ? "text-red-600" : ""}`}>
                                {diff > 0 ? "Save" : diff < 0 ? "Spend" : ""} ${Math.abs(diff).toFixed(4)}
                              </p>
                              <p className={`text-xs ${diff > 0 ? "text-green-500" : diff < 0 ? "text-red-500" : "text-muted-foreground"}`}>
                                {diff > 0 ? `${pctDiff.toFixed(1)}% less with current` : diff < 0 ? `${Math.abs(pctDiff).toFixed(1)}% more with current` : "Same cost"}
                              </p>
                            </>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                )}

                {/* Weekly Summary */}
                <div className="mt-4 grid grid-cols-4 gap-3">
                  {(() => {
                    const weeks = [
                      { label: "This Week", days: 7 },
                      { label: "Last Week", days: 14, offset: 7 },
                      { label: "2 Weeks Ago", days: 21, offset: 14 },
                      { label: "3 Weeks Ago", days: 28, offset: 21 },
                    ];
                    return weeks.map((week, idx) => {
                      const startIdx = week.offset || 0;
                      const endIdx = week.days;
                      const weekData = (dailyUsage || []).slice(
                        Math.max(0, (dailyUsage?.length || 0) - endIdx),
                        (dailyUsage?.length || 0) - startIdx
                      );
                      const weekCaptions = weekData.reduce((sum, d) => sum + d.captions, 0);
                      const weekHashtags = weekData.reduce((sum, d) => sum + d.hashtags, 0);
                      const weekCost = ((weekCaptions * tokensPerCaption) + (weekHashtags * tokensPerHashtag)) / 1000 * pricePerK;
                      const prevWeekData = idx < 3 ? (dailyUsage || []).slice(
                        Math.max(0, (dailyUsage?.length || 0) - weeks[idx + 1].days),
                        (dailyUsage?.length || 0) - (weeks[idx + 1].offset || 0)
                      ) : [];
                      const prevWeekCaptions = prevWeekData.reduce((sum, d) => sum + d.captions, 0);
                      const prevWeekHashtags = prevWeekData.reduce((sum, d) => sum + d.hashtags, 0);
                      const prevWeekCost = ((prevWeekCaptions * tokensPerCaption) + (prevWeekHashtags * tokensPerHashtag)) / 1000 * pricePerK;
                      const change = prevWeekCost > 0 ? ((weekCost - prevWeekCost) / prevWeekCost) * 100 : 0;
                      return (
                        <div key={week.label} className="p-3 rounded-lg border bg-card">
                          <p className="text-xs text-muted-foreground mb-1">{week.label}</p>
                          <p className="text-lg font-bold">${weekCost.toFixed(4)}</p>
                          {idx < 3 && prevWeekCost > 0 && (
                            <p className={`text-xs ${change > 0 ? "text-red-500" : change < 0 ? "text-green-500" : "text-muted-foreground"}`}>
                              {change > 0 ? "↑" : change < 0 ? "↓" : "→"} {Math.abs(change).toFixed(1)}%
                            </p>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  );
}
