import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { toast } from 'sonner';
import { SubscriptionLoginSection } from './SubscriptionLoginSection';

const h = vi.hoisted(() => ({
  caps: { enabled: true, providers: [] as Array<Record<string, unknown>> },
  start: vi.fn(),
  finish: vi.fn(),
  disconnect: vi.fn(),
  test: vi.fn(),
}));

vi.mock('@/hooks/ai-config/useAiProviderAuth', () => ({
  useAiProviderAuthCapabilities: () => ({ data: h.caps }),
  useStartAiOAuth: () => ({ mutateAsync: h.start, isPending: false }),
  useFinishAiOAuth: () => ({ mutateAsync: h.finish, isPending: false }),
  useDisconnectAiOAuth: () => ({ mutateAsync: h.disconnect, isPending: false }),
  useTestAiOAuth: () => ({ mutateAsync: h.test, isPending: false }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const claudeNotConnected = {
  provider_code: 'claude',
  oauth_provider: 'anthropic',
  name: 'Anthropic (Claude)',
  status: 'not_connected',
  account_label: null,
  expires_at: null,
  models: ['claude-sonnet-4-5', 'claude-opus-5'],
};

const claudeConnected = {
  ...claudeNotConnected,
  status: 'connected',
  account_label: 'me@example.com',
  expires_at: '2026-12-01T00:00:00.000Z',
};

describe('SubscriptionLoginSection', () => {
  beforeEach(() => {
    h.caps = { enabled: true, providers: [claudeNotConnected] };
    h.start.mockReset();
    h.finish.mockReset();
    h.disconnect.mockReset();
    h.test.mockReset();
    vi.mocked(toast.error).mockClear();
  });

  it('renders nothing while the feature is disabled', () => {
    h.caps = { enabled: false, providers: [claudeConnected] };
    const { container } = render(<SubscriptionLoginSection providerCode="claude" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens the provider login page in a new tab', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    h.start.mockResolvedValue({ authorize_url: 'https://claude.ai/oauth/authorize?x=1' });

    render(<SubscriptionLoginSection providerCode="claude" />);
    fireEvent.click(screen.getByRole('button', { name: /Open login/i }));

    await waitFor(() => expect(h.start).toHaveBeenCalledWith('anthropic'));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?x=1', '_blank', 'noopener,noreferrer'),
    );
    open.mockRestore();
  });

  it('sends the pasted address and shows the connected account', async () => {
    h.finish.mockResolvedValue({ status: 'connected', account_label: 'me@example.com' });

    const { rerender } = render(<SubscriptionLoginSection providerCode="claude" />);
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'http://localhost:53692/callback?code=c&state=s' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Finish$/i }));

    await waitFor(() =>
      expect(h.finish).toHaveBeenCalledWith({
        provider: 'anthropic',
        pasted: 'http://localhost:53692/callback?code=c&state=s',
      }),
    );

    // The capabilities query reports the new state.
    h.caps = { enabled: true, providers: [claudeConnected] };
    rerender(<SubscriptionLoginSection providerCode="claude" />);
    expect(await screen.findByText(/me@example\.com/)).toBeInTheDocument();
  });

  it('shows the account, a test model picker and a disconnect control once connected', async () => {
    h.caps = { enabled: true, providers: [claudeConnected] };
    h.disconnect.mockResolvedValue(undefined);

    render(<SubscriptionLoginSection providerCode="claude" />);
    expect(screen.getByText(/me@example\.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disconnect/i })).toBeInTheDocument();

    // The test picker lists the models the provider offers, not the api-key catalogue.
    const modelTrigger = screen.getByRole('combobox');
    fireEvent.pointerDown(modelTrigger, { button: 0, buttons: 1, pointerType: 'mouse' });
    fireEvent.click(modelTrigger);
    expect(await screen.findByRole('option', { name: 'claude-sonnet-4-5' })).toBeInTheDocument();
    // Radix marks the rest of the page aria-hidden while a select is open.
    fireEvent.keyDown(document.activeElement ?? modelTrigger, { key: 'Escape' });

    // Disconnecting asks first.
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(h.disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: /Disconnect/i }));
    await waitFor(() => expect(h.disconnect).toHaveBeenCalledWith('anthropic'));
  });

  it('warns about the Claude Code identity prompt for Anthropic only', () => {
    const { unmount } = render(<SubscriptionLoginSection providerCode="claude" />);
    expect(
      screen.getByText("Calls through a Claude subscription are sent with Claude Code's identity prompt prepended."),
    ).toBeInTheDocument();
    unmount();

    render(<SubscriptionLoginSection providerCode="openai" />);
    expect(screen.queryByText(/Claude Code's identity prompt/)).not.toBeInTheDocument();
  });

  it.each([
    ['invalid_state', /expired or was already used/],
    ['SOMETHING_UNKNOWN', /Could not connect the subscription/],
  ])('turns the server code %s into a readable toast', async (code, message) => {
    h.finish.mockRejectedValue(new Error(code));

    render(<SubscriptionLoginSection providerCode="claude" />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'code#state' } });
    fireEvent.click(screen.getByRole('button', { name: /^Finish$/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(message)));
  });

  it('shows a reconnect state when the subscription needs a new login', () => {
    h.caps = { enabled: true, providers: [{ ...claudeConnected, status: 'reauth_required' }] };
    render(<SubscriptionLoginSection providerCode="claude" />);
    expect(screen.getByText('Reconnect required')).toBeInTheDocument();
  });
});
