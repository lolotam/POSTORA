import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { DefaultModelSelector } from './DefaultModelSelector';

// The capabilities come from the ai-provider-auth edge function, so the
// network boundary is the supabase client, not the project's own hook.
const { invoke, caps } = vi.hoisted(() => ({
  invoke: vi.fn(),
  caps: { current: { enabled: false, providers: [] as unknown[] } },
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { functions: { invoke } },
}));

vi.mock('@/hooks/useOpenRouterModels', () => ({
  useOpenRouterModels: () => ({ data: [], isLoading: false }),
  extractSeries: (id: string) => id.split('/')[0] || 'unknown',
  formatPrice: () => 'Free',
}));

const providers = [
  {
    id: 'prov-openai', provider_code: 'openai', name: 'OpenAI',
    api_endpoint: '', api_key_env_var: '', api_type: '', supports_streaming: true, is_active: true,
  },
  {
    id: 'prov-claude', provider_code: 'claude', name: 'Anthropic API',
    api_endpoint: '', api_key_env_var: '', api_type: '', supports_streaming: true, is_active: true,
  },
  {
    id: 'prov-openrouter', provider_code: 'openrouter', name: 'OpenRouter',
    api_endpoint: '', api_key_env_var: '', api_type: '', supports_streaming: true, is_active: true,
  },
] as never;

const models = [
  {
    id: 'model-gpt', provider_id: 'prov-openai', model_id: 'gpt-4o-mini', name: 'GPT-4o mini',
    description: null, capabilities: ['chat', 'image'], context_limit: null, is_active: true,
    cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null,
    ai_providers: { provider_code: 'openai', name: 'OpenAI' },
  },
  {
    id: 'model-sonnet', provider_id: 'prov-claude', model_id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5',
    description: null, capabilities: ['chat', 'image'], context_limit: null, is_active: true,
    cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null,
    ai_providers: { provider_code: 'claude', name: 'Anthropic API' },
  },
  {
    id: 'model-or', provider_id: 'prov-openrouter', model_id: 'openai/gpt-4o-mini', name: 'GPT-4o mini via OpenRouter',
    description: null, capabilities: ['chat', 'image'], context_limit: null, is_active: true,
    cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null,
    ai_providers: { provider_code: 'openrouter', name: 'OpenRouter' },
  },
] as never;

const claudeCapability = {
  provider_code: 'claude',
  oauth_provider: 'anthropic',
  name: 'Anthropic (Claude)',
  active: true,
  status: 'connected',
  account_label: 'me@example.com',
  expires_at: '2026-12-01T00:00:00.000Z',
  models: ['claude-sonnet-4-5', 'claude-opus-5'],
};

const openaiCapability = {
  provider_code: 'openai',
  oauth_provider: 'openai-codex',
  name: 'OpenAI',
  active: true,
  status: 'not_connected',
  account_label: null,
  expires_at: null,
  models: ['gpt-5.2-codex'],
};

const openRouterCapability = {
  provider_code: 'openrouter',
  oauth_provider: 'openrouter',
  name: 'OpenRouter',
  active: true,
  status: 'connected',
  account_label: 'me@example.com',
  expires_at: null,
  models: ['anthropic/claude-sonnet-4.5'],
};

type Category = 'chat' | 'image' | 'agent' | 'agent_triage';

function renderSelector(
  category: Category,
  onSetDefault = vi.fn(),
  currentDefault: unknown = null,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
    <DefaultModelSelector
      category={category}
      capability={category === 'image' ? 'image' : 'chat'}
      title="Chat Models"
      description=""
      icon={Bot}
      providers={providers}
      models={models}
      currentDefault={currentDefault as never}
      currentFallback={null}
      currentFallback2={null}
      onSetDefault={onSetDefault}
      onSetFallback={vi.fn()}
      onSetFallback2={vi.fn()}
    />
    </QueryClientProvider>,
  );
  const primarySection = screen.getByText('Primary').closest('div.space-y-2') as HTMLElement;
  return { primarySection, onSetDefault, queryClient };
}

/** Opens a radix select trigger the same way the sibling selector test does. */
function openSelect(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, buttons: 1, pointerType: 'mouse' });
  fireEvent.click(trigger);
}

async function openProviderDropdown(primarySection: HTMLElement, capabilitiesRequested = true) {
  // Let the capabilities request settle so the Auth group has its answer.
  if (capabilitiesRequested) await waitFor(() => expect(invoke).toHaveBeenCalled());
  await new Promise((resolve) => setTimeout(resolve, 0));
  const providerTrigger = within(primarySection).getByRole('combobox');
  openSelect(providerTrigger);
  await waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(0));
}

async function pickOption(name: RegExp) {
  const option = await waitFor(() => screen.getByRole('option', { name }));
  fireEvent.click(option);
  return option;
}

describe('DefaultModelSelector — provider dropdown groups', () => {
  beforeEach(() => {
    caps.current = { enabled: false, providers: [] };
    invoke.mockReset();
    invoke.mockImplementation(async () => ({ data: caps.current, error: null }));
  });

  it('shows only the API key group while the flag is off', async () => {
    const { primarySection } = renderSelector('chat');
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await openProviderDropdown(primarySection);

    expect(screen.getByText('API key')).toBeInTheDocument();
    expect(screen.queryByText('Auth (subscription)')).not.toBeInTheDocument();
  });

  it('lists a connected subscription under the Auth group and hides a not-connected one', async () => {
    caps.current = { enabled: true, providers: [claudeCapability, openaiCapability] };
    const { primarySection } = renderSelector('chat');
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await openProviderDropdown(primarySection);

    expect(await screen.findByText('Auth (subscription)')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Anthropic \(Claude\) — subscription/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /OpenAI — subscription/ })).not.toBeInTheDocument();
  });

  it('keeps a provider without an API key out of the API key group', async () => {
    // A subscription login is the only way in for this provider, so it belongs
    // to the Auth group alone.
    caps.current = { enabled: true, providers: [{ ...claudeCapability, has_api_key: false }] };
    const { primarySection } = renderSelector('chat');
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await openProviderDropdown(primarySection);

    expect(await screen.findByText('Auth (subscription)')).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^Anthropic API/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Anthropic \(Claude\) — subscription/ })).toBeInTheDocument();
    // A provider that does have a key keeps its place in the API key group.
    expect(screen.getByRole('option', { name: /^OpenAI/ })).toBeInTheDocument();
  });

  it('lists a provider with both a subscription and an API key in both groups', async () => {
    caps.current = { enabled: true, providers: [{ ...claudeCapability, has_api_key: true }] };
    const { primarySection } = renderSelector('chat');
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await openProviderDropdown(primarySection);

    expect(await screen.findByText('Auth (subscription)')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^Anthropic API/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Anthropic \(Claude\) — subscription/ })).toBeInTheDocument();
  });

  it('keeps a provider in the API key group while its key status is unknown', async () => {
    // An older function or a failed request answers without the key status.
    // The provider then stays where it was instead of disappearing.
    caps.current = { enabled: true, providers: [claudeCapability] };
    const { primarySection } = renderSelector('chat');
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await openProviderDropdown(primarySection);

    expect(screen.getByRole('option', { name: /^Anthropic API/ })).toBeInTheDocument();
  });

  it.each<[Category, boolean]>([
    ['agent_triage', true],
    ['agent', false],
    ['image', false],
  ])('in the %s category the Auth group shows: %s', async (category, shown) => {
    caps.current = { enabled: true, providers: [claudeCapability] };
    const { primarySection } = renderSelector(category);
    await openProviderDropdown(primarySection, shown);

    if (shown) expect(await screen.findByText('Auth (subscription)')).toBeInTheDocument();
    else expect(screen.queryByText('Auth (subscription)')).not.toBeInTheDocument();
    // A category no subscription can serve never asks for the capabilities.
    expect(invoke).toHaveBeenCalledTimes(shown ? 1 : 0);
  });

  it.each([
    ['the agent category', 'agent'],
    ['the image category', 'image'],
  ])('keeps a subscription-only provider in the API key group in %s', async (_label, category) => {
    // A category no subscription can serve has no Auth group to move the
    // provider to, so it keeps its API key entry.
    caps.current = { enabled: true, providers: [{ ...claudeCapability, has_api_key: false }] };
    const { primarySection } = renderSelector(category as Category);
    await openProviderDropdown(primarySection, false);

    expect(screen.getByRole('option', { name: /^Anthropic API/ })).toBeInTheDocument();
  });

  it('keeps a provider without a subscription in the API key group', async () => {
    // No subscription means no Auth entry, so the provider stays where it was:
    // a user's own key can still answer for it.
    caps.current = { enabled: true, providers: [{ ...openaiCapability, has_api_key: false }] };
    const { primarySection } = renderSelector('chat');
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await openProviderDropdown(primarySection);

    expect(screen.getByRole('option', { name: /^OpenAI/ })).toBeInTheDocument();
  });

  it('moves a subscription-only OpenRouter into the Auth group', async () => {
    // OpenRouter is the third provider code, so the grouping has to work for
    // it too and not only for the Claude and OpenAI subscriptions.
    caps.current = { enabled: true, providers: [{ ...openRouterCapability, has_api_key: false }] };
    const { primarySection } = renderSelector('chat');
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await openProviderDropdown(primarySection);

    expect(await screen.findByText('Auth (subscription)')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /OpenRouter — subscription/ })).toBeInTheDocument();
    // It must not also sit in the API key group.
    expect(screen.queryByRole('option', { name: /^OpenRouter openrouter/ })).not.toBeInTheDocument();
    // Another provider keeps its API key entry.
    expect(screen.getByRole('option', { name: /^OpenAI/ })).toBeInTheDocument();
  });

  it('lists an OpenRouter with both a subscription and an API key in both groups', async () => {
    caps.current = { enabled: true, providers: [{ ...openRouterCapability, has_api_key: true }] };
    const { primarySection } = renderSelector('chat');
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await openProviderDropdown(primarySection);

    expect(await screen.findByText('Auth (subscription)')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /^OpenRouter openrouter/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /OpenRouter — subscription/ })).toBeInTheDocument();
  });

  it('keeps OpenRouter in the API key group while its key status is unknown', async () => {
    // An older function or a failed request answers without the key status.
    caps.current = { enabled: true, providers: [openRouterCapability] };
    const { primarySection } = renderSelector('chat');
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await openProviderDropdown(primarySection);

    expect(screen.getByRole('option', { name: /^OpenRouter openrouter/ })).toBeInTheDocument();
  });

  it.each([
    ['fails', () => Promise.reject(new Error('network down'))],
    ['is still loading', () => new Promise(() => {})],
  ])('keeps the API key providers when the capabilities request %s', async (_label, answer) => {
    invoke.mockImplementation(answer);
    const { primarySection } = renderSelector('chat');
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    await openProviderDropdown(primarySection);

    expect(screen.getByRole('option', { name: /^OpenAI/ })).toBeInTheDocument();
    expect(screen.queryByText('Auth (subscription)')).not.toBeInTheDocument();
  });

  it('renders a reauth_required provider as a disabled item', async () => {
    caps.current = {
      enabled: true,
      providers: [{ ...claudeCapability, status: 'reauth_required' }],
    };
    const { primarySection } = renderSelector('chat');
    await openProviderDropdown(primarySection);

    const option = screen.getByRole('option', { name: /Anthropic \(Claude\) — subscription/ });
    expect(option).toHaveAttribute('aria-disabled', 'true');
  });

  it('saves the tier as an oauth one when an Auth item and a model are picked', async () => {
    caps.current = { enabled: true, providers: [claudeCapability] };
    const { primarySection, onSetDefault } = renderSelector('chat');
    await openProviderDropdown(primarySection);
    await pickOption(/Anthropic \(Claude\) — subscription/);

    const modelTrigger = await waitFor(() => {
      const triggers = within(primarySection).getAllByRole('combobox');
      expect(triggers.length).toBe(2);
      return triggers[1];
    });
    openSelect(modelTrigger);
    // claude-opus-5 exists only in the subscription's model list, not in ai_models.
    await pickOption(/claude-opus-5/);

    expect(onSetDefault).toHaveBeenCalledWith('claude', 'claude-opus-5', 'oauth');
  });

  it('saves the tier without an auth method when an API key item is picked', async () => {
    caps.current = { enabled: true, providers: [claudeCapability] };
    const { primarySection, onSetDefault } = renderSelector('chat');
    await openProviderDropdown(primarySection);
    await pickOption(/^OpenAI/);

    const modelTrigger = await waitFor(() => {
      const triggers = within(primarySection).getAllByRole('combobox');
      expect(triggers.length).toBe(2);
      return triggers[1];
    });
    openSelect(modelTrigger);
    await pickOption(/GPT-4o mini/);

    expect(onSetDefault).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
    expect(onSetDefault.mock.calls[0][2]).toBeUndefined();
  });

  it('opens on the Auth branch for a tier that was saved as oauth', async () => {
    caps.current = { enabled: true, providers: [claudeCapability] };
    const { primarySection } = renderSelector('chat', vi.fn(), {
      provider_code: 'claude',
      model_id: 'claude-sonnet-4-5',
      auth_method: 'oauth',
    });

    const providerTrigger = within(primarySection).getAllByRole('combobox')[0];
    await waitFor(() => expect(providerTrigger).toHaveTextContent('Anthropic (Claude) — subscription'));
  });

  it.each([
    ['the flag is off', { enabled: false, providers: [claudeCapability] }],
    ['the subscription was disconnected', { enabled: true, providers: [{ ...claudeCapability, status: 'not_connected' }] }],
    ['the admin switched the provider off', { enabled: true, providers: [{ ...claudeCapability, active: false }] }],
  ])('leaves a stored oauth tier unset instead of showing it as an API key tier when %s', async (_label, answer) => {
    caps.current = answer;
    const { primarySection } = renderSelector('chat', vi.fn(), {
      provider_code: 'claude',
      model_id: 'claude-sonnet-4-5',
      auth_method: 'oauth',
    });
    await waitFor(() => expect(invoke).toHaveBeenCalled());

    const triggers = within(primarySection).getAllByRole('combobox');
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).not.toHaveTextContent('Anthropic API');
  });

  it('drops the Auth selection and its model list when the subscription disappears', async () => {
    caps.current = { enabled: true, providers: [claudeCapability] };
    const { primarySection, queryClient } = renderSelector('chat', vi.fn(), {
      provider_code: 'claude',
      model_id: 'claude-sonnet-4-5',
      auth_method: 'oauth',
    });
    await waitFor(() => expect(within(primarySection).getAllByRole('combobox')).toHaveLength(2));

    caps.current = { enabled: true, providers: [{ ...claudeCapability, status: 'not_connected' }] };
    await queryClient.invalidateQueries();

    await waitFor(() => expect(within(primarySection).getAllByRole('combobox')).toHaveLength(1));
    expect(within(primarySection).getByRole('combobox')).not.toHaveTextContent('subscription');
  });

  it('converts an oauth tier back to the API key for the same model', async () => {
    caps.current = { enabled: true, providers: [claudeCapability] };
    const { primarySection, onSetDefault } = renderSelector('chat', vi.fn(), {
      provider_code: 'claude',
      model_id: 'claude-sonnet-4-5',
      auth_method: 'oauth',
    });
    const providerTrigger = within(primarySection).getAllByRole('combobox')[0];
    await waitFor(() => expect(providerTrigger).toHaveTextContent('Anthropic (Claude) — subscription'));

    openSelect(providerTrigger);
    await pickOption(/^Anthropic API/);
    const modelTrigger = within(primarySection).getAllByRole('combobox')[1];
    expect(modelTrigger).toHaveTextContent('Model...');
    openSelect(modelTrigger);
    await pickOption(/Claude Sonnet 4.5/);

    expect(onSetDefault).toHaveBeenCalledWith('claude', 'claude-sonnet-4-5');
    expect(onSetDefault.mock.calls[0][2]).toBeUndefined();
  });

  it('disables the model list of a subscription that needs a reconnect', async () => {
    caps.current = { enabled: true, providers: [{ ...claudeCapability, status: 'reauth_required' }] };
    const { primarySection } = renderSelector('chat', vi.fn(), {
      provider_code: 'claude',
      model_id: 'claude-sonnet-4-5',
      auth_method: 'oauth',
    });

    const modelTrigger = await waitFor(() => {
      const triggers = within(primarySection).getAllByRole('combobox');
      expect(triggers).toHaveLength(2);
      return triggers[1];
    });
    expect(modelTrigger).toBeDisabled();
  });
});
