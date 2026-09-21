import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, ExternalLink, Info, Shield, Key } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";

interface BlueskyConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnect: (handle: string, appPassword: string) => Promise<void>;
  onOAuthConnect?: (handle: string) => Promise<void>;
  isConnecting: boolean;
}

export function BlueskyConnectDialog({
  open,
  onOpenChange,
  onConnect,
  onOAuthConnect,
  isConnecting,
}: BlueskyConnectDialogProps) {
  const [handle, setHandle] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"oauth" | "app-password">("oauth");

  const handleOAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!handle.trim()) {
      setError("Please enter your Bluesky handle");
      return;
    }

    if (!onOAuthConnect) {
      setError("OAuth is not available");
      return;
    }

    try {
      await onOAuthConnect(handle.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start OAuth");
    }
  };

  const handleAppPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!handle.trim()) {
      setError("Please enter your Bluesky handle");
      return;
    }

    if (!appPassword.trim()) {
      setError("Please enter your app password");
      return;
    }

    try {
      await onConnect(handle.trim(), appPassword.trim());
      // Reset form on success
      setHandle("");
      setAppPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    }
  };

  const handleClose = () => {
    if (!isConnecting) {
      setHandle("");
      setAppPassword("");
      setError("");
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <svg
              viewBox="0 0 600 530"
              className="w-5 h-5"
              fill="currentColor"
            >
              <path d="m135.72 44.03c66.496 49.921 138.02 151.14 164.28 205.46 26.262-54.316 97.782-155.54 164.28-205.46 47.98-36.021 125.72-63.892 125.72 24.795 0 17.712-10.155 148.79-16.111 170.07-20.703 73.984-96.144 92.854-163.25 81.433 117.3 19.964 147.14 86.092 82.697 152.22-122.39 125.59-175.91-31.511-189.63-71.766-2.514-7.3797-3.6904-10.832-3.7077-7.8964-0.0174-2.9357-1.1937 0.51669-3.7077 7.8964-13.714 40.255-67.233 197.36-189.63 71.766-64.444-66.128-34.605-132.26 82.697-152.22-67.108 11.421-142.55-7.4491-163.25-81.433-5.9562-21.282-16.111-152.36-16.111-170.07 0-88.687 77.742-60.816 125.72-24.795z" />
            </svg>
            Connect Bluesky
          </DialogTitle>
          <DialogDescription>
            Choose how you want to connect your Bluesky account.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "oauth" | "app-password")}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="oauth" className="flex items-center gap-1.5">
              <Shield className="h-3.5 w-3.5" />
              OAuth
              <Badge variant="secondary" className="ms-1 text-[10px] px-1.5 py-0 bg-primary/10 text-primary">
                Recommended
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="app-password" className="flex items-center gap-1.5">
              <Key className="h-3.5 w-3.5" />
              App Password
            </TabsTrigger>
          </TabsList>

          <TabsContent value="oauth" className="mt-4">
            <form onSubmit={handleOAuthSubmit} className="space-y-4">
              <Alert className="bg-primary/5 border-primary/20">
                <Shield className="h-4 w-4 text-primary" />
                <AlertDescription className="text-sm">
                  <span className="font-medium text-primary">Secure OAuth Connection</span>
                  <br />
                  <span className="text-muted-foreground">
                    You'll be redirected to Bluesky to authorize access. No password needed!
                  </span>
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <Label htmlFor="bluesky-handle-oauth">Handle</Label>
                <Input
                  id="bluesky-handle-oauth"
                  placeholder="yourhandle.bsky.social"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  disabled={isConnecting}
                  autoComplete="username"
                />
                <p className="text-xs text-muted-foreground">
                  Enter your full handle (e.g., yourname.bsky.social)
                </p>
              </div>

              {error && activeTab === "oauth" && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleClose}
                  disabled={isConnecting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isConnecting || !onOAuthConnect}>
                  {isConnecting ? (
                    <>
                      <Loader2 className="w-4 h-4 me-2 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <Shield className="w-4 h-4 me-2" />
                      Connect with OAuth
                    </>
                  )}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>

          <TabsContent value="app-password" className="mt-4">
            <form onSubmit={handleAppPasswordSubmit} className="space-y-4">
              <Alert className="bg-muted/50">
                <Info className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  <a
                    href="https://bsky.app/settings/app-passwords"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    Create an app password here
                    <ExternalLink className="h-3 w-3" />
                  </a>
                  <span className="text-muted-foreground"> — never use your main password!</span>
                </AlertDescription>
              </Alert>

              <div className="space-y-2">
                <Label htmlFor="bluesky-handle">Handle</Label>
                <Input
                  id="bluesky-handle"
                  placeholder="yourhandle.bsky.social"
                  value={handle}
                  onChange={(e) => setHandle(e.target.value)}
                  disabled={isConnecting}
                  autoComplete="username"
                />
                <p className="text-xs text-muted-foreground">
                  Enter your full handle (e.g., yourname.bsky.social) or just your username
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="bluesky-password">App Password</Label>
                <Input
                  id="bluesky-password"
                  type="password"
                  placeholder="xxxx-xxxx-xxxx-xxxx"
                  value={appPassword}
                  onChange={(e) => setAppPassword(e.target.value)}
                  disabled={isConnecting}
                  autoComplete="current-password"
                />
                <p className="text-xs text-muted-foreground">
                  Use an app password, not your account password
                </p>
              </div>

              {error && activeTab === "app-password" && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleClose}
                  disabled={isConnecting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isConnecting}>
                  {isConnecting ? (
                    <>
                      <Loader2 className="w-4 h-4 me-2 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    "Connect"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
