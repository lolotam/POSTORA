import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Facebook, Camera, MessageSquare } from "lucide-react";
import type { MessagingAccount } from "@/hooks/useMessaging";

interface AccountSelectorProps {
  accounts: MessagingAccount[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  platformFilter?: "facebook" | "instagram" | "whatsapp" | null;
}

export function AccountSelector({ accounts, selectedId, onSelect, platformFilter }: AccountSelectorProps) {
  const { t } = useTranslation("inbox");
  const filtered = platformFilter
    ? accounts.filter((a) => a.platform === platformFilter)
    : accounts;

  if (filtered.length === 0) {
    return (
      <div className="text-sm text-muted-foreground p-3 border rounded-lg">
        {t("accounts.noneConnected", "No connected {{platform}} accounts found. Connect one in Profiles.", {
          platform: platformFilter || "Facebook/Instagram",
        })}
      </div>
    );
  }

  return (
    <Select value={selectedId || ""} onValueChange={onSelect}>
      <SelectTrigger className="w-full max-w-xs">
        <SelectValue placeholder={t("accounts.select", "Select an account")} />
      </SelectTrigger>
      <SelectContent>
        {filtered.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            <div className="flex items-center gap-2">
              <Avatar className="h-5 w-5">
                <AvatarImage src={account.avatar_url || ""} />
                <AvatarFallback>
                  {account.platform === "facebook" ? <Facebook className="w-3 h-3" /> : account.platform === "whatsapp" ? <MessageSquare className="w-3 h-3" /> : <Camera className="w-3 h-3" />}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">{account.platform_username || account.platform_user_id}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
