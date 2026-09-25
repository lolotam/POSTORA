import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { syncAllProviders, type SyncReport } from '@/hooks/ai-config/useSyncModels';

async function syncOne(provider_code: string): Promise<SyncReport> {
  const { data, error } = await supabase.functions.invoke('ai-config', { body: { action: 'sync-models', provider_code } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data as SyncReport;
}

/**
 * Runs every syncable, active provider's model sync one after another and reports a
 * combined result. A per-provider failure never stops the rest — see `syncAllProviders`.
 */
export function SyncAllButton({ providerCodes }: { providerCodes: readonly string[] }) {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [progressLabel, setProgressLabel] = useState<string | null>(null);

  const run = async () => {
    if (running || providerCodes.length === 0) return;
    setRunning(true);
    const total = providerCodes.length;
    let done = 0;
    const trackedSyncOne = async (code: string): Promise<SyncReport> => {
      done += 1;
      setProgressLabel(`Syncing ${code} (${done}/${total})…`);
      return syncOne(code);
    };

    const results = await syncAllProviders(providerCodes, trackedSyncOne);
    queryClient.invalidateQueries({ queryKey: ['ai-config'] });

    const succeeded = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);
    if (failed.length === 0) {
      const added = succeeded.reduce((sum, r) => sum + (r.report?.added ?? 0), 0);
      const updated = succeeded.reduce((sum, r) => sum + (r.report?.updated ?? 0), 0);
      const deactivated = succeeded.reduce((sum, r) => sum + (r.report?.deactivated ?? 0), 0);
      toast.success(`Synced ${total} providers: ${added} added, ${updated} updated, ${deactivated} switched off`);
    } else {
      const failedList = failed.map((r) => `${r.code}: ${r.error}`).join(', ');
      toast.warning(`Synced ${succeeded.length} of ${total}. Failed: ${failedList}`);
    }

    setProgressLabel(null);
    setRunning(false);
  };

  return (
    <div className="flex items-center gap-2">
      {running && progressLabel && (
        <span className="text-[10px] text-muted-foreground">{progressLabel}</span>
      )}
      {/* A sync writes to production and can switch models off, so it is confirmed first. */}
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button size="sm" variant="outline" disabled={running || providerCodes.length === 0} className="gap-1">
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            Sync all
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sync models for {providerCodes.length} providers?</AlertDialogTitle>
            <AlertDialogDescription>
              Each provider's model list is fetched in turn ({providerCodes.join(', ')}). New models are added,
              and models a provider no longer lists are switched off. Models set as a default or fallback are
              never switched off, and a switched-off model can be turned back on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={run}>Sync now</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
