import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Bot } from 'lucide-react';
import { DefaultModelSelector, openRouterModelsFor, servesCapability } from '../DefaultModelSelector';

// The live OpenRouter catalogue (openrouter-models) never returns "decisions"
// output_modalities, so it stands in here for what a chat-only catalogue looks
// like: a chat model, no Jev. If the fix regresses and the triage category goes
// back to reading this catalogue, the Primary picker would offer this model
// instead of the synced Jev row.
vi.mock('@/hooks/useOpenRouterModels', () => ({
  useOpenRouterModels: () => ({
    data: [
      {
        id: 'openai/gpt-5-mini', name: 'GPT-5 mini', pricing: { prompt: '0', completion: '0' },
        context_length: 1000, architecture: { modality: 'text', output_modalities: ['text'] },
      },
    ],
    isLoading: false,
  }),
  extractSeries: (id: string) => id.split('/')[0] || 'unknown',
  formatPrice: () => 'Free',
}));

const providers = [
  {
    id: 'prov-openrouter', provider_code: 'openrouter', name: 'OpenRouter',
    api_endpoint: '', api_key_env_var: '', api_type: '', supports_streaming: true, is_active: true,
  },
] as never;

const models = [
  {
    id: 'model-jev', provider_id: 'prov-openrouter', model_id: 'typesafe/jev-1.13', name: 'Jev 1.13',
    description: null, capabilities: ['triage'], context_limit: null, is_active: true,
    cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null,
    ai_providers: { provider_code: 'openrouter', name: 'OpenRouter' },
  },
  {
    id: 'model-chat', provider_id: 'prov-openrouter', model_id: 'openai/gpt-5-mini', name: 'GPT-5 mini',
    description: null, capabilities: ['chat'], context_limit: null, is_active: true,
    cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null,
    ai_providers: { provider_code: 'openrouter', name: 'OpenRouter' },
  },
] as never;

/** Opens a radix select trigger the same way SheetsSyncDialog's tests do. */
function openSelect(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, buttons: 1, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

describe('DefaultModelSelector — agent_triage category', () => {
  it('offers the synced Jev model for the OpenRouter tier, not the live chat catalogue', async () => {
    render(
      <DefaultModelSelector
        category="agent_triage"
        capability="triage"
        title="Triage model"
        description=""
        icon={Bot}
        providers={providers}
        models={models}
        currentDefault={null}
        currentFallback={null}
        currentFallback2={null}
        onSetDefault={vi.fn()}
        onSetFallback={vi.fn()}
        onSetFallback2={vi.fn()}
      />,
    );

    const primarySection = screen.getByText('Primary').closest('div.space-y-2') as HTMLElement;
    const providerTrigger = within(primarySection).getByRole('combobox');
    openSelect(providerTrigger);
    fireEvent.click(await waitFor(() => screen.getByRole('option', { name: /OpenRouter/i })));

    const modelTrigger = await waitFor(() => {
      const triggers = within(primarySection).getAllByRole('combobox');
      expect(triggers.length).toBe(2);
      return triggers[1];
    });
    openSelect(modelTrigger);

    expect(await screen.findByRole('option', { name: 'Jev 1.13' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'GPT-5 mini' })).not.toBeInTheDocument();
  });
});

describe('openRouterModelsFor — Image & Document Understanding', () => {
  const catalogue = [
    { id: 'text/only', name: 'Text only', architecture: { input_modalities: ['text'], output_modalities: ['text'] } },
    { id: 'google/gemini-3.1-flash-lite', name: 'Gemini Flash Lite', architecture: { input_modalities: ['text', 'image', 'file'], output_modalities: ['text'] } },
    { id: 'image/maker', name: 'Image maker', architecture: { input_modalities: ['text', 'image'], output_modalities: ['image'] } },
  ];

  it('offers only models that accept an image and answer in text', () => {
    expect(openRouterModelsFor(catalogue, 'vision').map((m) => m.id)).toEqual(['google/gemini-3.1-flash-lite']);
  });

  it('leaves the chat category unchanged, text-only models included', () => {
    expect(openRouterModelsFor(catalogue, 'chat').map((m) => m.id)).toEqual(['google/gemini-3.1-flash-lite', 'text/only']);
  });
});

describe('servesCapability — triage slots', () => {
  it('accepts Jev decision models and chat models approved for triage', () => {
    expect(servesCapability(['triage'], 'triage')).toBe(true);
    expect(servesCapability(['chat', 'triage_chat'], 'triage')).toBe(true);
  });

  it('keeps an unapproved chat model out of triage, and triage_chat out of other categories', () => {
    expect(servesCapability(['chat'], 'triage')).toBe(false);
    expect(servesCapability(['triage_chat'], 'chat')).toBe(false);
    expect(servesCapability(null, 'triage')).toBe(false);
  });
});
