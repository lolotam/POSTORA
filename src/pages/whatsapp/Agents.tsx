import { UserCog } from "lucide-react";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import { WorkspaceTeamManager } from "@/components/whatsapp/WorkspaceTeamManager";

export default function Agents() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={UserCog}
        title="Workspace team"
        description="Manage workspace access, roles, invitations, and operational agent presence."
      />
      <WorkspaceTeamManager />
    </div>
  );
}
