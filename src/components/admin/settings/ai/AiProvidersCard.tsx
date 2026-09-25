import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Activity, CheckCircle2, XCircle, Layers, Loader2, Eye, EyeOff, KeyRound,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  useAIConfiguration, useToggleProvider, useToggleModel, useTestConnection,
  useSetServiceKey, useTestService, useCheckServiceKey,
} from '@/hooks/useAIConfiguration';
import type { AIProvider, TestConnectionResult } from '@/hooks/useAIConfiguration';
import { SyncModelsButton } from './SyncModelsButton';
import { SYNCABLE_PROVIDER_CODES } from '@/hooks/ai-config/useSyncModels';

function isOAuthProvider(provider: AIProvider | null) {
  return !!provider && (provider.auth_type === 'oauth' || provider.provider_code === 'higgsfield' || provider.api_type === 'higgsfield');
}

/**
 * Providers, their API keys, and the two non-model scraping services.
 *
 * These live in one panel rather than one per provider because they share state that
 * cannot be split: the dialog holds whichever provider was clicked, and the key-status
 * badge on every tile comes from a single `useCheckServiceKey` call over all codes.
 */
export function AiProvidersCard() {
  const queryClient = useQueryClient();
  const { data: aiConfig, isLoading } = useAIConfiguration();
  const toggleProvider = useToggleProvider();
  const toggleModel = useToggleModel();
  const testConnection = useTestConnection();
  const setServiceKey = useSetServiceKey();
  const testService = useTestService();

  const allProviderCodes = [
    'firecrawl', 'apify',
    ...(aiConfig?.providers?.map(p => p.provider_code) || []),
  ];
  const { data: serviceKeyStatus } = useCheckServiceKey(allProviderCodes);

  const [selectedProvider, setSelectedProvider] = useState<AIProvider | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestConnectionResult>>({});
  const [serviceTestResults, setServiceTestResults] = useState<Record<string, { success: boolean; latency?: number; error?: string } | null>>({});

  const [providerApiKey, setProviderApiKey] = useState('');
  const [showProviderKey, setShowProviderKey] = useState(false);
  const [savingProviderKey, setSavingProviderKey] = useState(false);

  const handleToggleProvider = async (providerId: string, isActive: boolean) => {
    try {
      await toggleProvider.mutateAsync({ provider_id: providerId, is_active: !isActive });
      toast.success('Provider updated');
    } catch {
      toast.error('Failed to update provider');
    }
  };

  const handleToggleModel = async (modelId: string, isActive: boolean) => {
    try {
      await toggleModel.mutateAsync({ model_id: modelId, is_active: !isActive });
      toast.success('Model updated');
    } catch {
      toast.error('Failed to update model');
    }
  };

  const handleTestConnection = async (providerId: string) => {
    try {
      setTestResults(prev => ({ ...prev, [providerId]: { success: false } }));
      const result = await testConnection.mutateAsync({ provider_id: providerId });
      setTestResults(prev => ({ ...prev, [providerId]: result }));
      if (result.success) toast.success(`Connection successful (${result.latency}ms)`);
      else toast.error(`Connection failed: ${result.error}`);
    } catch {
      toast.error('Connection test failed');
    }
  };

  const handleSaveProviderKey = async (providerCode: string) => {
    if (!providerApiKey.trim()) return;
    setSavingProviderKey(true);
    try {
      const r = await setServiceKey.mutateAsync({ provider_code: providerCode, api_key: providerApiKey.trim() });
      if (r.success) {
        if (r.warning) toast.warning(`API key saved. ${r.warning}`);
        else toast.success(`API key saved & validated (${r.latency}ms)`);
        setProviderApiKey('');
        setShowProviderKey(false);
        // Optimistically update badge to "Configured" immediately
        queryClient.setQueryData(
          ['service-keys', ...allProviderCodes],
          (old: Record<string, boolean> | undefined) => ({ ...old, [providerCode]: true })
        );
        queryClient.refetchQueries({ queryKey: ['service-keys'] });
      } else {
        toast.error(r.error || 'Invalid API key');
      }
    } catch {
      toast.error('Failed to save API key');
    } finally {
      setSavingProviderKey(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const providers = aiConfig?.providers || [];
  const models = aiConfig?.models || [];

  if (providers.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6">
          <div className="text-center py-8">
            <p className="text-muted-foreground mb-4">AI configuration not set up. Apply the database migration.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const modelsByProvider: Record<string, typeof models> = {};
  models.forEach(model => {
    if (!modelsByProvider[model.provider_id]) modelsByProvider[model.provider_id] = [];
    modelsByProvider[model.provider_id].push(model);
  });

  const defaultModel = aiConfig?.defaultModel;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>AI Providers</CardTitle>
          <CardDescription>Manage AI providers and their connection status</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-2">
            {providers.map(provider => {
              const providerModels = modelsByProvider[provider.id] || [];
              const activeModels = providerModels.filter(m => m.is_active).length;
              const testResult = testResults[provider.id];
              const hasKey = serviceKeyStatus?.[provider.provider_code] ?? false;

              return (
                <Card key={provider.id}
                  className={`cursor-pointer transition-all hover:shadow-md ${provider.is_active ? 'border-primary/30' : 'border-muted opacity-60'}`}
                  onClick={() => { setSelectedProvider(provider); setProviderApiKey(''); setShowProviderKey(false); }}>
                  <CardContent className="p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-1">
                      <h3 className="font-semibold text-xs truncate">{provider.name}</h3>
                      <div className="flex items-center gap-1 shrink-0">
                        {hasKey ? <CheckCircle2 className="w-3 h-3 text-primary" /> : <XCircle className="w-3 h-3 text-destructive" />}
                        <Badge variant={provider.is_active ? 'default' : 'secondary'} className="text-[9px] px-1 py-0">
                          {provider.provider_code}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Layers className="w-2.5 h-2.5" />
                      <span>{provider.api_type}</span>
                      <span>•</span>
                      <span>{activeModels}/{providerModels.length}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <Button size="sm" variant="outline"
                        onClick={(e) => { e.stopPropagation(); handleTestConnection(provider.id); }}
                        disabled={testConnection.isPending}
                        className="h-5 px-1.5 text-[10px] gap-0.5">
                        {testConnection.isPending && !testResult?.success && !testResult?.error ? (
                          <Activity className="w-3 h-3 animate-pulse" />
                        ) : testResult?.success ? (
                          <CheckCircle2 className="w-3 h-3 text-primary" />
                        ) : testResult?.error ? (
                          <XCircle className="w-3 h-3 text-destructive" />
                        ) : (
                          <Activity className="w-3 h-3" />
                        )}
                        Test
                      </Button>
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <Switch id={`p-${provider.id}`} checked={provider.is_active}
                          onCheckedChange={() => handleToggleProvider(provider.id, provider.is_active)} className="scale-75" />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Provider Models Dialog */}
      <Dialog open={!!selectedProvider} onOpenChange={(open) => { if (!open) { setSelectedProvider(null); setProviderApiKey(''); setShowProviderKey(false); } }}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selectedProvider?.name}
              <Badge variant="outline" className="text-xs">{selectedProvider?.provider_code}</Badge>
              {selectedProvider && (serviceKeyStatus?.[selectedProvider.provider_code]
                ? <CheckCircle2 className="w-4 h-4 text-primary" />
                : <XCircle className="w-4 h-4 text-destructive" />
              )}
            </DialogTitle>
            <DialogDescription>{selectedProvider?.api_type} • {selectedProvider?.api_endpoint}</DialogDescription>
          </DialogHeader>

          {/* API Key Section — OAuth providers (Higgsfield) connect via the Hub card, not a pasted key. */}
          {selectedProvider && isOAuthProvider(selectedProvider) && (
            <div className="space-y-2 p-3 rounded-lg border border-border bg-muted/30">
              <p className="text-xs text-muted-foreground">
                Higgsfield uses OAuth, not an API key. Connect it from the Higgsfield Hub card on this
                page, then use Test and Sync models.
              </p>
            </div>
          )}
          {selectedProvider && !isOAuthProvider(selectedProvider) && (
            <div className="space-y-2 p-3 rounded-lg border border-border bg-muted/30">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <KeyRound className="w-3.5 h-3.5" />
                <span>API Key ({selectedProvider.api_key_env_var})</span>
                {serviceKeyStatus?.[selectedProvider.provider_code]
                  ? <Badge variant="outline" className="text-[10px] text-primary border-primary/30">Configured</Badge>
                  : <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30">Missing</Badge>
                }
              </div>
              <div className="flex gap-2">
                <Input
                  type={showProviderKey ? 'text' : 'password'}
                  placeholder="Enter API key..."
                  value={providerApiKey}
                  onChange={(e) => setProviderApiKey(e.target.value)}
                  className="h-7 text-xs flex-1"
                />
                <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={() => setShowProviderKey(!showProviderKey)}>
                  {showProviderKey ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                </Button>
              </div>
              <Button size="sm" className="w-full h-7 text-xs" disabled={!providerApiKey.trim() || savingProviderKey}
                onClick={() => handleSaveProviderKey(selectedProvider.provider_code)}>
                {savingProviderKey ? <Loader2 className="w-3 h-3 animate-spin me-1" /> : null}
                Save & Test
              </Button>
            </div>
          )}

          {selectedProvider && (SYNCABLE_PROVIDER_CODES as readonly string[]).includes(selectedProvider.provider_code) && (
            <div className="flex items-center justify-between pt-2">
              <span className="text-xs text-muted-foreground">Pull the provider's current model list</span>
              <SyncModelsButton providerCode={selectedProvider.provider_code}
                lastSyncedAt={(aiConfig?.settings ?? []).find((s) => s.key === `model_catalog_synced_at_${selectedProvider.provider_code}`)?.value?.at ?? null} />
            </div>
          )}

          {/* Models List */}
          <div className="space-y-3 pt-2">
            {selectedProvider && (modelsByProvider[selectedProvider.id] || []).map(model => (
              <div key={model.id}
                className={`flex items-center justify-between p-3 rounded-lg border ${model.is_active ? 'bg-background' : 'bg-muted/50 opacity-60'}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-medium text-sm">{model.name}</h4>
                    <Badge variant="outline" className="text-[10px]">{model.model_id}</Badge>
                    {defaultModel?.provider_code === selectedProvider.provider_code && defaultModel?.model_id === model.model_id && (
                      <Badge className="text-[10px] bg-primary">Default</Badge>
                    )}
                  </div>
                  {model.description && <p className="text-xs text-muted-foreground mt-1">{model.description}</p>}
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {model.capabilities.map(cap => (
                      <Badge key={cap} variant="secondary" className="text-[10px]">{cap}</Badge>
                    ))}
                    {model.context_limit ? <span className="text-[10px] text-muted-foreground">{model.context_limit.toLocaleString()} tokens</span> : null}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0 ms-2">
                  <div className="text-end text-[10px] text-muted-foreground">
                    {model.cost_per_1m_input_tokens ? <div>In: ${model.cost_per_1m_input_tokens}/1M</div> : null}
                    {model.cost_per_1m_output_tokens ? <div>Out: ${model.cost_per_1m_output_tokens}/1M</div> : null}
                  </div>
                  <Switch checked={model.is_active} onCheckedChange={() => handleToggleModel(model.id, model.is_active)} />
                </div>
              </div>
            ))}
            {selectedProvider && (modelsByProvider[selectedProvider.id] || []).length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No models configured</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* External Scraping Services */}
      <Card>
        <CardHeader>
          <CardTitle>External Scraping Services</CardTitle>
          <CardDescription>Firecrawl for websites, Apify for social media scraping</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <ExternalServiceCard name="Firecrawl" description="Website scraping (markdown extraction)"
              hasKey={serviceKeyStatus?.firecrawl ?? false} isSaving={setServiceKey.isPending} isTesting={testService.isPending}
              testResult={serviceTestResults.firecrawl ?? null}
              onTest={async () => {
                try {
                  const r = await testService.mutateAsync({ provider_code: 'firecrawl' });
                  setServiceTestResults(p => ({ ...p, firecrawl: r }));
                  if (r.success) toast.success(`Firecrawl connected (${r.latency}ms)`);
                  else toast.error(r.error || 'Failed');
                } catch { toast.error('Test failed'); }
              }}
              onSaveKey={async (key) => {
                try {
                  const r = await setServiceKey.mutateAsync({ provider_code: 'firecrawl', api_key: key });
                  if (r.success) { toast.success('Firecrawl key saved'); setServiceTestResults(p => ({ ...p, firecrawl: r })); }
                  else toast.error(r.error || 'Invalid key');
                } catch { toast.error('Failed to save key'); }
              }} />
            <ExternalServiceCard name="Apify" description="Social media scraping (LinkedIn, Instagram)"
              hasKey={serviceKeyStatus?.apify ?? false} isSaving={setServiceKey.isPending} isTesting={testService.isPending}
              testResult={serviceTestResults.apify ?? null}
              onTest={async () => {
                try {
                  const r = await testService.mutateAsync({ provider_code: 'apify' });
                  setServiceTestResults(p => ({ ...p, apify: r }));
                  if (r.success) toast.success(`Apify connected (${r.latency}ms)`);
                  else toast.error(r.error || 'Failed');
                } catch { toast.error('Test failed'); }
              }}
              onSaveKey={async (key) => {
                try {
                  const r = await setServiceKey.mutateAsync({ provider_code: 'apify', api_key: key });
                  if (r.success) { toast.success('Apify key saved'); setServiceTestResults(p => ({ ...p, apify: r })); }
                  else toast.error(r.error || 'Invalid key');
                } catch { toast.error('Failed to save key'); }
              }} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ExternalServiceCard({ name, description, hasKey, onSaveKey, onTest, isSaving, isTesting, testResult }: {
  name: string; description: string;
  hasKey: boolean; onSaveKey: (key: string) => void; onTest: () => void;
  isSaving: boolean; isTesting: boolean;
  testResult: { success: boolean; latency?: number; error?: string } | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);

  return (
    <div className="p-3 rounded-lg border bg-card space-y-2">
      <div className="flex items-center justify-between cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div>
          <div className="flex items-center gap-2">
            <h4 className="font-medium text-sm">{name}</h4>
            {hasKey ? <CheckCircle2 className="w-3.5 h-3.5 text-primary" /> : <XCircle className="w-3.5 h-3.5 text-destructive" />}
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" disabled={isTesting}
            onClick={(e) => { e.stopPropagation(); onTest(); }}>
            {isTesting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Activity className="w-3 h-3" />}
            Test
          </Button>
        </div>
      </div>
      {testResult && (
        <div className={`text-[10px] px-2 py-1 rounded ${testResult.success ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive'}`}>
          {testResult.success ? `Connected (${testResult.latency}ms)` : testResult.error || 'Connection failed'}
        </div>
      )}
      {expanded && (
        <div className="space-y-2 pt-1 border-t border-border">
          <div className="flex gap-2">
            <Input type={showKey ? 'text' : 'password'} placeholder="Enter API key..." value={apiKey}
              onChange={(e) => setApiKey(e.target.value)} className="h-7 text-xs flex-1" />
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={() => setShowKey(!showKey)}>
              {showKey ? 'Hide' : 'Show'}
            </Button>
          </div>
          <Button size="sm" className="w-full h-7 text-xs" disabled={!apiKey.trim() || isSaving}
            onClick={() => { onSaveKey(apiKey.trim()); setApiKey(''); }}>
            {isSaving ? <Loader2 className="w-3 h-3 animate-spin me-1" /> : null}
            Save & Test
          </Button>
        </div>
      )}
    </div>
  );
}
