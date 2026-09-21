import { createContext, useContext, useEffect, useRef, useState, ReactNode } from "react";
import { User, Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  api_key: string | null;
  ai_model: string | null;
  preferred_timezone: string | null;
  email_notifications_enabled: boolean | null;
  notification_sound_enabled: boolean | null;
  post_success_notifications_enabled: boolean | null;
  post_failure_notifications_enabled: boolean | null;
  created_at: string;
  updated_at: string;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  isLoading: boolean;
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: Error | null }>;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signInWithGoogle: () => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

// Named rather than `*`: `profiles` also stores `api_key_hash`, `referral_code`,
// `referred_by` and `admin_notified_at`, none of which this context exposes, and
// a column added to the table later should not join this payload by accident.
const PROFILE_COLUMNS =
  "id, email, full_name, avatar_url, api_key, ai_model, preferred_timezone, " +
  "email_notifications_enabled, notification_sound_enabled, " +
  "post_success_notifications_enabled, post_failure_notifications_enabled, " +
  "created_at, updated_at";

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // `onAuthStateChange` fires INITIAL_SESSION the moment it subscribes and
  // `getSession()` resolves with the same session a tick later, so both arms of
  // the effect below ask for the profile of the same user on every page load.
  // Remember who has been asked for and let `refreshProfile` override it.
  const profileRequestedForRef = useRef<string | null>(null);

  const fetchProfile = async (userId: string, { force = false } = {}) => {
    if (!force && profileRequestedForRef.current === userId) return;
    profileRequestedForRef.current = userId;

    const { data, error } = await supabase
      .from("profiles")
      .select(PROFILE_COLUMNS)
      .eq("id", userId)
      .maybeSingle();

    if (!error && data) {
      setProfile(data as Partial<Profile> as Profile);
      return;
    }
    // Nothing was stored, so a later render must be allowed to try again.
    profileRequestedForRef.current = null;
  };

  useEffect(() => {
    // Set up auth state listener FIRST
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        setSession(session);
        setUser(session?.user ?? null);

        // Defer profile fetch with setTimeout to avoid deadlock
        if (session?.user) {
          setTimeout(() => {
            fetchProfile(session.user.id);
          }, 0);
        } else {
          setProfile(null);
          profileRequestedForRef.current = null;
        }
      }
    );

    // THEN check for existing session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      if (session?.user) {
        fetchProfile(session.user.id);
      }
      setIsLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signUp = async (email: string, password: string, fullName?: string) => {
    const redirectUrl = `${window.location.origin}/dashboard`;

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: redirectUrl,
        data: {
          full_name: fullName,
        },
      },
    });

    return { error };
  };

  const signIn = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    return { error };
  };

  const signInWithGoogle = async () => {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/dashboard`,
        scopes: "openid email profile",
        queryParams: {
          include_granted_scopes: "true",
        },
      },
    });

    return { error };
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    try {
      const { clearMentionsSessionState } = await import("@/hooks/useThreadsMentions");
      clearMentionsSessionState();
      const { clearRepliesSessionState } = await import("@/hooks/useThreadsReplies");
      clearRepliesSessionState();
    } catch {
      /* ignore */
    }
    setUser(null);
    setSession(null);
    setProfile(null);
    profileRequestedForRef.current = null;
  };

  const refreshProfile = async () => {
    if (user) {
      await fetchProfile(user.id, { force: true });
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        isLoading,
        signUp,
        signIn,
        signInWithGoogle,
        signOut,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
