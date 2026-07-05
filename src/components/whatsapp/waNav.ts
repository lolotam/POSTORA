import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Bot,
  Building2,
  Clock,
  FileText,
  LayoutDashboard,
  MessageSquare,
  PieChart,
  Radio,
  Settings2,
  ShoppingBag,
  UserCog,
  Users,
  Webhook,
  Zap,
} from "lucide-react";

export interface WhatsAppNavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

export const WHATSAPP_BASE_PATH = "/messaging/whatsapp";

export function whatsappSectionRoute(path: string) {
  return path ? `${WHATSAPP_BASE_PATH}/${path}` : WHATSAPP_BASE_PATH;
}

export const whatsappNavItems: WhatsAppNavItem[] = [
  { path: "", label: "Dashboard", icon: LayoutDashboard, end: true },
  { path: "conversations", label: "Conversations", icon: MessageSquare },
  { path: "contacts", label: "Contacts", icon: Users },
  { path: "templates", label: "Templates", icon: FileText },
  { path: "analytics", label: "Analytics", icon: BarChart3 },
  { path: "quick-replies", label: "Quick Replies", icon: Zap },
  { path: "auto-replies", label: "Auto Replies", icon: Bot },
  { path: "broadcasts", label: "Broadcasts", icon: Radio },
  { path: "agents", label: "Agents", icon: UserCog },
  { path: "profile", label: "Profile", icon: Building2 },
  { path: "webhooks", label: "Webhooks", icon: Webhook },
  { path: "scheduled", label: "Scheduled", icon: Clock },
  { path: "response-stats", label: "Response Stats", icon: PieChart },
  { path: "catalog", label: "Catalog", icon: ShoppingBag },
  { path: "setup", label: "Setup", icon: Settings2 },
];
