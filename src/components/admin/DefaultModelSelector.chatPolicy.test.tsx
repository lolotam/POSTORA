import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { DefaultModelSelector } from './DefaultModelSelector';
import type { ChatListGroup, ChatListPolicy } from '@/features/ai-providers/infrastructure/chatListGateway';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: vi.fn(async () => ({ data: { enabled: false, providers: [] }, error: null })) } } }));
vi.mock('@/hooks/useOpenRouterModels', () => ({ useOpenRouterModels: () => ({ data: [] }), extractSeries: () => '', formatPrice: () => '' }));

const group = (auth_method: 'api_key' | 'oauth', reason: ChatListGroup['reason'] = null) => ({
  provider_code: 'claude', auth_method, name: auth_method === 'oauth' ? 'Claude subscription' : 'Claude', reason,
  synced_at: null, models: [{ model_id: 'same', name: 'Same', provisional: auth_method === 'oauth', reason: null }],
});

function renderPolicy(policy: ChatListPolicy, extra: Record<string, unknown> = {}) {
  const save = vi.fn();
  render(<QueryClientProvider client={new QueryClient()}><DefaultModelSelector
    category="chat" capability="chat" title="Chat Models" description="" icon={Bot}
    providers={[]} models={[]} currentDefault={{ provider_code: 'claude', model_id: 'same', auth_method: 'oauth' }}
    currentFallback={null} currentFallback2={null} onSetDefault={save} onSetFallback={save} onSetFallback2={save}
    textListPolicy={policy} {...extra}
  /></QueryClientProvider>);
  return save;
}

describe('flagged Chat selector', () => {
  it('shows explicit API/Auth groups in all three slots and saves only an eligible model, with group identity', () => {
    const save = renderPolicy({ enabled: true, groups: [group('api_key'), group('oauth')] });
    expect(screen.getAllByRole('group', { name: 'API' })).toHaveLength(3);
    expect(screen.getAllByRole('group', { name: 'Auth' })).toHaveLength(3);
    const provider = screen.getByRole('combobox', { name: 'Primary provider' });
    fireEvent.change(provider, { target: { value: JSON.stringify(['claude', 'api_key']) } });
    expect(save).not.toHaveBeenCalled();
    const model = screen.getByRole('combobox', { name: 'Primary model' });
    expect(model).toHaveValue('');
    fireEvent.change(model, { target: { value: 'same' } });
    expect(save).toHaveBeenCalledWith('claude', 'same', undefined);
    expect(screen.getByText('Auth · claude · same')).toBeInTheDocument();
  });

  it.each([
    ['not_connected', 'Connect a subscription in AI Providers.'],
    ['flag_off', 'Subscription calls disabled.'],
    ['inactive', 'Provider inactive.'],
    ['reauth_required', 'Reauthentication required.'],
    ['disconnected', 'Subscription disconnected.'],
    ['no_compatible_models', 'No compatible Chat models. Sync the catalogue in AI Providers.'],
  ])('keeps unavailable saved Auth values and explains %s without hover', (reason, message) => {
    renderPolicy({ enabled: true, groups: [group('api_key'), group('oauth', reason as ChatListGroup['reason'])] });
    expect(screen.getByText('Auth · claude · same')).toBeInTheDocument();
    expect(screen.getAllByText(message).length).toBeGreaterThan(0);
    expect(screen.getByRole('combobox', { name: 'Primary model' })).toBeDisabled();
  });

  it('disables keyless API choices, inactive models and both pickers while saving', () => {
    renderPolicy({ enabled: true, groups: [group('api_key', 'api_key_absent'), group('oauth')] } as ChatListPolicy, { isSaving: true });
    expect(within(screen.getAllByRole('group', { name: 'API' })[0]).getByRole('option')).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Primary provider' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Primary model' })).toBeDisabled();
    expect(screen.getAllByText(/API key required/).length).toBeGreaterThan(0);
  });
});
