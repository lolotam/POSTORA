import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  connectionFailureMessage,
  finalizeConnection,
  initiateConnection,
  openAuthorisationTab,
  useConnectionFinalizer,
} from "@/features/connectors";
import { YOUTUBE_COMPOSIO_UNSUPPORTED_OPTION_KEYS } from "@/lib/youtubeComposioOptions";

const STORAGE_KEY = "postora.youtubeConnectMethod";
type ConnectMethod = "native" | "composio";

export function requestYouTubeConnection(
  composioEnabled: boolean,
  startNative: () => void,
  showDialog: () => void,
): void {
  if (composioEnabled) showDialog();
  else startNative();
}

interface YouTubeConnectMethodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  /** The profile tab the connected channel should appear on. */
  socialProfileId: string | null;
  onNativeConnect: () => void;
  /** Called once the channel is connected and homed on the profile. */
  onConnected?: () => void;
  initiateConnectionFn?: typeof initiateConnection;
  finalizeConnectionFn?: typeof finalizeConnection;
  navigate?: (url: string) => void;
}

function rememberedMethod(): ConnectMethod {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === "composio" ? "composio" : "native";
}

export function YouTubeConnectMethodDialog({
  open,
  onOpenChange,
  workspaceId,
  socialProfileId,
  onNativeConnect,
  onConnected,
  initiateConnectionFn = initiateConnection,
  finalizeConnectionFn = finalizeConnection,
  navigate = (url) => window.location.assign(url),
}: YouTubeConnectMethodDialogProps) {
  const composioEnabled =
    import.meta.env.VITE_COMPOSIO_YOUTUBE_ENABLED === "true";
  const [method, setMethod] = useState<ConnectMethod>(rememberedMethod);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingConnectionId, setPendingConnectionId] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setMethod(rememberedMethod());
      setError(null);
    } else {
      setPendingConnectionId(null);
    }
  }, [open]);

  const finalizer = useConnectionFinalizer({
    connectionId: pendingConnectionId,
    socialProfileId,
    finalize: finalizeConnectionFn,
    onActive: () => {
      setPendingConnectionId(null);
      setBusy(false);
      onConnected?.();
      onOpenChange(false);
    },
    onFailed: (code) => {
      setPendingConnectionId(null);
      setBusy(false);
      setError(connectionFailureMessage(code, "YouTube"));
    },
  });
  const waiting = finalizer.status === "waiting";

  if (!composioEnabled) return null;

  const continueConnection = async () => {
    localStorage.setItem(STORAGE_KEY, method);
    if (method === "native") {
      onOpenChange(false);
      onNativeConnect();
      return;
    }
    if (!workspaceId) {
      setError("A workspace is required to connect through Composio.");
      return;
    }
    // Opened inside the click so popup blockers allow it; Composio's page
    // loads there while this dialog polls for the outcome.
    const authorisationTab = openAuthorisationTab();
    setBusy(true);
    setError(null);
    try {
      const connected = await initiateConnectionFn({
        connector_type: "youtube",
        workspace_id: workspaceId,
        ...(socialProfileId ? { social_profile_id: socialProfileId } : {}),
      });
      setPendingConnectionId(connected.connection_id);
      if (authorisationTab) authorisationTab.location.href = connected.redirect_url;
      else navigate(connected.redirect_url);
    } catch (cause) {
      authorisationTab?.close();
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not start the connection.",
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose how to connect YouTube</DialogTitle>
          <DialogDescription>
            Select the authorization provider for this channel.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={method}
          onValueChange={(value) => setMethod(value as ConnectMethod)}
          className="space-y-3"
          disabled={waiting}
        >
          <div className="flex items-start gap-3 rounded-lg border p-3">
            <RadioGroupItem id="youtube-native" value="native" />
            <Label
              htmlFor="youtube-native"
              className="space-y-1 cursor-pointer"
            >
              <span className="block font-medium">Direct Google OAuth</span>
              <span className="block text-sm font-normal text-muted-foreground">
                Postora&apos;s own Google app; full option support
              </span>
            </Label>
          </div>
          <div className="flex items-start gap-3 rounded-lg border p-3">
            <RadioGroupItem id="youtube-composio" value="composio" />
            <Label
              htmlFor="youtube-composio"
              className="space-y-1 cursor-pointer"
            >
              <span className="block font-medium">Composio Managed</span>
              <span className="block text-sm font-normal text-muted-foreground">
                Composio&apos;s managed OAuth; some upload options unavailable —
                see the list
              </span>
            </Label>
          </div>
        </RadioGroup>
        <p className="text-xs text-muted-foreground">
          Unavailable with Composio:{" "}
          {YOUTUBE_COMPOSIO_UNSUPPORTED_OPTION_KEYS.join(", ")}.
        </p>
        {waiting && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Waiting for authorisation — finish signing in on the Composio tab; this dialog closes by itself.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {waiting ? (
            <Button variant="outline" onClick={() => { setPendingConnectionId(null); setBusy(false); }}>
              Cancel
            </Button>
          ) : (
            <Button onClick={continueConnection} disabled={busy}>
              {busy ? "Connecting…" : "Continue"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
