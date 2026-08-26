import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BookOpen,
  Building2,
  Clock,
  FileText,
  Kanban,
  LayoutDashboard,
  MessageSquare,
  PieChart,
  Radio,
  Settings2,
  ShoppingBag,
  UserCog,
  Users,
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

/**
 * Sections that left the nav but whose URLs are still out there in bookmarks and docs. Kept
 * separate from whatsappNavItems precisely because a slug's absence from the nav says nothing
 * about whether its links should keep working.
 */
export const whatsappRetiredRoutes: Record<string, string> = {
  webhooks: `${WHATSAPP_BASE_PATH}/setup?tab=webhooks`,
};

/** Resolves a legacy `/messaging/whatsapp?tab=<slug>` deep link to the route serving it today. */
export function whatsappLegacyTabTarget(tab: string | null | undefined): string | null {
  if (!tab) return null;
  // `in` would also match inherited keys, so ?tab=constructor would hand a function back to
  // <Navigate to={...}>. The value comes straight from the query string, so own properties only.
  if (Object.prototype.hasOwnProperty.call(whatsappRetiredRoutes, tab)) {
    return whatsappRetiredRoutes[tab];
  }
  return whatsappNavItems.some((item) => item.path === tab) ? whatsappSectionRoute(tab) : null;
}

export const whatsappNavItems: WhatsAppNavItem[] = [
  { path: "", label: "Dashboard", icon: LayoutDashboard, end: true },
  { path: "pipelines", label: "Pipelines", icon: Kanban },
  { path: "conversations", label: "Conversations", icon: MessageSquare },
  { path: "contacts", label: "Contacts", icon: Users },
  { path: "templates", label: "Templates", icon: FileText },
  { path: "analytics", label: "Analytics", icon: BarChart3 },
  { path: "quick-replies", label: "Quick Replies", icon: Zap },
  { path: "broadcasts", label: "Broadcasting", icon: Radio },
  { path: "agents", label: "Agents", icon: UserCog },
  { path: "profile", label: "Profile", icon: Building2 },
  { path: "scheduled", label: "Scheduled", icon: Clock },
  { path: "response-stats", label: "Response Stats", icon: PieChart },
  { path: "catalog", label: "Catalog", icon: ShoppingBag },
  { path: "setup", label: "Setup", icon: Settings2 },
  { path: "docs", label: "Docs", icon: BookOpen },
];

export const whatsappSectionDescriptions: Record<string, string> = {
  conversations: "Handle live customer conversations from the WhatsApp inbox.",
  contacts: "Manage saved contacts, uploads, tags, and customer records.",
  templates: "Review approved message templates and send compliant outreach.",
  analytics: "Track conversation activity, unread messages, and response trends.",
  "quick-replies": "Keep reusable replies ready for agents and common questions.",
  broadcasts: "Plan and send WhatsApp broadcast campaigns to opted-in contacts.",
  agents: "Manage assignments, ownership, and handoff for WhatsApp conversations.",
  profile: "Update business identity details shown through WhatsApp.",
  scheduled: "Review queued WhatsApp messages before they are delivered.",
  "response-stats": "Measure canned response usage and team response performance.",
  catalog: "Maintain catalog items for WhatsApp commerce conversations.",
  setup: "Connect WhatsApp Business numbers, manage webhooks, and run diagnostics.",
  docs: "Learn how to connect, configure, and troubleshoot WhatsApp in Postora.",
};
