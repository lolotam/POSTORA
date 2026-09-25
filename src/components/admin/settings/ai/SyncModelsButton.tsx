import { RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useSyncModels } from '@/hooks/ai-config/useSyncModels';

// lastSyncedAt comes from the `model_catalog_synced_at_<code>` row that the
// ai-config `list` action already returns in `settings` (it selects system_settings
// LIKE 'default_ai_model%'). That filter is widened so this row is included too:
// `.or('key.like.default_ai_model%,key.like.model_catalog_synced_at_%')`.
export function SyncModelsButton({ providerCode, lastSyncedAt }: { providerCode: string; lastSyncedAt?: string | null }) {
  const sync = useSyncModels();
  const run = () => sync.mutate({ provider_code: providerCode }, {
    onSuccess: (r) => toast.success(`Synced: ${r.added} added, ${r.updated} updated, ${r.deactivated} deactivated, ${r.kept_in_use.length} kept (in use)`),
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground">
        {lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}` : 'Never synced'}
      </span>
      <Button size="sm" variant="outline" onClick={run} disabled={sync.isPending} className="gap-1">
        {sync.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        Sync models
      </Button>
    </div>
  );
}
