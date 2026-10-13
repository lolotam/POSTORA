import { Navigate } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { ActivityView, ByShell, CalendarView, IntegrationsView, WorkspaceView } from "@/features/tiktok-publishing";
import Calendar from "@/pages/Calendar";
import Settings from "@/pages/Settings";

// TikTok review build pages. Review users get the pipeline pages inside the review shell;
// admins keep the existing pages (or the dashboard where there is no admin equivalent).

export function ActivityPage() {
  return <ByShell review={<DashboardLayout><ActivityView /></DashboardLayout>} admin={<Navigate to="/dashboard" replace />} />;
}

export function IntegrationsPage() {
  return <ByShell review={<DashboardLayout><IntegrationsView /></DashboardLayout>} admin={<Navigate to="/profiles" replace />} />;
}

export function CalendarPage() {
  return <ByShell review={<DashboardLayout><CalendarView /></DashboardLayout>} admin={<Calendar />} />;
}

export function WorkspacePage() {
  return <ByShell review={<DashboardLayout><WorkspaceView /></DashboardLayout>} admin={<Settings />} />;
}
