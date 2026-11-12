import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AiProvidersCard } from './AiProvidersCard';

// The card reads the provider catalogue and the key status from the network,
// so the boundary is the supabase client.
const { invoke, tables } = vi.hoisted(() => ({
  invoke: vi.fn(),
  tables: {
    ai_providers: [] as unknown[],
    ai_models: [] as unknown[],
    system_settings: [] as unknown[],
  },
}));

vi.mock('@/integrations/supabase/client', () => {
  const builder = (table: string) => {
    const value = { data: tables[table as keyof typeof tables] ?? [], error: null };
    const chain = {
      select: () => chain,
      or: () => Promise.resolve(value),
      order: () => Promise.resolve(value),
    };
    return chain;
  };
  return {
    supabase: {
      auth: { getSession: async () => ({ data: { session: { user: { id: 'admin-1' } } } }) },
      from: builder,
      functions: { invoke },
    },
  };
});

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const claudeProvider = {
  id: 'prov-claude',
  provider_code: 'claude',
  name: 'Anthropic API',
  api_endpoint: 'https://api.anthropic.com/v1',
  api_key_env_var: 'ANTHROPIC_API_KEY',
  api_type: 'anthropic',
  supports_streaming: true,
  is_active: true,
};

const openaiProvider = {
  id: 'prov-openai',
  provider_code: 'openai',
  name: 'OpenAI',
  api_endpoint: 'https://api.openai.com/v1',
  api_key_env_var: 'OPENAI_API_KEY',
  api_type: 'openai',
  supports_streaming: true,
  is_active: true,
};

const claudeModel = (id: string, modelId: string, name: string) => ({
  id,
  provider_id: 'prov-claude',
  model_id: modelId,
  name,
  description: null,
  capabilities: ['chat'],
  context_limit: null,
  is_active: true,
  cost_per_1m_input_tokens: null,
  cost_per_1m_output_tokens: null,
  ai_providers: { provider_code: 'claude', name: 'Anthropic API' },
});

/** The subscription the admin connected: Anthropic, with an API key of its own. */
const claudeCapability = {
  provider_code: 'claude',
  oauth_provider: 'anthropic',
  name: 'Anthropic (Claude)',
  active: true,
  status: 'connected',
  account_label: 'me@example.com',
  expires_at: '2026-12-01T00:00:00.000Z',
  models: ['claude-sonnet-4-5'],
  has_api_key: false,
};

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AiProvidersCard />
    </QueryClientProvider>,
  );
}

async function openClaudeDialog() {
  fireEvent.click(screen.getByRole('heading', { name: 'Anthropic API' }));
  return screen.findByRole('dialog');
}

describe('AiProvidersCard', () => {
  beforeEach(() => {
    invoke.mockReset();
    tables.ai_providers = [claudeProvider, openaiProvider];
    tables.ai_models = [
      claudeModel('m-1', 'claude-sonnet-4-5', 'Claude Sonnet 4.5'),
      claudeModel('m-2', 'claude-haiku-4-5', 'Claude Haiku 4.5'),
    ];
    tables.system_settings = [];
    invoke.mockImplementation(async (fn: string, args: { body: Record<string, unknown> }) => {
      if (fn === 'ai-provider-auth') {
        return { data: { enabled: true, providers: [claudeCapability] }, error: null };
      }
      if (args?.body?.action === 'check-service-key') {
        // Neither provider has an API key of its own.
        return { data: { has_key: false }, error: null };
      }
      return { data: {}, error: null };
    });
  });

  it('shows a subscription-connected provider as an auth provider, not as a missing API key', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('Anthropic API')).toBeInTheDocument());

    // Only the provider with a connected subscription carries the auth badge.
    await waitFor(() => expect(screen.getAllByText('auth')).toHaveLength(1));
  });

  it('offers the same models in the picker as the list next to it', async () => {
    renderCard();
    await waitFor(() => expect(screen.getByText('Anthropic API')).toBeInTheDocument());

    const dialog = await openClaudeDialog();
    // The list under the picker names every catalogue row.
    expect(within(dialog).getByText('Claude Haiku 4.5')).toBeInTheDocument();
    expect(within(dialog).getByText('Claude Sonnet 4.5')).toBeInTheDocument();

    const modelTrigger = within(dialog).getByRole('combobox');
    fireEvent.pointerDown(modelTrigger, { button: 0, buttons: 1, pointerType: 'mouse' });
    fireEvent.click(modelTrigger);

    // The picker offers exactly those rows, including the one the
    // subscription's own model list does not name.
    const options = await screen.findAllByRole('option');
    expect(options.map(option => option.textContent).sort()).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-5',
    ]);
  });
});
