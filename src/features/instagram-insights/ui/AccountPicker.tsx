import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Instagram } from "lucide-react";
import type { SocialAccount } from "@/hooks/useSocialAccounts";

export type AccountPickerProps = {
  accounts: SocialAccount[];
  selectedAccountId: string | null;
  onSelectAccount: (accountId: string) => void;
  disabled?: boolean;
};

export function AccountPicker({
  accounts,
  selectedAccountId,
  onSelectAccount,
  disabled = false,
}: AccountPickerProps) {
  const { t } = useTranslation("analytics");
  const igAccounts = accounts.filter(
    (acc) => acc.platform === "instagram" && acc.is_active !== false,
  );

  if (igAccounts.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-2 rounded-lg border border-dashed border-border bg-muted/30">
        <Instagram className="h-4 w-4 text-rose-500 shrink-0" />
        <span>{t("instagram.noAccountsConnected", "No active Instagram accounts found.")}</span>
      </div>
    );
  }

  const selected = igAccounts.find((a) => a.id === selectedAccountId) || igAccounts[0];

  return (
    <div className="flex items-center gap-3">
      <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
        {t("instagram.account", "Account")}:
      </span>
      <Select
        value={selected?.id || ""}
        onValueChange={onSelectAccount}
        disabled={disabled || igAccounts.length <= 1}
      >
        <SelectTrigger className="w-[240px] bg-background border-border/80 h-9">
          <SelectValue placeholder={t("instagram.selectAccount", "Select account")}>
            {selected && (
              <div className="flex items-center gap-2 truncate">
                <Avatar className="h-5 w-5 border border-rose-500/20">
                  <AvatarImage src={selected.avatar_url || undefined} alt={selected.platform_username || ""} />
                  <AvatarFallback className="text-[10px] bg-rose-500/10 text-rose-500">IG</AvatarFallback>
                </Avatar>
                <span className="font-medium text-xs truncate">@{selected.platform_username || "instagram"}</span>
              </div>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {igAccounts.map((acc) => (
            <SelectItem key={acc.id} value={acc.id}>
              <div className="flex items-center gap-2">
                <Avatar className="h-5 w-5">
                  <AvatarImage src={acc.avatar_url || undefined} alt={acc.platform_username || ""} />
                  <AvatarFallback className="text-[10px]">IG</AvatarFallback>
                </Avatar>
                <span className="text-xs">@{acc.platform_username || "instagram"}</span>
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
