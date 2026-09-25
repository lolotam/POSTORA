import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchableModelPicker } from '../SearchableModelPicker';

const m = (model_id: string, name = model_id, metadata: Record<string, unknown> = {}) =>
  ({ id: model_id, model_id, name, metadata, is_active: true, capabilities: ['chat'], provider_id: 'p' }) as never;

describe('SearchableModelPicker', () => {
  const models = [m('openai/gpt-5.5', 'GPT-5.5'), m('anthropic/claude-sonnet-5', 'Claude Sonnet 5'), m('bad/embed', 'Bad', {})];
  it('groups by vendor prefix and filters by search', () => {
    render(<SearchableModelPicker models={models} value="" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search models...'), { target: { value: 'sonnet' } });
    expect(screen.queryByText('GPT-5.5')).not.toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 5')).toBeInTheDocument();
  });
  it('does not select a model that has a disable note', () => {
    const onSelect = vi.fn();
    render(<SearchableModelPicker models={models} value="" onSelect={onSelect} modelNote={(x) => (x.model_id === 'bad/embed' ? 'unknown vector width' : null)} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Bad'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText('unknown vector width')).toBeInTheDocument();
  });
});
