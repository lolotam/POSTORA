import { useTranslation } from "react-i18next";
import "@/i18n";
import { BriefcaseBusiness } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useWhatsAppWorkspaceContext } from "./WhatsAppWorkspaceProvider";

export function WorkspaceSwitcher() {
  const { t } = useTranslation("whatsapp");
  const { workspaces, activeWorkspaceId, setActiveWorkspaceId } = useWhatsAppWorkspaceContext();

  if (workspaces.length < 2) return null;

  return (
    <Select value={activeWorkspaceId} onValueChange={setActiveWorkspaceId}>
      <SelectTrigger
        aria-label={t("workspace.switcherAria", "Active WhatsApp workspace")}
        className="w-full border-white/20 bg-white/10 text-white hover:bg-white/15 focus:ring-white/70 sm:w-[220px]"
      >
        <BriefcaseBusiness className="mr-2 h-4 w-4 shrink-0" />
        <SelectValue placeholder={t("workspace.placeholder", "Select workspace")} />
      </SelectTrigger>
      <SelectContent>
        {workspaces.map((workspace) => (
          <SelectItem key={workspace.id} value={workspace.id}>
            {workspace.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
