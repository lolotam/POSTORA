import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { ApprovalsView, ByShell } from "@/features/tiktok-publishing";
import TikTokPublish from "@/pages/TikTokPublish";

/** Review users get the Approvals page; admins keep the existing TikTok publish workspace. */
export default function Approvals() {
  return (
    <ByShell
      review={<DashboardLayout><ApprovalsView /></DashboardLayout>}
      admin={<TikTokPublish />}
    />
  );
}
