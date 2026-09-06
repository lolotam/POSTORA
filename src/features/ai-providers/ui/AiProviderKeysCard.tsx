import { useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { PROVIDERS, type AiProvidersGateway, type KeyStatus, type ProviderCode } from "../application/ports";
import { useAiProviderKeys } from "./useAiProviderKeys";

function ProviderRow({ provider, status, keys }: {
  provider: ProviderCode; status?: KeyStatus; keys: ReturnType<typeof useAiProviderKeys>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [hasKey, setHasKey] = useState(false);
  const busy = keys.isSaving || keys.test.isPending || keys.remove.isPending;
  async function save() {
    const key = input.current?.value.trim();
    if (!key || busy) return;
    try {
      await keys.saveKey(provider, key);
      if (input.current) input.current.value = "";
      setHasKey(false);
    } catch {
      // The hook reports a sanitized error; preserve the input for correction.
    }
  }
  return <section aria-label={PROVIDERS[provider]} className="space-y-3 rounded-lg border p-4">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-medium">{PROVIDERS[provider]}</h3>
      <Badge variant={status?.status === "invalid" ? "destructive" : "secondary"}>
        {!status ? "Not connected" : status.status === "invalid" ? "Invalid — reconnect" : `Connected${status.key_hint ? ` · ends in ••••${status.key_hint.slice(-4)}` : ""}`}
      </Badge>
    </div>
    {status?.last_verified_at && <p className="text-xs text-muted-foreground">Last verified: {new Date(status.last_verified_at).toLocaleString()}</p>}
    <div className="flex flex-col gap-2 sm:flex-row">
      <Input ref={input} type="password" aria-label={`${PROVIDERS[provider]} API key`} autoComplete="new-password" placeholder="Enter API key" disabled={busy} onChange={event => setHasKey(!!event.target.value.trim())} />
      <Button disabled={!hasKey || busy} onClick={() => void save()}>Save</Button>
      {status && <>
        <Button variant="outline" disabled={busy} onClick={() => keys.test.mutate(provider)}>Test</Button>
        <AlertDialog>
          <AlertDialogTrigger asChild><Button variant="outline" disabled={busy}>Remove</Button></AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {PROVIDERS[provider]} key?</AlertDialogTitle>
              <AlertDialogDescription>Requests using only this key will stop working. Your routing preferences will stay in place.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={busy} onClick={() => keys.remove.mutate(provider)}>Remove key</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>}
    </div>
  </section>;
}

export function AiProviderKeysCard({ gateway, userId }: { gateway: AiProvidersGateway; userId: string }) {
  const keys = useAiProviderKeys(gateway, userId);
  return <Card>
    <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" aria-hidden="true" />Your AI keys</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {keys.isPending ? <Skeleton className="h-40" aria-label="Loading AI keys" /> : keys.isError ?
        <div role="alert">Could not load your AI keys. <Button variant="outline" onClick={() => void keys.refetch()}>Retry</Button></div> :
        (Object.keys(PROVIDERS) as ProviderCode[]).map(provider => <ProviderRow key={provider} provider={provider} status={keys.data?.find(row => row.provider_code === provider)} keys={keys} />)}
    </CardContent>
  </Card>;
}
