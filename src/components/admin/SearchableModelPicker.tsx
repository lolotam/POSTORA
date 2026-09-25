import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { AIModel } from '@/hooks/useAIConfiguration';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';

export const LARGE_PROVIDER_THRESHOLD = 25;

const vendorOf = (modelId: string) => (modelId.includes('/') ? modelId.split('/')[0] : 'other');

export function SearchableModelPicker({ models, value, onSelect, disabled, modelNote }: {
  models: AIModel[]; value: string; onSelect: (modelId: string) => void; disabled?: boolean;
  modelNote?: (m: AIModel) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const groups = useMemo(() => {
    const q = search.toLowerCase();
    const byVendor = new Map<string, AIModel[]>();
    for (const m of models) {
      if (q && !m.model_id.toLowerCase().includes(q) && !m.name.toLowerCase().includes(q)) continue;
      const v = vendorOf(m.model_id);
      byVendor.set(v, [...(byVendor.get(v) ?? []), m]);
    }
    return [...byVendor.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models, search]);
  const current = models.find((m) => m.model_id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} disabled={disabled}
          className="w-full justify-between font-normal text-xs h-8">
          <span className="truncate text-xs">{current?.name ?? (value || 'Model...')}</span>
          <ChevronsUpDown className="ms-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search models..." value={search} onValueChange={setSearch} />
          <CommandList className="max-h-[300px]">
            <CommandEmpty>No models found.</CommandEmpty>
            {groups.map(([vendor, items]) => (
              <CommandGroup key={vendor} heading={vendor}>
                {items.map((m) => {
                  const note = modelNote ? modelNote(m) : null;
                  return (
                    <CommandItem key={m.id} value={m.model_id} disabled={note !== null}
                      onSelect={() => { if (note) return; onSelect(m.model_id); setOpen(false); setSearch(''); }}>
                      <Check className={`w-3 h-3 shrink-0 ${value === m.model_id ? 'opacity-100' : 'opacity-0'}`} />
                      <span className="truncate flex-1">{m.name}</span>
                      {note && <span className="text-[10px] text-muted-foreground ms-1.5">{note}</span>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
