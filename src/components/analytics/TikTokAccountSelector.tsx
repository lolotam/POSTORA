import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Video, Loader2 } from "lucide-react";

interface TikTokAccountSelectorProps {
  value: string | null;
  onChange: (id: string) => void;
}

interface TikTokAccount {
  id: string;
  platform_username: string | null;
  avatar_url: string | null;
}

export function TikTokAccountSelector({ value, onChange }: TikTokAccountSelectorProps) {
  const { t } = useTranslation("analytics");
  const { session } = useAuth();

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ["tiktok-accounts", session?.user?.id],
    queryFn: async (): Promise<TikTokAccount[]> => {
      if (!session?.user?.id) return [];
      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, platform_username, avatar_url")
        .eq("user_id", session.user.id)
        .eq("platform", "tiktok")
        .eq("is_active", true)
        .order("connected_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!session?.user?.id,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-3 rounded-lg border bg-muted/20">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t("tiktok.loadingAccounts", "Loading TikTok accounts…")}
      </div>
    );
  }

  if (accounts.length === 0) return null;

  const selected = accounts.find((a) => a.id === value);

  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue placeholder={t("search.selectTikTok", "Select a connected TikTok account…")}>
          {selected && (
            <div className="flex items-center gap-2">
              <Avatar className="w-5 h-5">
                <AvatarImage src={selected.avatar_url || undefined} />
                <AvatarFallback className="text-[10px]">
                  <Video className="w-3 h-3" />
                </AvatarFallback>
              </Avatar>
              <span>@{selected.platform_username}</span>
            </div>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {accounts.map((acc) => (
          <SelectItem key={acc.id} value={acc.id}>
            <div className="flex items-center gap-2">
              <Avatar className="w-5 h-5">
                <AvatarImage src={acc.avatar_url || undefined} />
                <AvatarFallback className="text-[10px]">
                  <Video className="w-3 h-3" />
                </AvatarFallback>
              </Avatar>
              <span>@{acc.platform_username}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
