import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AdminAiAgentSection } from '../AdminAiAgentSection';

// vi.mock factories are hoisted above imports, so mocks referenced inside them
// must be created with vi.hoisted rather than a plain const declared alongside.
const { toast, setEnabled } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  setEnabled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('sonner', () => ({ toast }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: vi.fn().mockResolvedValue({ data: { data: [] }, error: null }) },
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
    from: vi.fn(),
  },
}));

const emptyCategory = {
  chat: null, image: null, tts: null, video: null, search: null, stt: null,
  agent: null, embedding: null, agent_triage: null,
};

vi.mock('@/hooks/useAIConfiguration', () => ({
  useAIConfiguration: () => ({
    data: {
      providers: [
        {
          id: 'prov-openrouter', provider_code: 'openrouter', name: 'OpenRouter',
          api_endpoint: '', api_key_env_var: '', api_type: '', supports_streaming: true, is_active: true,
        },
      ],
      models: [
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
      ],
      settings: [],
      defaultModel: null,
      categoryDefaults: emptyCategory,
      categoryFallbacks: emptyCategory,
      categoryFallbacks2: emptyCategory,
    },
  }),
  useSetDefaultModel: () => ({ mutate: vi.fn(), isPending: false }),
  useSetFallbackModel: () => ({ mutate: vi.fn(), isPending: false }),
  useSetFallback2Model: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/ai-config/useAgentTriageEnabled', () => ({
  useAgentTriageEnabled: () => ({ enabled: false, setEnabled, isSaving: false }),
}));

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);

describe('AdminAiAgentSection', () => {
  it('renders the reply triage switch and model picker', () => {
    render(wrap(<AdminAiAgentSection />));
    expect(screen.getByText(/Reply triage \(Jev\)/i)).toBeInTheDocument();
  });

  it('turns the triage switch on', () => {
    render(wrap(<AdminAiAgentSection />));
    fireEvent.click(screen.getByRole('switch', { name: /triage/i }));
    expect(setEnabled).toHaveBeenCalledWith(true);
  });
});
