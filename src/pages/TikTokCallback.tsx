import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Loader2, CheckCircle, XCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

// The return path the signed state carried, when it is on this site.
function sameSiteReturnPath(returnTo: unknown): string | null {
  if (typeof returnTo !== "string") return null;
  try {
    const url = new URL(returnTo);
    return url.origin === window.location.origin ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

export default function TikTokCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { toast } = useToast();
  const [status, setStatus] = useState<"loading" | "success" | "error" | "expired">("loading");
  const [message, setMessage] = useState("Connecting your TikTok account...");
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = async () => {
    setIsRetrying(true);
    
    // Get stored profile ID
    const profileId = sessionStorage.getItem("tiktok_profile_id");
    
    try {
      const { data, error } = await supabase.functions.invoke("tiktok-oauth", {
        body: {
          action: "authorize",
          redirect_uri: "https://postora.cloud/tiktok-callback",
          social_profile_id: profileId || null,
        },
      });

      if (error) throw error;
      
      if (data?.url) {
        window.location.href = data.url;
      } else {
        throw new Error("Failed to get authorization URL");
      }
    } catch (err) {
      console.error("[TikTok Callback] Retry failed:", err);
      toast({
        title: "Retry failed",
        description: "Please go back to Profiles and try connecting again.",
        variant: "destructive",
      });
      setIsRetrying(false);
    }
  };

  useEffect(() => {
    const handleCallback = async () => {
      const code = searchParams.get("code");
      const error = searchParams.get("error");
      const errorDescription = searchParams.get("error_description");
      const errorCode = searchParams.get("error_code");

      // Get profile_id from sessionStorage
      const profileId = sessionStorage.getItem("tiktok_profile_id");

      console.log("[TikTok Callback] Processing OAuth callback...");
      console.log("[TikTok Callback] Code received:", !!code);
      console.log("[TikTok Callback] Profile ID from session:", profileId);
      console.log("[TikTok Callback] Error:", error);
      console.log("[TikTok Callback] Error description:", errorDescription);

      if (error) {
        console.error("[TikTok Callback] OAuth error received:", { error, errorCode, errorDescription });
        setStatus("error");
        setMessage(errorDescription || "TikTok authorization was cancelled");
        toast({
          title: "Connection cancelled",
          description: errorDescription || "TikTok authorization was cancelled",
          variant: "destructive",
        });
        setTimeout(() => navigate("/profiles"), 2000);
        return;
      }

      if (!code) {
        console.error("[TikTok Callback] No authorization code in URL params");
        setStatus("error");
        setMessage("No authorization code received");
        toast({
          title: "Connection failed",
          description: "No authorization code received from TikTok",
          variant: "destructive",
        });
        setTimeout(() => navigate("/profiles"), 2000);
        return;
      }

      if (!user) {
        console.error("[TikTok Callback] No authenticated user found");
        setStatus("error");
        setMessage("Please log in to connect your TikTok account");
        setTimeout(() => navigate("/auth"), 2000);
        return;
      }

      try {
        // Must match exactly what was used for authorization - use production domain
        const redirectUri = "https://postora.cloud/tiktok-callback";
        
        console.log("[TikTok Callback] Exchanging code for tokens...");
        console.log("[TikTok Callback] Using redirect_uri:", redirectUri);
        console.log("[TikTok Callback] User ID:", user.id);

        const { data, error: fnError } = await supabase.functions.invoke("tiktok-oauth", {
          body: {
            action: "callback",
            code,
            // Signed by `authorize`; the function verifies it belongs to this user and reads reconnect mode from it.
            state: searchParams.get("state"),
            redirect_uri: redirectUri,
            user_id: user.id,
            social_profile_id: profileId || null,
          },
        });

        if (fnError) {
          console.error("[TikTok Callback] Edge function error:", fnError);
          throw fnError;
        }

        console.log("[TikTok Callback] Edge function response:", data);

        if (data?.success) {
          console.log("[TikTok Callback] Connection successful!");
          setStatus("success");
          setMessage(`TikTok account connected successfully!`);
          toast({
            title: "TikTok connected!",
            description: "Your TikTok account has been connected successfully.",
          });
          
          // Clear sessionStorage
          sessionStorage.removeItem("tiktok_profile_id");
          
          // Redirect to /tiktok-auth if demo flow, otherwise /profiles
          const isDemoReturn = sessionStorage.getItem("tiktok_demo_return") === "true";
          sessionStorage.removeItem("tiktok_demo_return");
          setTimeout(() => navigate(isDemoReturn ? "/tiktok-auth" : sameSiteReturnPath(data.return_to) ?? "/profiles"), 1500);
        } else {
          console.error("[TikTok Callback] Connection failed:", data?.error);
          
          // Check for expired code error
          const errorMsg = data?.error || "";
          const isExpiredCode = 
            errorMsg.toLowerCase().includes("expired") ||
            errorMsg.toLowerCase().includes("invalid_grant") ||
            errorMsg.includes("Authorization code is expired");
          
          if (isExpiredCode) {
            setStatus("expired");
            setMessage("Authorization code expired");
            // Store error for debug panel
            sessionStorage.setItem("tiktok_last_error", JSON.stringify({
              error: "expired_code",
              error_description: "The authorization code expired. TikTok codes are only valid for about 60 seconds.",
              timestamp: new Date().toISOString()
            }));
          } else {
            throw new Error(data?.error || "Failed to complete TikTok connection");
          }
        }
      } catch (err) {
        console.error("[TikTok Callback] Fatal error:", err);
        console.error("[TikTok Callback] Error stack:", err instanceof Error ? err.stack : 'N/A');
        
        const errorMsg = err instanceof Error ? err.message : String(err);
        
        // Check for expired code in catch block too
        const isExpiredCode = 
          errorMsg.toLowerCase().includes("expired") ||
          errorMsg.toLowerCase().includes("invalid_grant");
        
        if (isExpiredCode) {
          setStatus("expired");
          setMessage("Authorization code expired");
          sessionStorage.setItem("tiktok_last_error", JSON.stringify({
            error: "expired_code",
            error_description: "The authorization code expired. TikTok codes are only valid for about 60 seconds.",
            timestamp: new Date().toISOString()
          }));
        } else {
          setStatus("error");
          setMessage(errorMsg);
          toast({
            title: "Connection failed",
            description: errorMsg,
            variant: "destructive",
          });
          setTimeout(() => navigate("/profiles"), 2000);
        }
      }
    };

    handleCallback();
  }, [searchParams, user, navigate, toast]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center space-y-4 p-8 max-w-md">
        {status === "loading" && (
          <>
            <Loader2 className="w-12 h-12 animate-spin mx-auto text-primary" />
            <h2 className="text-xl font-semibold">{message}</h2>
            <p className="text-muted-foreground">Please wait...</p>
          </>
        )}
        {status === "success" && (
          <>
            <CheckCircle className="w-12 h-12 mx-auto text-green-500" />
            <h2 className="text-xl font-semibold text-green-600">{message}</h2>
            <p className="text-muted-foreground">Redirecting...</p>
          </>
        )}
        {status === "expired" && (
          <>
            <RefreshCw className="w-12 h-12 mx-auto text-amber-500" />
            <h2 className="text-xl font-semibold text-amber-600">Connection Timed Out</h2>
            <p className="text-muted-foreground">
              TikTok's authorization code expired. This happens when there's a delay during login. 
              Don't worry - just try again!
            </p>
            <div className="flex flex-col gap-2 mt-4">
              <Button 
                onClick={handleRetry} 
                disabled={isRetrying}
                className="w-full"
              >
                {isRetrying ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    Reconnecting...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 me-2" />
                    Try Again
                  </>
                )}
              </Button>
              <Button 
                variant="outline" 
                onClick={() => navigate("/profiles")}
                className="w-full"
              >
                Back to Profiles
              </Button>
            </div>
          </>
        )}
        {status === "error" && (
          <>
            <XCircle className="w-12 h-12 mx-auto text-destructive" />
            <h2 className="text-xl font-semibold text-destructive">{message}</h2>
            <p className="text-muted-foreground">Redirecting...</p>
          </>
        )}
      </div>
    </div>
  );
}