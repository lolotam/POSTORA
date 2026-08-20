import { useState, useMemo, useEffect } from 'react';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Check, ChevronsUpDown, Loader2, Shield, ShieldAlert } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AIProvider, AIModel, DefaultModel } from '@/hooks/useAIConfiguration';
import { useOpenRouterModels, extractSeries, formatPrice } from '@/hooks/useOpenRouterModels';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ModelParamControls } from '@/components/admin/shared/ModelParamControls';
import { defaultParamsFor, mergeModelSpec } from '@/lib/higgsfieldModelSpecs';

const CATEGORY_MODALITY: Record<string, string> = {
  chat: 'text', search: 'text', image: 'image', tts: 'audio', video: 'video',
};

const CATEGORY_LAST_RESORT: Record<string, { provider: string; model: string } | null> = {
  chat: { provider: 'google', model: 'gemini-3-flash-preview' },
  image: { provider: 'google', model: 'gemini-2.5-flash-image' },
  tts: { provider: 'google', model: 'gemini-2.5-flash' },
  video: null,
  search: null,
  stt: null,
};

interface DefaultModelSelectorProps {
  category: 'chat' | 'image' | 'tts' | 'video' | 'search' | 'stt';
  capability: string;
  title: string;
  description: string;
  icon: LucideIcon;
  providers: AIProvider[];
  models: AIModel[];
  currentDefault: DefaultModel | null;
  currentFallback: DefaultModel | null;
  currentFallback2: DefaultModel | null;
  onSetDefault: (providerCode: string, modelId: string) => void;
  onSetFallback: (providerCode: string, modelId: string) => void;
  onSetFallback2: (providerCode: string, modelId: string) => void;
  /** Persist the primary model's knobs. Receives the ai_models row id. */
  onSetAdminParams: (modelRowId: string, params: Record<string, string | number | boolean>) => void;
  isSaving?: boolean;
}

export function DefaultModelSelector({
  category, capability, title, description, icon: Icon,
  providers, models, currentDefault, currentFallback, currentFallback2,
  onSetDefault, onSetFallback, onSetFallback2, onSetAdminParams, isSaving,
}: DefaultModelSelectorProps) {
  const primaryRow = useMemo(
    () =>
      currentDefault
        ? models.find(
            (m) =>
              m.model_id === currentDefault.model_id &&
              m.ai_providers?.provider_code === currentDefault.provider_code,
          ) ?? null
        : null,
    [models, currentDefault],
  );
  const primarySpec = useMemo(
    () =>
      mergeModelSpec(
        primaryRow?.model_id ?? '',
        primaryRow?.metadata ?? null,
        capability === 'video' ? 'video' : 'image',
      ),
    [primaryRow, capability],
  );

  const filteredModels = useMemo(
    () => models.filter(m => m.is_active && m.capabilities?.includes(capability)),
    [models, capability]
  );

  const availableProviders = useMemo(() => {
    const providerIds = new Set(filteredModels.map(m => m.provider_id));
    return providers.filter(p => p.is_active && providerIds.has(p.id));
  }, [providers, filteredModels]);

  const hasModels = filteredModels.length > 0;
  const lastResort = CATEGORY_LAST_RESORT[category];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="w-5 h-5" />
          {title}
        </CardTitle>
        <CardDescription className="text-xs">{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {!hasModels ? (
          <p className="text-sm text-muted-foreground italic">No models available for this category yet.</p>
        ) : (
          <div className="space-y-4">
            {/* Primary */}
            <TierSelector
              label="Primary"
              icon={<Check className="w-3.5 h-3.5 text-primary" />}
              providers={availableProviders}
              allProviders={providers}
              filteredModels={filteredModels}
              currentModel={currentDefault}
              onSelect={onSetDefault}
              isSaving={isSaving}
              category={category}
            />

            <Separator />

            {/* Fallback */}
            <TierSelector
              label="Fallback"
              icon={<Shield className="w-3.5 h-3.5 text-warning" />}
              providers={availableProviders}
              allProviders={providers}
              filteredModels={filteredModels}
              currentModel={currentFallback}
              onSelect={onSetFallback}
              isSaving={isSaving}
              category={category}
            />

            <Separator />

            {/* Fallback 2 */}
            <TierSelector
              label="Fallback 2"
              icon={<Shield className="w-3.5 h-3.5 text-muted-foreground" />}
              providers={availableProviders}
              allProviders={providers}
              filteredModels={filteredModels}
              currentModel={currentFallback2}
              onSelect={onSetFallback2}
              isSaving={isSaving}
              category={category}
            />

            {primaryRow && primarySpec.parameters.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <p className="text-sm font-medium">{primaryRow.name} parameters</p>
                  <p className="text-xs text-muted-foreground">
                    Applied to every generation with this model. Aspect ratio stays with the user.
                  </p>
                  <ModelParamControls
                    spec={primarySpec}
                    values={{ ...defaultParamsFor(primarySpec), ...(primaryRow.admin_params ?? {}) }}
                    onChange={(next) => onSetAdminParams(primaryRow.id, next)}
                    omit={['aspect_ratio']}
                    disabled={isSaving}
                  />
                </div>
              </>
            )}

                        {/* Last Resort */}
            {lastResort && (
              <>
                <Separator />
                <div className="space-y-1">
                  <Label className="text-xs flex items-center gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 text-destructive" />
                    Last Resort (Hardcoded)
                  </Label>
                  <Badge variant="outline" className="gap-1 text-xs">
                    {lastResort.provider}/{lastResort.model}
                  </Badge>
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface TierSelectorProps {
  label: string;
  icon: React.ReactNode;
  providers: AIProvider[];
  allProviders: AIProvider[];
  filteredModels: AIModel[];
  currentModel: DefaultModel | null;
  onSelect: (providerCode: string, modelId: string) => void;
  isSaving?: boolean;
  category: string;
}

function TierSelector({ label, icon, providers, allProviders, filteredModels, currentModel, onSelect, isSaving, category }: TierSelectorProps) {
  const initialProvider = useMemo(() => {
    if (!currentModel?.provider_code) return '';
    const p = providers.find(p => p.provider_code === currentModel.provider_code);
    return p?.id || '';
  }, [currentModel, providers]);

  const [selectedProviderId, setSelectedProviderId] = useState(initialProvider);

  useEffect(() => {
    if (initialProvider) setSelectedProviderId(initialProvider);
  }, [initialProvider]);

  const providerModels = useMemo(
    () => filteredModels.filter(m => m.provider_id === selectedProviderId),
    [filteredModels, selectedProviderId]
  );

  const selectedProvider = allProviders.find(p => p.id === selectedProviderId);
  const isOpenRouter = selectedProvider?.provider_code === 'openrouter';

  const { data: openRouterModels, isLoading: orLoading } = useOpenRouterModels();
  const requiredModality = CATEGORY_MODALITY[category] || 'text';

  const filteredORModels = useMemo(() => {
    if (!isOpenRouter || !openRouterModels) return [];
    return openRouterModels
      .filter(m => m.architecture.output_modalities?.includes(requiredModality))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [isOpenRouter, openRouterModels, requiredModality]);

  const [orOpen, setOrOpen] = useState(false);
  const [orSearch, setOrSearch] = useState('');

  const visibleORModels = useMemo(() => {
    if (!orSearch) return filteredORModels.slice(0, 100);
    const q = orSearch.toLowerCase();
    return filteredORModels.filter(m =>
      m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
    ).slice(0, 100);
  }, [filteredORModels, orSearch]);

  const handleModelChange = (modelId: string) => {
    const provider = allProviders.find(p => p.id === selectedProviderId);
    if (provider) onSelect(provider.provider_code, modelId);
  };

  return (
    <div className="space-y-2">
      <Label className="text-xs flex items-center gap-1.5">
        {icon}
        {label}
      </Label>
      <div className="grid grid-cols-2 gap-2">
        <Select value={selectedProviderId} onValueChange={setSelectedProviderId}>
          <SelectTrigger className="w-full text-xs h-8">
            <SelectValue placeholder="Provider..." />
          </SelectTrigger>
          <SelectContent>
            {providers.map(p => (
              <SelectItem key={p.id} value={p.id}>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">{p.name}</span>
                  <Badge variant="outline" className="text-[9px] py-0">{p.provider_code}</Badge>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectedProviderId && isOpenRouter ? (
          <Popover open={orOpen} onOpenChange={setOrOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" role="combobox" aria-expanded={orOpen}
                className="w-full justify-between font-normal text-xs h-8" disabled={isSaving || orLoading}>
                {orLoading ? (
                  <span className="flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Loading...</span>
                ) : currentModel?.provider_code === 'openrouter' && currentModel?.model_id ? (
                  <span className="truncate text-xs">{currentModel.model_id}</span>
                ) : 'Model...'}
                <ChevronsUpDown className="ms-1 h-3 w-3 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[400px] p-0" align="start">
              <Command shouldFilter={false}>
                <CommandInput placeholder="Search models..." value={orSearch} onValueChange={setOrSearch} />
                <CommandList className="max-h-[300px]">
                  <CommandEmpty>No models found.</CommandEmpty>
                  <CommandGroup>
                    {visibleORModels.map(m => (
                      <CommandItem key={m.id} value={m.id} onSelect={() => { handleModelChange(m.id); setOrOpen(false); setOrSearch(''); }}>
                        <div className="flex items-center gap-2 w-full min-w-0">
                          <Check className={`w-3 h-3 shrink-0 ${currentModel?.model_id === m.id ? 'opacity-100' : 'opacity-0'}`} />
                          <span className="truncate flex-1">{m.name}</span>
                          <Badge variant="outline" className="text-[10px] py-0 shrink-0">{extractSeries(m.id)}</Badge>
                          <span className="text-[10px] text-muted-foreground shrink-0">{formatPrice(m.pricing.prompt)}</span>
                        </div>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        ) : selectedProviderId ? (
          <Select
            value={currentModel?.provider_code === selectedProvider?.provider_code ? currentModel?.model_id || '' : ''}
            onValueChange={handleModelChange} disabled={isSaving}>
            <SelectTrigger className="w-full text-xs h-8">
              <SelectValue placeholder="Model..." />
            </SelectTrigger>
            <SelectContent>
              {providerModels.map(m => (
                <SelectItem key={m.id} value={m.model_id}>
                  <span className="text-xs">{m.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="h-8" />
        )}
      </div>

      {currentModel?.model_id && (
        <Badge variant="outline" className="gap-1 text-[10px]">
          <Check className="w-2.5 h-2.5" />
          {currentModel.model_id}
        </Badge>
      )}
    </div>
  );
}
