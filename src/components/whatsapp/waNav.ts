import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BookOpen,
  Bot,
  Building2,
  Clock,
  FileText,
  Headphones,
  Kanban,
  LayoutDashboard,
  MessageSquare,
  PieChart,
  Radio,
  Settings2,
  ShoppingBag,
  Sparkles,
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
  { path: "pipelines", label: "Pipelines", icon: Kanban },
  { path: "conversations", label: "Conversations", icon: MessageSquare },
  { path: "contacts", label: "Contacts", icon: Users },
  { path: "templates", label: "Templates", icon: FileText },
  { path: "analytics", label: "Analytics", icon: BarChart3 },
  { path: "automation", label: "Automation", icon: Sparkles },
  { path: "profile", label: "Profile", icon: Building2 },
  { path: "webhooks", label: "Webhooks", icon: Webhook },
  { path: "scheduled", label: "Scheduled", icon: Clock },
  { path: "response-stats", label: "Response Stats", icon: PieChart },
  { path: "catalog", label: "Catalog", icon: ShoppingBag },
  { path: "setup", label: "Setup", icon: Settings2 },
  { path: "docs", label: "Docs", icon: BookOpen },
];

export interface AutomationTabItem {
  path: string;
  label: string;
  icon: LucideIcon;
  /** Absolute app route outside /messaging/whatsapp (e.g. the Ad Manager's Human Agent page). */
  absolute?: boolean;
}

export const whatsappAutomationTabs: AutomationTabItem[] = [
  { path: "ai-agent", label: "AI Agent", icon: Sparkles },
  { path: "quick-replies", label: "Quick Replies", icon: Zap },
  { path: "auto-replies", label: "Auto Replies", icon: Bot },
  { path: "agents", label: "Agents", icon: UserCog },
  { path: "broadcasts", label: "Broadcasting", icon: Radio },
  { path: "/human-agent", label: "Human Agent", icon: Headphones, absolute: true },
];

export const whatsappSectionDescriptions: Record<string, string> = {
  conversations: "Handle live customer conversations from the WhatsApp inbox.",
  contacts: "Manage saved contacts, uploads, tags, and customer records.",
  templates: "Review approved message templates and send compliant outreach.",
  analytics: "Track conversation activity, unread messages, and response trends.",
  automation: "AI agent, quick replies, auto replies, broadcasts, agents, and human handoff.",
  "quick-replies": "Keep reusable replies ready for agents and common questions.",
  "auto-replies": "Automate inbound responses based on keywords and availability.",
  broadcasts: "Plan and send WhatsApp broadcast campaigns to opted-in contacts.",
  agents: "Manage assignments, ownership, and handoff for WhatsApp conversations.",
  "ai-agent": "Configure the AI assistant that answers customers automatically.",
  profile: "Update business identity details shown through WhatsApp.",
  webhooks: "Inspect webhook behavior and connected automation endpoints.",
  scheduled: "Review queued WhatsApp messages before they are delivered.",
  "response-stats": "Measure canned response usage and team response performance.",
  catalog: "Maintain catalog items for WhatsApp commerce conversations.",
  setup: "Connect WhatsApp Business numbers and run diagnostics.",
  docs: "Learn how to connect, configure, and troubleshoot WhatsApp in Postora.",
};
