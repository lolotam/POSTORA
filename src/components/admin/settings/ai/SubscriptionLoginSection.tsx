import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  useAiProviderAuthCapabilities,
  useDisconnectAiOAuth,
  useFinishAiOAuth,
  useStartAiOAuth,
  useTestAiOAuth,
  type OAuthProviderId,
} from '@/hooks/ai-config/useAiProviderAuth';

const OAUTH_PROVIDER_FOR_CODE: Record<'claude' | 'openai' | 'openrouter', OAuthProviderId> = {
  claude: 'anthropic',
  openai: 'openai-codex',
  openrouter: 'openrouter',
};

// The edge function answers with stable codes; the admin reads sentences.
const ERROR_MESSAGES: Record<string, string> = {
  invalid_state: 'This login link expired or was already used. Open the login again.',
  invalid_code: 'The pasted address has no login code. Paste the full address from the new tab.',
  exchange_failed: 'The provider refused the login code. Open the login again.',
  oauth_disabled: 'Subscription login is switched off.',
  not_connected: 'This subscription is not connected.',
  reauth_required: 'The subscription needs a new login.',
  refresh_failed: 'The provider did not renew the login. Try again in a minute.',
  AI_PROVIDER_AUTH_INVALID_RESPONSE: 'The server answered in a shape this page does not understand (AI_PROVIDER_AUTH_INVALID_RESPONSE). Reload the page; if it stays, the web app and the edge function are out of step.',
};

function describeError(error: unknown, fallback: string): string {
  const code = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return ERROR_MESSAGES[code] ?? fallback;
}

/**
 * Subscription login for one provider.
 *
 * The credentials never reach the browser: the edge function keeps them in
 * Vault and answers with a status, an account label and a model list. The
 * admin approves the provider's consent page in a new tab and pastes the
 * address it lands on back here.
 *
 * A provider whose flow is `pkce_callback` redirects to our own route
 * instead: the browser goes there directly and there is nothing to paste.
 */
export function SubscriptionLoginSection({ providerCode }: { providerCode: 'claude' | 'openai' | 'openrouter' }) {
  const { data: capabilities, error: capabilitiesError } = useAiProviderAuthCapabilities();
  const startLogin = useStartAiOAuth();
  const finishLogin = useFinishAiOAuth();
  const disconnect = useDisconnectAiOAuth();
  const testConnection = useTestAiOAuth();

  const [pasted, setPasted] = useState('');
  const [testModel, setTestModel] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);

  const oauthProvider = OAUTH_PROVIDER_FOR_CODE[providerCode];
  const capability = capabilities?.providers.find(p => p.oauth_provider === oauthProvider);
  const connected = capability?.status === 'connected';
  const needsReconnect = capability?.status === 'reauth_required';
  const hasStoredLogin = connected || needsReconnect;
  const enabled = capabilities?.enabled === true;
  const usesCallbackFlow = capability?.flow === 'pkce_callback';
  // With the flag off the subscription pathway is closed, but a stored login
  // must stay visible so the admin can still delete it. A provider the edge
  // function does not offer yet (an older deploy) has no sign-in to show.
  // A failed first read is shown, not hidden: an empty section would look like
  // the login is simply unavailable. A failed background refetch keeps the
  // cached capabilities, so a stored login stays visible and removable.
  if (capabilitiesError && !capabilities) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription>{describeError(capabilitiesError, 'Could not load the subscription logins.')}</AlertDescription>
      </Alert>
    );
  }
  if (!capabilities || !capability || (!enabled && !hasStoredLogin)) return null;

  const effectiveTestModel = testModel || capability?.models?.[0] || '';

  // The URL is shown as a link the admin clicks: a window.open after an await
  // runs outside the click gesture and popup blockers drop it silently.
  const handleStartLogin = async () => {
    try {
      const { authorize_url } = await startLogin.mutateAsync(oauthProvider);
      setAuthorizeUrl(authorize_url);
    } catch (error) {
      toast.error(describeError(error, 'Could not start the login'));
    }
  };

  // A callback flow leaves this page: the provider sends the browser to our
  // own route, which finishes the login on its own.
  const handleStartCallbackLogin = async () => {
    try {
      const { authorize_url } = await startLogin.mutateAsync(oauthProvider);
      window.location.assign(authorize_url);
    } catch (error) {
      toast.error(describeError(error, 'Could not start the login'));
    }
  };

  const handleFinishLogin = async () => {
    if (!pasted.trim()) return;
    try {
      await finishLogin.mutateAsync({ provider: oauthProvider, pasted: pasted.trim() });
      setPasted('');
      setAuthorizeUrl(null);
      toast.success('Subscription connected');
    } catch (error) {
      // The login state is single use: a failed finish has spent it, so the
      // link is dropped and the admin starts a new login.
      setAuthorizeUrl(null);
      toast.error(describeError(error, 'Could not connect the subscription'));
    }
  };

  const handleDisconnect = async () => {
    setConfirmDisconnect(false);
    try {
      await disconnect.mutateAsync(oauthProvider);
      toast.success('Subscription disconnected');
    } catch (error) {
      toast.error(describeError(error, 'Could not disconnect the subscription'));
    }
  };

  const handleTest = async () => {
    if (!effectiveTestModel) return;
    try {
      const result = await testConnection.mutateAsync({ provider: oauthProvider, modelId: effectiveTestModel });
      if (result.ok) toast.success(`Subscription answered in ${result.latency_ms}ms`);
      else toast.error(describeError(result.error, result.error || 'The subscription did not answer'));
    } catch (error) {
      toast.error(describeError(error, 'The test failed'));
    }
  };

  return (
    <div className="space-y-2 p-3 rounded-lg border border-border bg-muted/30">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium">Subscription login (Auth)</span>
        {connected ? (
          <Badge variant="outline" className="text-[10px] text-primary border-primary/30">Connected</Badge>
        ) : needsReconnect ? (
          <Badge variant="outline" className="text-[10px] text-destructive border-destructive/30">Reconnect required</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">Not connected</Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {connected && capability?.account_label
          ? `Connected as ${capability.account_label}${capability.expires_at ? `, expires ${capability.expires_at}` : ''}`
          : connected
            ? `Connected${capability?.expires_at ? `, expires ${capability.expires_at}` : ''}`
            : needsReconnect
              ? 'The stored subscription was rejected. Connect it again.'
              : providerCode === 'openrouter'
                ? 'Sign in with your OpenRouter account instead of an API key.'
                : 'Use a Claude Pro/Max or ChatGPT subscription instead of an API key.'}
      </p>

      {!enabled && (
        <p className="text-xs text-muted-foreground">
          Subscription login is switched off. The stored login is unused until it is switched back on.
        </p>
      )}

      {providerCode === 'claude' && (
        <Alert>
          <AlertTriangle className="h-4 w-4 !text-warning" />
          <AlertDescription className="text-xs">
            Calls through a Claude subscription are sent with Claude Code&apos;s identity prompt prepended.
          </AlertDescription>
        </Alert>
      )}

      {enabled && !connected && (
        usesCallbackFlow ? (
          <>
            <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={handleStartCallbackLogin}
              disabled={startLogin.isPending}>
              {startLogin.isPending ? <Loader2 className="w-3 h-3 animate-spin me-1" /> : null}
              Sign in with {capability?.name ?? 'the provider'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Your browser opens the provider&apos;s consent page and comes back here when it is done.
            </p>
          </>
        ) : (
          <>
            {authorizeUrl ? (
              <Button asChild size="sm" variant="outline" className="w-full h-7 text-xs">
                <a href={authorizeUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="w-3 h-3 me-1" />
                  Open the provider&apos;s login page
                </a>
              </Button>
            ) : (
              <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={handleStartLogin}
                disabled={startLogin.isPending}>
                {startLogin.isPending ? <Loader2 className="w-3 h-3 animate-spin me-1" /> : null}
                Open login
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              After approving, your browser opens a localhost page that does not load. Copy the full address
              from the address bar and paste it here.
            </p>
            <Textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="Paste the address you were redirected to..."
              className="text-xs min-h-[60px]"
              maxLength={4096}
            />
            <Button size="sm" className="w-full h-7 text-xs" onClick={handleFinishLogin}
              disabled={!pasted.trim() || finishLogin.isPending}>
              {finishLogin.isPending ? <Loader2 className="w-3 h-3 animate-spin me-1" /> : null}
              Finish
            </Button>
          </>
        )
      )}

      {enabled && connected && (
        <div className="flex gap-2">
            <Select value={effectiveTestModel} onValueChange={setTestModel} disabled={testConnection.isPending}>
              <SelectTrigger className="w-full text-xs h-7">
                <SelectValue placeholder="Model..." />
              </SelectTrigger>
              <SelectContent>
                {(capability?.models ?? []).map(id => (
                  <SelectItem key={id} value={id}>
                    <span className="text-xs">{id}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[10px]" onClick={handleTest}
              disabled={!effectiveTestModel || testConnection.isPending}>
              {testConnection.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Test
            </Button>
        </div>
      )}

      {hasStoredLogin && (
        <Button size="sm" variant="outline" className="w-full h-7 text-xs" onClick={() => setConfirmDisconnect(true)}>
          Disconnect
        </Button>
      )}

      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect this subscription?</AlertDialogTitle>
            <AlertDialogDescription>
              The stored credentials are deleted. Tiers that use this subscription fall back to the next tier.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
