import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiOpenRouterCallbackPanel } from './AiOpenRouterCallback';

const h = vi.hoisted(() => ({ finish: vi.fn() }));

vi.mock('@/hooks/ai-config/useAiProviderAuth', () => ({
  useFinishAiOAuth: () => ({ mutateAsync: h.finish, isPending: false }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CALLBACK_PATH = '/admin/settings/ai/oauth/openrouter/callback';

function renderPanel(strict = false) {
  const ui = (
    <MemoryRouter>
      <AiOpenRouterCallbackPanel />
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{ui}</StrictMode> : ui);
}

describe('AiOpenRouterCallbackPanel', () => {
  beforeEach(() => {
    h.finish.mockReset();
    h.finish.mockResolvedValue({ status: 'connected', account_label: null });
    window.history.pushState({}, '', CALLBACK_PATH);
  });

  it('finishes the sign-in with the address the provider redirected to', async () => {
    window.history.pushState({}, '', `${CALLBACK_PATH}?code=abc&state=xyz`);

    renderPanel();

    await waitFor(() =>
      expect(h.finish).toHaveBeenCalledWith({
        provider: 'openrouter',
        pasted: window.location.href,
      }),
    );
    expect(h.finish).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('OpenRouter is connected.')).toBeInTheDocument();
  });

  it('spends the single-use code once, even when the effect runs twice', async () => {
    window.history.pushState({}, '', `${CALLBACK_PATH}?code=abc&state=xyz`);

    renderPanel(true);

    await waitFor(() => expect(h.finish).toHaveBeenCalledTimes(1));
    expect(h.finish).toHaveBeenCalledTimes(1);
  });

  it('shows an error and finishes nothing when the redirect carries no code', async () => {
    renderPanel();

    expect(await screen.findByText(/no login code/i)).toBeInTheDocument();
    expect(h.finish).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Back to the AI settings/i })).toHaveAttribute(
      'href',
      '/admin/settings?tab=ai',
    );
  });

  it('shows the refusal when the provider rejects the code', async () => {
    window.history.pushState({}, '', `${CALLBACK_PATH}?code=abc&state=xyz`);
    h.finish.mockRejectedValue(new Error('invalid_state'));

    renderPanel();

    expect(await screen.findByText('invalid_state')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to the AI settings/i })).toBeInTheDocument();
  });
});
