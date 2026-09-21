import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Logo } from "@/components/Logo";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { Loader2, User, Globe, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PublicProfile {
  id: string;
  name: string;
  share_token: string;
  is_public: boolean;
}

interface PublicAccount {
  id: string;
  platform: string;
  platform_username: string | null;
  avatar_url: string | null;
}

export default function PublicProfile() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [accounts, setAccounts] = useState<PublicAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (shareToken) {
      fetchPublicProfile();
    }
  }, [shareToken]);

  const fetchPublicProfile = async () => {
    try {
      setLoading(true);
      setError(null);

      // Fetch the public profile
      const { data: profileData, error: profileError } = await supabase
        .from("social_profiles")
        .select("id, name, share_token, is_public")
        .eq("share_token", shareToken)
        .eq("is_public", true)
        .single();

      if (profileError || !profileData) {
        setError("Profile not found or is not public");
        return;
      }

      setProfile(profileData);

      // Fetch connected accounts for this profile using the secure view
      const { data: accountsData, error: accountsError } = await supabase
        .from("public_social_accounts")
        .select("id, platform, platform_username, avatar_url")
        .eq("social_profile_id", profileData.id)
        .eq("is_active", true);

      if (accountsError) {
        console.error("Error fetching accounts:", accountsError);
      }

      setAccounts(accountsData || []);
    } catch (err) {
      console.error("Error:", err);
      setError("Failed to load profile");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container max-w-2xl mx-auto px-4 py-12">
          <Link to="/">
            <Button variant="ghost" className="mb-8">
              <ArrowLeft className="me-2 h-4 w-4" />
              Back to Home
            </Button>
          </Link>
          <div className="text-center py-20">
            <Globe className="w-16 h-16 mx-auto text-muted-foreground mb-4" />
            <h1 className="text-2xl font-bold mb-2">Profile Not Found</h1>
            <p className="text-muted-foreground">
              This profile doesn't exist or is not publicly shared.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Background Effects */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 start-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[128px]" />
        <div className="absolute bottom-0 end-1/4 w-80 h-80 bg-accent/10 rounded-full blur-[128px]" />
      </div>

      {/* Header */}
      <header className="relative z-10 border-b border-border/50 bg-background/50 backdrop-blur-xl">
        <div className="container mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/">
            <Logo />
          </Link>
          <Link to="/auth">
            <Button variant="outline" size="sm">
              Sign In
            </Button>
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="relative z-10 container max-w-2xl mx-auto px-4 py-12">
        <div className="text-center mb-12">
          <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center mx-auto mb-6">
            <User className="w-10 h-10 text-primary" />
          </div>
          <h1 className="text-3xl font-bold mb-2">{profile.name}</h1>
          <p className="text-muted-foreground">Connected Social Accounts</p>
        </div>

        {accounts.length === 0 ? (
          <div className="text-center py-12 rounded-2xl border border-border bg-card/50">
            <Globe className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No connected accounts yet</p>
          </div>
        ) : (
          <div className="grid gap-4">
            {accounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center gap-4 p-4 rounded-xl border border-border bg-card/50 hover:bg-card transition-colors"
              >
                <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center overflow-hidden">
                  {account.avatar_url ? (
                    <img
                      src={account.avatar_url}
                      alt={account.platform_username || account.platform}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <PlatformIcon platform={account.platform as Platform} size="lg" />
                  )}
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <PlatformIcon platform={account.platform as Platform} size="sm" />
                    <span className="font-medium capitalize">
                      {account.platform}
                    </span>
                  </div>
                  {account.platform_username && (
                    <p className="text-sm text-muted-foreground">
                      @{account.platform_username}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="mt-12 text-center">
          <p className="text-sm text-muted-foreground mb-4">
            Want to create your own social media hub?
          </p>
          <Link to="/auth?mode=signup">
            <Button variant="gradient">Get Started Free</Button>
          </Link>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-border bg-card/50 mt-20">
        <div className="container mx-auto px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <Logo size="sm" />
          <div className="flex items-center gap-6">
            <Link to="/privacy" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Privacy Policy
            </Link>
            <Link to="/terms" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Terms of Service
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">
            © 2026 Postora. A product developed and operated by WALEED PROLIFE LLC. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
}