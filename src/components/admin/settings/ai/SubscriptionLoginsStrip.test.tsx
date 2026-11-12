import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubscriptionLoginsStrip } from './SubscriptionLoginsStrip';

const h = vi.hoisted(() => ({
  caps: undefined as { enabled: boolean; providers: Array<Record<string, unknown>> } | undefined,
}));

vi.mock('@/hooks/ai-config/useAiProviderAuth', () => ({
  useAiProviderAuthCapabilities: () => ({ data: h.caps }),
}));

const claude = {
  provider_code: 'claude',
  oauth_provider: 'anthropic',
  name: 'Anthropic (Claude)',
  active: true,
  status: 'connected',
  account_label: 'me@example.com',
  expires_at: null,
  models: [],
};
const chatgpt = { ...claude, provider_code: 'openai', oauth_provider: 'openai-codex', name: 'OpenAI', status: 'not_connected', account_label: null };

describe('SubscriptionLoginsStrip', () => {
  beforeEach(() => {
    h.caps = { enabled: true, providers: [claude, chatgpt] };
  });

  it('shows each subscription with its state and opens that provider on click', () => {
    const onOpen = vi.fn();
    render(<SubscriptionLoginsStrip onOpen={onOpen} />);

    expect(screen.getByText('me@example.com')).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(onOpen).toHaveBeenCalledWith('openai');
  });

  it.each([
    ['the feature is off and nothing is stored', { enabled: false, providers: [chatgpt] }],
    ['the capabilities request failed', undefined],
  ])('renders nothing when %s', (_scenario, caps) => {
    h.caps = caps;
    const { container } = render(<SubscriptionLoginsStrip onOpen={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps a stored login reachable while the feature is off', () => {
    h.caps = { enabled: false, providers: [claude, chatgpt] };
    render(<SubscriptionLoginsStrip onOpen={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Manage' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();
  });
});
