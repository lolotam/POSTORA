import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TryVoice } from '../AiCategoryCards';

const invoke = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

describe('TryVoice', () => {
  it('sends the text and renders an audio player on success', async () => {
    invoke.mockResolvedValue({ data: { audio: 'AAAA', mediaType: 'audio/mpeg' }, error: null });
    render(<TryVoice />);
    fireEvent.change(screen.getByLabelText('Preview text'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try voice' }));
    await waitFor(() => expect(screen.getByTestId('tts-preview')).toHaveAttribute('src', 'data:audio/mpeg;base64,AAAA'));
    expect(invoke).toHaveBeenCalledWith('generate-speech', { body: { text: 'hello' } });
  });

  it('shows the server error', async () => {
    invoke.mockResolvedValue({ data: { error: 'No Vercel TTS model selected in Text to Speech settings' }, error: null });
    render(<TryVoice />);
    fireEvent.change(screen.getByLabelText('Preview text'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try voice' }));
    expect(await screen.findByText(/No Vercel TTS model selected/)).toBeInTheDocument();
  });
});
