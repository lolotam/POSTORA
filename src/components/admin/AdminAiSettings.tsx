import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Loader2, Save, Search, RefreshCw, ExternalLink, CheckCircle, XCircle, AlertCircle, Play, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { ScrollArea } from "@/components/ui/scroll-area";

interface OpenRouterModel {
  id: string;
  name: string;
  description: string;
  context_length?: number;
  pricing?: {
    prompt: string;
    completion: string;
  };
}

// Google AI Studio models
const GOOGLE_MODELS = [
  // Gemini 3.1 Series
  { id: "google/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", description: "Latest next-gen reasoning with advanced agentic capabilities" },
  // Gemini 3 Series
  { id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro Preview", description: "Next-generation advanced reasoning model" },
  { id: "google/gemini-3-flash-preview", name: "Gemini 3 Flash Preview", description: "Fast preview of next-generation model" },
  // Gemini 3.x Flash (2.5 text models are retired for new Google projects)
  { id: "google/gemini-3.5-flash", name: "Gemini 3.5 Flash", description: "Balanced speed, quality, and cost" },
  { id: "google/gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite", description: "Fastest & cheapest, good for simple tasks" },
  // Gemini 2.0 Series
  { id: "google/gemini-2.0-flash", name: "Gemini 2.0 Flash", description: "Previous-gen fast model, stable" },
  { id: "google/gemini-2.0-flash-lite", name: "Gemini 2.0 Flash Lite", description: "Previous-gen lightweight model" },
  // Gemini 1.5 Series (legacy, still available)
  { id: "google/gemini-1.5-pro", name: "Gemini 1.5 Pro", description: "Legacy pro model with 2M token context" },
  { id: "google/gemini-1.5-flash", name: "Gemini 1.5 Flash", description: "Legacy fast model, stable and reliable" },
  { id: "google/gemini-1.5-flash-8b", name: "Gemini 1.5 Flash 8B", description: "Legacy compact model, lowest cost" },
];

type AIProvider = "google" | "openrouter" | "chatgpt" | "claude";
type ApiKeyStatus = "idle" | "validating" | "valid" | "invalid" | "error";

// Format pricing to show cost per 1K tokens
function formatPricing(pricing?: { prompt: string; completion: string }): string {
  if (!pricing) return "";
  
  const promptCost = parseFloat(pricing.prompt);
  const completionCost = parseFloat(pricing.completion);
  
  if (isNaN(promptCost) || isNaN(completionCost)) return "";
  
  // Convert to cost per 1K tokens (pricing is per token)
  const promptPer1K = promptCost * 1000;
  const completionPer1K = completionCost * 1000;
  
  if (promptPer1K === 0 && completionPer1K === 0) {
    return "Free";
  }
  
  // Format nicely
  const formatCost = (cost: number) => {
    if (cost < 0.001) return cost.toExponential(1);
    if (cost < 0.01) return cost.toFixed(4);
    if (cost < 1) return cost.toFixed(3);
    return cost.toFixed(2);
  };
  
  return `$${formatCost(promptPer1K)}/$${formatCost(completionPer1K)} per 1K`;
}

type TestStatus = "idle" | "testing" | "success" | "error";

interface TestResult {
  success: boolean;
  response?: string;
  error?: string;
  responseTime?: number;
}

export function AdminAiSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] = useState<AIProvider>("google");
  const [selectedModel, setSelectedModel] = useState("google/gemini-3.1-flash-lite");
  const [fallbackProvider, setFallbackProvider] = useState<AIProvider | "">(""); 
  const [fallbackModel, setFallbackModel] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [fallbackModelSearch, setFallbackModelSearch] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>("idle");
  const [apiKeyError, setApiKeyError] = useState<string>("");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Fetch current AI settings from app_settings
  const { data: aiSettings, isLoading: isLoadingSettings } = useQuery({
    queryKey: ["admin-ai-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("app_settings")
        .select("*")
        .in("key", ["ai_provider", "ai_model", "ai_fallback_provider", "ai_fallback_model"]);

      if (error) throw error;
      return data || [];
    },
  });

  // Fetch OpenRouter models with validation
  const { 
    data: openRouterData, 
    isLoading: isLoadingModels, 
    refetch: refetchModels,
    error: modelsError 
  } = useQuery({
    queryKey: ["openrouter-models"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("fetch-openrouter-models");
      if (error) throw error;
      return data as { models: OpenRouterModel[]; error?: string };
    },
    enabled: selectedProvider === "openrouter",
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
  });

  const openRouterModels = openRouterData?.models || [];

  // Update API key status based on models fetch result
  useEffect(() => {
    if (selectedProvider !== "openrouter") {
      setApiKeyStatus("idle");
      setApiKeyError("");
      return;
    }

    if (isLoadingModels) {
      setApiKeyStatus("validating");
      setApiKeyError("");
    } else if (modelsError) {
      setApiKeyStatus("error");
      setApiKeyError("Failed to connect to OpenRouter");
    } else if (openRouterData?.error) {
      setApiKeyStatus("invalid");
      setApiKeyError(openRouterData.error);
    } else if (openRouterModels.length > 0) {
      setApiKeyStatus("valid");
      setApiKeyError("");
    } else {
      setApiKeyStatus("invalid");
      setApiKeyError("No models returned - check API key");
    }
  }, [selectedProvider, isLoadingModels, modelsError, openRouterData, openRouterModels.length]);

  // Initialize values from settings
  useEffect(() => {
    if (aiSettings) {
      const providerSetting = aiSettings.find((s) => s.key === "ai_provider");
      const modelSetting = aiSettings.find((s) => s.key === "ai_model");

      if (providerSetting?.value) {
        try {
          const parsed = typeof providerSetting.value === "string" 
            ? JSON.parse(providerSetting.value) 
            : providerSetting.value;
          setSelectedProvider(parsed as AIProvider);
        } catch {
          setSelectedProvider("google");
        }
      }

      if (modelSetting?.value) {
        try {
          const parsed = typeof modelSetting.value === "string" 
            ? JSON.parse(modelSetting.value) 
            : modelSetting.value;
          setSelectedModel(parsed);
        } catch {
          setSelectedModel("google/gemini-3.1-flash-lite");
        }
      }

      const fbProviderSetting = aiSettings.find((s) => s.key === "ai_fallback_provider");
      const fbModelSetting = aiSettings.find((s) => s.key === "ai_fallback_model");

      if (fbProviderSetting?.value) {
        try {
          const parsed = typeof fbProviderSetting.value === "string"
            ? JSON.parse(fbProviderSetting.value)
            : fbProviderSetting.value;
          if (parsed) setFallbackProvider(parsed as AIProvider);
        } catch { /* an unparsable stored value keeps the default */ }
      }

      if (fbModelSetting?.value) {
        try {
          const parsed = typeof fbModelSetting.value === "string"
            ? JSON.parse(fbModelSetting.value)
            : fbModelSetting.value;
          if (parsed) setFallbackModel(parsed);
        } catch { /* an unparsable stored value keeps the default */ }
      }
    }
  }, [aiSettings]);

  // Save settings mutation
  const saveSettingsMutation = useMutation({
    mutationFn: async () => {
      // Upsert ai_provider
      const { error: providerError } = await supabase
        .from("app_settings")
        .upsert({
          key: "ai_provider",
          value: JSON.stringify(selectedProvider),
          description: "AI provider for caption and hashtag generation",
        }, { onConflict: "key" });

      if (providerError) throw providerError;

      // Upsert ai_model
      const { error: modelError } = await supabase
        .from("app_settings")
        .upsert({
          key: "ai_model",
          value: JSON.stringify(selectedModel),
          description: "AI model for caption and hashtag generation",
        }, { onConflict: "key" });

      if (modelError) throw modelError;

      // Upsert fallback provider
      const { error: fbProviderError } = await supabase
        .from("app_settings")
        .upsert({
          key: "ai_fallback_provider",
          value: JSON.stringify(fallbackProvider || ""),
          description: "Fallback AI provider when primary fails",
        }, { onConflict: "key" });

      if (fbProviderError) throw fbProviderError;

      // Upsert fallback model
      const { error: fbModelError } = await supabase
        .from("app_settings")
        .upsert({
          key: "ai_fallback_model",
          value: JSON.stringify(fallbackModel || ""),
          description: "Fallback AI model when primary fails",
        }, { onConflict: "key" });

      if (fbModelError) throw fbModelError;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-ai-settings"] });
      toast({ title: "AI settings saved" });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save settings",
        variant: "destructive",
      });
    },
  });

  const handleSave = async () => {
    setIsSaving(true);
    await saveSettingsMutation.mutateAsync();
    setIsSaving(false);
  };

  // Filter OpenRouter models based on search
  const filteredOpenRouterModels = openRouterModels.filter((model) =>
    model.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
    model.id.toLowerCase().includes(modelSearch.toLowerCase())
  );

  // When provider changes, reset model to a default for that provider
  const handleProviderChange = (provider: AIProvider) => {
    setSelectedProvider(provider);
    setModelSearch("");
    
    if (provider === "google") {
      setSelectedModel("google/gemini-3.1-flash-lite");
    } else if (provider === "openrouter" && openRouterModels?.length) {
      setSelectedModel(openRouterModels[0].id);
    } else {
      setSelectedModel("");
    }
  };

  const getProviderLabel = (provider: AIProvider) => {
    switch (provider) {
      case "google": return "Google AI Studio";
      case "openrouter": return "OpenRouter";
      case "chatgpt": return "ChatGPT (Coming Soon)";
      case "claude": return "Claude (Coming Soon)";
      default: return provider;
    }
  };

  const getSelectedModelPricing = () => {
    if (selectedProvider !== "openrouter") return null;
    const model = openRouterModels.find((m) => m.id === selectedModel);
    return model?.pricing;
  };

  const renderApiKeyStatus = () => {
    if (selectedProvider !== "openrouter") return null;

    switch (apiKeyStatus) {
      case "validating":
        return (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            Validating API key...
          </div>
        );
      case "valid":
        return (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <CheckCircle className="w-4 h-4" />
            API key valid - {openRouterModels.length} models available
          </div>
        );
      case "invalid":
        return (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="w-4 h-4" />
            {apiKeyError || "Invalid API key"}
          </div>
        );
      case "error":
        return (
          <div className="flex items-center gap-2 text-sm text-amber-600">
            <AlertCircle className="w-4 h-4" />
            {apiKeyError || "Connection error"}
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-5 h-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-lg">AI Configuration</CardTitle>
            <CardDescription>
              Configure AI provider and model for caption & hashtag generation
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoadingSettings ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* AI Provider Selection */}
            <div className="space-y-2">
              <Label>AI Provider</Label>
              <Select value={selectedProvider} onValueChange={(v) => handleProviderChange(v as AIProvider)}>
                <SelectTrigger className="w-full max-w-md">
                  <SelectValue placeholder="Select AI provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="google">
                    <div className="flex flex-col items-start">
                      <span className="font-medium">Google AI Studio</span>
                      <span className="text-xs text-muted-foreground">Gemini models via Lovable AI Gateway</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="openrouter">
                    <div className="flex flex-col items-start">
                      <span className="font-medium">OpenRouter</span>
                      <span className="text-xs text-muted-foreground">Access 100+ models from various providers</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="chatgpt" disabled>
                    <div className="flex flex-col items-start">
                      <span className="font-medium text-muted-foreground">ChatGPT</span>
                      <span className="text-xs text-muted-foreground">Coming soon...</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="claude" disabled>
                    <div className="flex flex-col items-start">
                      <span className="font-medium text-muted-foreground">Claude</span>
                      <span className="text-xs text-muted-foreground">Coming soon...</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
              
              {/* API Key Status */}
              <div className="mt-2">
                {renderApiKeyStatus()}
              </div>
            </div>

            {/* Model Selection */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>AI Model</Label>
                {selectedProvider === "openrouter" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => refetchModels()}
                    disabled={isLoadingModels}
                  >
                    {isLoadingModels ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4" />
                    )}
                    <span className="ms-1">Refresh</span>
                  </Button>
                )}
              </div>

              {selectedProvider === "google" && (
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger className="w-full max-w-md">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Google AI Studio Models</SelectLabel>
                      {GOOGLE_MODELS.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          <div className="flex flex-col items-start">
                            <span className="font-medium">{model.name}</span>
                            <span className="text-xs text-muted-foreground">{model.description}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              )}

              {selectedProvider === "openrouter" && (
                <div className="space-y-2">
                  <div className="relative max-w-md">
                    <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      placeholder="Search models..."
                      value={modelSearch}
                      onChange={(e) => setModelSearch(e.target.value)}
                      className="ps-9"
                    />
                  </div>
                  
                  {isLoadingModels ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading models from OpenRouter...
                    </div>
                  ) : filteredOpenRouterModels.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-4">
                      {openRouterModels?.length === 0 
                        ? "No models available. Check your OpenRouter API key."
                        : "No models match your search."}
                    </div>
                  ) : (
                    <Select value={selectedModel} onValueChange={setSelectedModel}>
                      <SelectTrigger className="w-full max-w-md">
                        <SelectValue placeholder="Select model">
                          {selectedModel && (
                            <span className="truncate">
                              {filteredOpenRouterModels.find((m) => m.id === selectedModel)?.name || selectedModel}
                            </span>
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <ScrollArea className="h-[300px]">
                          {filteredOpenRouterModels.slice(0, 100).map((model) => {
                            const pricing = formatPricing(model.pricing);
                            return (
                              <SelectItem key={model.id} value={model.id}>
                                <div className="flex flex-col items-start max-w-[400px]">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium truncate">{model.name}</span>
                                    {pricing && (
                                      <Badge variant={pricing === "Free" ? "secondary" : "outline"} className="text-[10px] px-1.5 py-0">
                                        {pricing}
                                      </Badge>
                                    )}
                                  </div>
                                  <span className="text-xs text-muted-foreground truncate w-full">
                                    {model.id}
                                  </span>
                                </div>
                              </SelectItem>
                            );
                          })}
                          {filteredOpenRouterModels.length > 100 && (
                            <div className="py-2 px-3 text-xs text-muted-foreground">
                              +{filteredOpenRouterModels.length - 100} more models. Use search to narrow down.
                            </div>
                          )}
                        </ScrollArea>
                      </SelectContent>
                    </Select>
                  )}
                  
                  <a
                    href="https://openrouter.ai/models"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  >
                    Browse all OpenRouter models
                    <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}

              {(selectedProvider === "chatgpt" || selectedProvider === "claude") && (
                <div className="p-4 rounded-lg border border-dashed bg-muted/50 text-sm text-muted-foreground max-w-md">
                  This provider is coming soon. Stay tuned for updates!
                </div>
              )}
            </div>

            {/* Test AI Section */}
            <div className="p-4 rounded-lg border bg-card max-w-md">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-sm font-medium">Test AI Model</p>
                  <p className="text-xs text-muted-foreground">
                    Verify the selected model works before saving
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setTestStatus("testing");
                    setTestResult(null);
                    
                    try {
                      const { data, error } = await supabase.functions.invoke("test-ai-model", {
                        body: { provider: selectedProvider, model: selectedModel },
                      });
                      
                      if (error) throw error;
                      
                      setTestResult(data);
                      setTestStatus(data.success ? "success" : "error");
                      
                      if (data.success) {
                        toast({
                          title: "Test successful!",
                          description: `Response time: ${data.responseTime}ms`,
                        });
                      }
                    } catch (err) {
                      setTestStatus("error");
                      setTestResult({
                        success: false,
                        error: err instanceof Error ? err.message : "Test failed",
                      });
                    }
                  }}
                  disabled={testStatus === "testing" || !selectedModel}
                >
                  {testStatus === "testing" ? (
                    <>
                      <Loader2 className="w-4 h-4 me-1 animate-spin" />
                      Testing...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 me-1" />
                      Test
                    </>
                  )}
                </Button>
              </div>
              
              {testResult && (
                <div className={`mt-3 p-3 rounded-lg text-sm ${
                  testResult.success 
                    ? "bg-green-500/10 border border-green-500/20" 
                    : "bg-destructive/10 border border-destructive/20"
                }`}>
                  {testResult.success ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-green-600">
                        <CheckCircle className="w-4 h-4" />
                        <span className="font-medium">Test passed</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Response: "{testResult.response?.slice(0, 50)}..."
                      </p>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Zap className="w-3 h-3" />
                        {testResult.responseTime}ms response time
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 text-destructive">
                        <XCircle className="w-4 h-4" />
                        <span className="font-medium">Test failed</span>
                      </div>
                      <p className="text-xs">{testResult.error}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Fallback Model Section */}
            <div className="space-y-4 p-4 rounded-lg border border-dashed bg-muted/30 max-w-md">
              <div>
                <p className="text-sm font-medium flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 text-muted-foreground" />
                  Fallback Model
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  If the primary model fails, this model will be used as a backup
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-xs">Fallback Provider</Label>
                <Select 
                  value={fallbackProvider || "none"} 
                  onValueChange={(v) => {
                    const val = v === "none" ? "" : v as AIProvider;
                    setFallbackProvider(val as AIProvider | "");
                    setFallbackModel("");
                    setFallbackModelSearch("");
                    if (val === "google") setFallbackModel("google/gemini-3.1-flash-lite");
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="No fallback" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No fallback</SelectItem>
                    <SelectItem value="google">
                      <div className="flex flex-col items-start">
                        <span className="font-medium">Google AI Studio</span>
                        <span className="text-xs text-muted-foreground">Gemini models via Google AI Studio</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="openrouter">
                      <div className="flex flex-col items-start">
                        <span className="font-medium">OpenRouter</span>
                        <span className="text-xs text-muted-foreground">Access 100+ models from various providers</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="chatgpt" disabled>
                      <div className="flex flex-col items-start">
                        <span className="font-medium text-muted-foreground">ChatGPT</span>
                        <span className="text-xs text-muted-foreground">Coming soon...</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="claude" disabled>
                      <div className="flex flex-col items-start">
                        <span className="font-medium text-muted-foreground">Claude</span>
                        <span className="text-xs text-muted-foreground">Coming soon...</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {fallbackProvider === "google" && (
                <div className="space-y-2">
                  <Label className="text-xs">Fallback Model</Label>
                  <Select value={fallbackModel} onValueChange={setFallbackModel}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select fallback model" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectLabel>Google AI Studio Models</SelectLabel>
                        {GOOGLE_MODELS.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            <div className="flex flex-col items-start">
                              <span className="font-medium">{model.name}</span>
                              <span className="text-xs text-muted-foreground">{model.description}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {fallbackProvider === "openrouter" && (
                <div className="space-y-2">
                  <Label className="text-xs">Fallback Model</Label>
                  <div className="relative">
                    <Search className="absolute start-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      placeholder="Search models..."
                      value={fallbackModelSearch}
                      onChange={(e) => setFallbackModelSearch(e.target.value)}
                      className="ps-9"
                    />
                  </div>
                  {openRouterModels.length > 0 && (
                    <Select value={fallbackModel} onValueChange={setFallbackModel}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select fallback model">
                          {fallbackModel && (
                            <span className="truncate">
                              {openRouterModels.find((m) => m.id === fallbackModel)?.name || fallbackModel}
                            </span>
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <ScrollArea className="h-[300px]">
                          {openRouterModels
                            .filter((m) =>
                              m.name.toLowerCase().includes(fallbackModelSearch.toLowerCase()) ||
                              m.id.toLowerCase().includes(fallbackModelSearch.toLowerCase())
                            )
                            .slice(0, 100)
                            .map((model) => {
                              const pricing = formatPricing(model.pricing);
                              return (
                                <SelectItem key={model.id} value={model.id}>
                                  <div className="flex flex-col items-start max-w-[400px]">
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium truncate">{model.name}</span>
                                      {pricing && (
                                        <Badge variant={pricing === "Free" ? "secondary" : "outline"} className="text-[10px] px-1.5 py-0">
                                          {pricing}
                                        </Badge>
                                      )}
                                    </div>
                                    <span className="text-xs text-muted-foreground truncate w-full">
                                      {model.id}
                                    </span>
                                  </div>
                                </SelectItem>
                              );
                            })}
                          {openRouterModels.filter((m) =>
                            m.name.toLowerCase().includes(fallbackModelSearch.toLowerCase()) ||
                            m.id.toLowerCase().includes(fallbackModelSearch.toLowerCase())
                          ).length > 100 && (
                            <div className="py-2 px-3 text-xs text-muted-foreground">
                              +{openRouterModels.filter((m) =>
                                m.name.toLowerCase().includes(fallbackModelSearch.toLowerCase()) ||
                                m.id.toLowerCase().includes(fallbackModelSearch.toLowerCase())
                              ).length - 100} more models. Use search to narrow down.
                            </div>
                          )}
                        </ScrollArea>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              )}
            </div>

            {/* Current Selection Summary */}
            <div className="p-4 rounded-lg bg-secondary/50 border max-w-md">
              <p className="text-sm font-medium mb-2">Current Configuration</p>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Provider: <span className="font-medium text-foreground">{getProviderLabel(selectedProvider)}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  Model: <span className="font-medium text-foreground">{selectedModel || "Not selected"}</span>
                </p>
                {selectedProvider === "openrouter" && getSelectedModelPricing() && (
                  <p className="text-xs text-muted-foreground">
                    Pricing: <span className="font-medium text-foreground">
                      {formatPricing(getSelectedModelPricing())} (prompt/completion)
                    </span>
                  </p>
                )}
                {fallbackProvider && fallbackModel && (
                  <>
                    <div className="border-t border-border my-2" />
                    <p className="text-xs text-muted-foreground">
                      Fallback Provider: <span className="font-medium text-foreground">{getProviderLabel(fallbackProvider as AIProvider)}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Fallback Model: <span className="font-medium text-foreground">{fallbackModel}</span>
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* Save Button */}
            <div className="flex justify-end pt-2">
              <Button
                onClick={handleSave}
                disabled={isSaving || !selectedModel || (selectedProvider === "openrouter" && apiKeyStatus === "invalid")}
              >
                {isSaving ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save className="w-4 h-4 me-2" />
                    Save AI Settings
                  </>
                )}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
