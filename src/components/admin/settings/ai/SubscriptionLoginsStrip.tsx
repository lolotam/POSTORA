import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyRound } from 'lucide-react';
import { useAiProviderAuthCapabilities, type AiOAuthCapabilities } from '@/hooks/ai-config/useAiProviderAuth';

type Capability = AiOAuthCapabilities['providers'][number];

const STATUS_BADGE: Record<Capability['status'], { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'text-primary border-primary/30' },
  reauth_required: { label: 'Reconnect required', className: 'text-destructive border-destructive/30' },
  not_connected: { label: 'Not connected', className: '' },
};

/**
 * The subscription logins, shown on the AI Providers card itself. They used to
 * live only inside each provider's dialog, where the owner could not find them
 * (2026-11-12). The button opens that same dialog; the login flow is unchanged.
 *
 * Follows SubscriptionLoginSection's visibility: hidden while the feature is off,
 * unless a login is already stored and still needs to be seen or removed.
 */
export function SubscriptionLoginsStrip({ onOpen }: { onOpen: (providerCode: Capability['provider_code']) => void }) {
  const { data, isLoading } = useAiProviderAuthCapabilities();
  if (isLoading) {
    return <div className="mb-3 h-9 rounded-md border bg-muted/40 animate-pulse" aria-label="Loading subscription logins" />;
  }
  const visible = (data?.providers ?? []).filter(
    (capability) => data?.enabled || capability.status !== 'not_connected',
  );
  if (visible.length === 0) return null;

  return (
    <div className="mb-3 rounded-md border p-2.5 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <KeyRound className="w-3.5 h-3.5" />
        Subscription logins
      </div>
      <ul className="space-y-1.5">
        {visible.map((capability) => {
          const badge = STATUS_BADGE[capability.status];
          return (
            <li key={capability.provider_code} className="flex items-center justify-between gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium truncate">{capability.name ?? capability.provider_code}</span>
                <Badge variant="outline" className={`text-[10px] ${badge.className}`}>{badge.label}</Badge>
                {capability.status === 'connected' && capability.account_label && (
                  <span className="text-muted-foreground truncate">{capability.account_label}</span>
                )}
              </div>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => onOpen(capability.provider_code)}>
                {capability.status === 'connected' ? 'Manage' : 'Sign in'}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
