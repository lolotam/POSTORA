import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import type { YouTubeAccountOption } from "../domain/accountOptions";

export interface YouTubeAccountPickerProps {
  accounts: readonly YouTubeAccountOption[];
  selectedId: string | null;
  onSelect: (accountId: string) => void;
}

// A labelled native <select> so the browser owns the keyboard, the screen
// reader behaviour and the popup; no Radix state machine for a plain list.
export function YouTubeAccountPicker(props: YouTubeAccountPickerProps): JSX.Element {
  const { accounts, selectedId, onSelect } = props;
  const { t } = useTranslation("accounts");

  return (
    <div className="space-y-1.5">
      <Label htmlFor="youtube-account-picker">{t("youtubeManagement.accountLabel", "Channel")}</Label>
      <select
        id="youtube-account-picker"
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm sm:w-72"
        value={selectedId ?? ""}
        onChange={(event) => onSelect(event.target.value)}
      >
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.title}
          </option>
        ))}
      </select>
    </div>
  );
}
