import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useProviderHealthStatus, useRunProviderHealth } from '@/hooks/ai-config/useAiProviderHealth';
import type { ProviderHealthSkipped } from '@/hooks/ai-config/useAiProviderHealth';
import type { ProviderHealthRow } from '@/hooks/ai-config/types';

/**
 * The one button: it tests every configured provider and syncs the catalogue of the
 * ones that answer. The target list comes from the server, so the button needs no
 * props and never drifts from what the run actually does.
 *
 * The table shows the stored result of the last run, so the admin sees the last known
 * state before clicking anything.
 *
 * A run that could not cover every provider says so. The summary of a partial run
 * would otherwise read like a finished check and hide the providers nobody looked at.
 */
export function ProviderHealthButton() {
  const { t } = useTranslation(['adminai']);
  const { data: storedRows } = useProviderHealthStatus();
  const { run, isRunning, error } = useRunProviderHealth();
  const [rows, setRows] = useState<ProviderHealthRow[]>([]);
  const [summary, setSummary] = useState<string | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  const [skipped, setSkipped] = useState<ProviderHealthSkipped[]>([]);

  // The stored rows are the last known state; a run replaces them.
  useEffect(() => {
    if (storedRows && storedRows.length > 0) setRows(storedRows);
  }, [storedRows]);

  useEffect(() => {
    if (!error) return;
    if (error === 'busy') {
      toast.error(t('adminai:busy', 'The daily check is running. Try again in a few minutes.'));
      return;
    }
    toast.error(t('adminai:runFailed', 'The check could not be completed: {{message}}', { message: error }));
  }, [error, t]);

  const onRun = async () => {
    if (isRunning) return;
    setSummary(null);
    setIncomplete(false);
    setSkipped([]);
    const result = await run();
    setSkipped(result.skipped);
    if (result.rows.length === 0 && result.skipped.length === 0) return;
    if (result.rows.length > 0) setRows(result.rows);
    const connected = result.rows.filter((r) => r.status === 'connected').length;
    const failed = result.rows.filter((r) => r.status === 'failed').length;
    const needsRelogin = result.rows.filter((r) => r.status === 'needs_relogin').length;
    setSummary(
      t('adminai:summary', '{{total}} providers checked · {{connected}} connected · {{failed}} failed', {
        total: result.rows.length,
        connected,
        failed: failed + needsRelogin,
      }),
    );
    if (!result.complete) {
      // The run did not cover every provider. A target that was skipped was not
      // tested, so the run is not a finished check.
      setIncomplete(true);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={onRun} disabled={isRunning} className="gap-1">
          {isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          {isRunning ? t('adminai:running', 'Checking providers…') : t('adminai:checkAndSyncAll', 'Check & sync all providers')}
        </Button>
        {summary && <span className="text-[10px] text-muted-foreground">{summary}</span>}
      </div>

      {incomplete && (
        <p className="text-[10px] text-destructive" data-testid="provider-health-incomplete">
          {t('adminai:runIncomplete', 'Some providers were not checked. Run the check again to cover them.')}
        </p>
      )}
      {skipped.length > 0 && (
        <ul className="text-xs text-destructive">
          {skipped.map((target) => (
            <li key={`${target.provider_code}:${target.auth_method}`}>
              {target.provider_code} ({target.auth_method === 'oauth'
                ? t('adminai:credentialOauth', 'Subscription')
                : t('adminai:credentialApiKey', 'API key')}): {target.reason}
            </li>
          ))}
        </ul>
      )}

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('adminai:empty', 'No provider has been checked yet.')}</p>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('adminai:columnProvider', 'Provider')}</TableHead>
                <TableHead>{t('adminai:columnCredential', 'Credential')}</TableHead>
                <TableHead>{t('adminai:columnStatus', 'Status')}</TableHead>
                <TableHead>{t('adminai:columnReason', 'Reason')}</TableHead>
                <TableHead>{t('adminai:columnAdded', 'Added')}</TableHead>
                <TableHead>{t('adminai:columnUpdated', 'Updated')}</TableHead>
                <TableHead>{t('adminai:columnDeactivated', 'Switched off')}</TableHead>
                <TableHead>{t('adminai:columnChecked', 'Checked')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.provider_code}:${row.auth_method}`} data-testid="provider-health-row">
                  <TableCell className="font-medium">{row.display_name || row.provider_code}</TableCell>
                  <TableCell>
                    {row.auth_method === 'oauth'
                      ? t('adminai:credentialOauth', 'Subscription')
                      : t('adminai:credentialApiKey', 'API key')}
                  </TableCell>
                  <TableCell>{statusLabel(row, t)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{row.reason ?? '—'}</TableCell>
                  {/* A provider that was not synced has no count at all — never a zero. */}
                  <TableCell>{countLabel(row.models_added)}</TableCell>
                  <TableCell>{countLabel(row.models_updated)}</TableCell>
                  <TableCell>{countLabel(row.models_deactivated)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.checked_at
                      ? t('adminai:lastChecked', 'Last checked {{time}}', {
                          time: new Date(row.checked_at).toLocaleString(),
                        })
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function statusLabel(row: ProviderHealthRow, t: TFunction): string {
  if (row.status === 'connected') return t('adminai:statusConnected', 'Connected');
  if (row.status === 'needs_relogin') return t('adminai:statusNeedsRelogin', 'Needs re-login');
  return t('adminai:statusFailed', 'Failed');
}

function countLabel(count: number | null): string {
  return count === null ? '—' : String(count);
}
