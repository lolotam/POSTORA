import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { PARTNER_SCOPES, useCreatePartnerKey, usePartnerKeyTargets, type PartnerEnvironment } from "@/features/partner-hub";
import { Loader2 } from "lucide-react";
import { PartnerKeyCreatedView, type CreatedKeyDisplay } from "./PartnerKeyCreatedView";

interface GeneratePartnerKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const SELECT_CLASS = "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

export function GeneratePartnerKeyDialog({ open, onOpenChange }: GeneratePartnerKeyDialogProps) {
  const { toast } = useToast();
  const targets = usePartnerKeyTargets(open);
  const create = useCreatePartnerKey();

  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [environment, setEnvironment] = useState<PartnerEnvironment>("production");
  const [scopes, setScopes] = useState<string[]>([]);
  const [quota, setQuota] = useState("");
  const [rateLimit, setRateLimit] = useState("60");
  const [created, setCreated] = useState<CreatedKeyDisplay | null>(null);
  /** Set when the dialog closes, so a mint that resolves afterwards is dropped. */
  const abandoned = useRef(false);

  const workspaces = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of targets.data ?? []) seen.set(t.workspace_id, t.workspace_name);
    return [...seen.entries()];
  }, [targets.data]);
  const accounts = useMemo(() => (targets.data ?? []).filter((t) => t.workspace_id === workspaceId), [targets.data, workspaceId]);

  const quotaValue = quota.trim() === "" ? null : Number(quota);
  const rateValue = Number(rateLimit);
  const quotaValid = quotaValue === null || (Number.isInteger(quotaValue) && quotaValue >= 0 && quotaValue <= 2_147_483_647);
  const rateValid = Number.isInteger(rateValue) && rateValue >= 1 && rateValue <= 100_000;
  const canSubmit = name.trim().length > 0 && workspaceId !== "" && accountId !== "" && scopes.length > 0 && quotaValid && rateValid && !create.isPending;

  const reset = () => {
    setName(""); setWorkspaceId(""); setAccountId(""); setEnvironment("production");
    setScopes([]); setQuota(""); setRateLimit("60"); setCreated(null);
  };

  const close = (next: boolean) => {
    if (!next) {
      // The plaintext leaves memory with the dialog. This component stays
      // mounted for the page's lifetime — only DialogContent unmounts — so
      // clearing state is not enough: a mint still in flight would call
      // setCreated after the close and re-display the key on the next open.
      abandoned.current = true;
      reset();
      create.reset(); // the mutation cache holds the plaintext too
    }
    onOpenChange(next);
  };

  const submit = async () => {
    abandoned.current = false;
    try {
      const result = await create.mutateAsync({
        name: name.trim(), workspaceId, socialAccountId: accountId, environment, scopes,
        monthlyQuota: quotaValue, rateLimitPerMin: rateValue,
      });
      if (abandoned.current) {
        // The key exists, but the dialog that minted it is gone. Showing it
        // later would break the "once, and only here" contract, so it is
        // dropped and the admin is told to revoke it (spec D5, §7).
        create.reset();
        toast({
          title: "Key created but not shown",
          description: `The dialog closed before "${name.trim()}" could be displayed. Revoke it in the table and generate a new one.`,
          variant: "destructive",
        });
        return;
      }
      setCreated({
        name: name.trim(), environment, key: result.key, prefix: result.prefix, scopes,
        workspaceId, socialAccountId: accountId, createdAt: result.createdAt,
      });
    } catch (err) {
      toast({ title: "Key not created", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const toggleScope = (scope: string, on: boolean) =>
    setScopes((prev) => (on ? [...new Set([...prev, scope])] : prev.filter((s) => s !== scope)));

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{created ? "Partner key created" : "Generate partner key"}</DialogTitle>
          <DialogDescription>
            {created ? "Hand this to the partner over a secure channel." : "The key is generated in this browser; Postora stores only its hash."}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <PartnerKeyCreatedView created={created} onDone={() => close(false)} />
        ) : (
          <div className="space-y-4">
            {targets.error && (
              <p className="text-sm text-destructive">
                Could not load workspaces and accounts: {(targets.error as Error).message}
              </p>
            )}
            <div className="space-y-1">
              <Label htmlFor="pk-name">Name</Label>
              <Input id="pk-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Danat backend" />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pk-workspace">Workspace</Label>
                <select id="pk-workspace" className={SELECT_CLASS} value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setAccountId(""); }}>
                  <option value="">{targets.isLoading ? "Loading…" : "Select a workspace"}</option>
                  {workspaces.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="pk-account">Account (WhatsApp)</Label>
                <select id="pk-account" className={SELECT_CLASS} value={accountId} onChange={(e) => setAccountId(e.target.value)} disabled={workspaceId === ""}>
                  <option value="">Select an account</option>
                  {accounts.map((a) => {
                    const healthy = a.is_active && !a.needs_reauth;
                    const suffix = !a.is_active ? " (inactive)" : a.needs_reauth ? " (needs re-authorization)" : "";
                    return <option key={a.social_account_id} value={a.social_account_id} disabled={!healthy}>{a.platform_username ?? a.social_account_id}{suffix}</option>;
                  })}
                </select>
              </div>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">Environment</legend>
              <div className="flex gap-4">
                {(["production", "staging"] as const).map((env) => (
                  <label key={env} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="pk-env" value={env} checked={environment === env} onChange={() => setEnvironment(env)} aria-label={env} />
                    {env} <span className="font-mono text-xs text-muted-foreground">{env === "production" ? "pk_live_" : "pk_test_"}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Scopes</legend>
              <div className="grid gap-2 md:grid-cols-2">
                {PARTNER_SCOPES.map((scope) => (
                  <div key={scope.value} className="flex items-start gap-2">
                    <Checkbox id={`pk-scope-${scope.value}`} checked={scopes.includes(scope.value)} onCheckedChange={(v) => toggleScope(scope.value, v === true)} aria-label={scope.value} />
                    <div className="leading-tight">
                      <Label htmlFor={`pk-scope-${scope.value}`} className="font-mono text-xs">{scope.value}</Label>
                      <p className="text-xs text-muted-foreground">{scope.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="pk-quota">Monthly quota (blank = unlimited)</Label>
                <Input id="pk-quota" inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} placeholder="e.g. 5000" />
                {!quotaValid && <p className="text-xs text-destructive">Must be a whole number ≥ 0.</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor="pk-rate">Rate limit per minute</Label>
                <Input id="pk-rate" inputMode="numeric" value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} />
                {!rateValid && <p className="text-xs text-destructive">Must be a whole number ≥ 1.</p>}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => close(false)}>Cancel</Button>
              <Button type="button" onClick={submit} disabled={!canSubmit}>
                {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Generate key
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
