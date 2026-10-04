import { useTranslation } from "react-i18next";
import "@/i18n";
import { Link } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Icon3D, GradientHeading, GradientDivider, Reveal, GradientRingCard } from "@/components/fx";
import { Sparkles, MessageSquare, MessageCircle, Bot, ArrowRight, Zap, Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function AutomationHub() {
  const { t } = useTranslation("automation");

  const cards = [
    {
      id: "agents",
      title: t("hub.agents.title", "Agent Setup Portal"),
      subtitle: t("hub.agents.subtitle", "Unified AI Assistant Studio"),
      description: t(
        "hub.agents.description",
        "Centralized configuration for your AI agents across WhatsApp, Facebook, Instagram, and Threads. Manage system prompts, knowledge base (RAG), e-commerce tools, and model routing.",
      ),
      icon: Bot,
      variant: "violet" as const,
      path: "/automation/agents",
      badge: t("hub.agents.badge", "Flagship AI"),
      features: [
        { id: "routing", text: t("hub.agents.featureRouting", "Multi-model routing (GPT-4o, Claude 3.5, Gemini 2.0)") },
        { id: "knowledge", text: t("hub.agents.featureKnowledge", "Shared business knowledge base & PDF/Excel ingest") },
        { id: "tools", text: t("hub.agents.featureTools", "E-Commerce & CRM Tool Calling") },
        { id: "sandbox", text: t("hub.agents.featureSandbox", "Interactive test sandbox simulator") },
      ],
    },
    {
      id: "messaging",
      title: t("hub.messaging.title", "Messaging Automation"),
      subtitle: t("hub.messaging.subtitle", "Direct Inbound Conversations"),
      description: t(
        "hub.messaging.description",
        "Automate direct message replies, configure keyword rules, assign human agent handoffs, and select between internal AI or n8n workflows for WhatsApp, Messenger, IG, and Threads.",
      ),
      icon: MessageSquare,
      variant: "sky" as const,
      path: "/automation/agents?surface=dms",
      badge: t("hub.messaging.badge", "Inbound DMs"),
      features: [
        { id: "keywords", text: t("hub.messaging.featureKeywords", "Rule-based keyword auto-replies") },
        { id: "handler", text: t("hub.messaging.featureHandler", "Handler selection (Internal AI / n8n / Off)") },
        { id: "quick", text: t("hub.messaging.featureQuick", "WhatsApp quick replies & sequences") },
        { id: "routing", text: t("hub.messaging.featureRouting", "Human agent routing & triggers") },
      ],
    },
    {
      id: "comments",
      title: t("hub.comments.title", "Comments Automation"),
      subtitle: t("hub.comments.subtitle", "Public Post Moderation & Replies"),
      description: t(
        "hub.comments.description",
        "Automate responses to post comments on Facebook Pages, Instagram Media, and Threads. Auto-hide spam, filter profanity, and trigger high-converting comment-to-DM workflows.",
      ),
      icon: MessageCircle,
      variant: "emerald" as const,
      path: "/automation/agents?surface=comments",
      badge: t("hub.comments.badge", "Public Posts"),
      features: [
        { id: "replies", text: t("hub.comments.featureReplies", "Post comment auto-replies") },
        { id: "moderation", text: t("hub.comments.featureModeration", "Spam and profanity auto-moderation") },
        { id: "hooks", text: t("hub.comments.featureHooks", "Comment-to-DM automation hooks") },
        { id: "rules", text: t("hub.comments.featureRules", "Multi-account rule assignments") },
      ],
    },
  ];

  return (
    <DashboardLayout>
      <div className="w-full space-y-8">
        <Reveal>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Icon3D icon={Sparkles} variant="violet" size="lg" />
              <div>
                <div className="flex items-center gap-2">
                  <GradientHeading preset="violet-sky" size="xl" as="h1">
                    {t("header.hub", "Automation Hub")}
                  </GradientHeading>
                  <Badge variant="outline" className="border-border text-foreground bg-muted gap-1">
                    <Cpu className="w-3.5 h-3.5" /> {t("hub.engineBadge", "All-in-One Engine")}
                  </Badge>
                </div>
                <p className="text-sm md:text-base text-muted-foreground mt-1">
                  {t("hub.subtitle", "Manage your AI agents, auto-replies, and communication rules across all connected platforms in one place")}
                </p>
              </div>
            </div>
          </div>
        </Reveal>

        <GradientDivider tone="violet" />

        {/* 3 Core Cards Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {cards.map((card, idx) => (
            <Reveal key={card.path} delay={idx * 60}>
              <GradientRingCard
                variant={card.variant}
                padded={false}
                hoverLift={true}
                ringIntensity="subtle"
                className="h-full flex flex-col"
                innerClassName="p-6 flex flex-col justify-between h-full"
              >
                <div className="space-y-4">
                  <div className="flex items-start justify-between">
                    <Icon3D icon={card.icon} variant={card.variant} size="md" />
                    <Badge variant="secondary" className="font-medium text-xs">
                      {card.badge}
                    </Badge>
                  </div>

                  <div>
                    <h2 className="text-xl font-bold text-foreground">{card.title}</h2>
                    <p className="text-xs font-semibold text-primary mt-0.5">{card.subtitle}</p>
                    <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
                      {card.description}
                    </p>
                  </div>

                  <div className="space-y-2 pt-2 border-t border-border/40">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t("hub.capabilities", "Key Capabilities:")}
                    </p>
                    <ul className="space-y-1.5 text-xs text-muted-foreground">
                      {card.features.map((f) => (
                        <li key={f.id} className="flex items-center gap-2">
                          <Zap className="w-3 h-3 text-primary shrink-0" />
                          <span>{f.text}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="pt-6 mt-auto">
                  <Button asChild className="w-full gap-2 justify-between">
                    <Link to={card.path}>
                      <span>{t("hub.openCard", "Open {{title}}", { title: card.title })}</span>
                      <ArrowRight className="w-4 h-4" />
                    </Link>
                  </Button>
                </div>
              </GradientRingCard>
            </Reveal>
          ))}
        </div>
      </div>
    </DashboardLayout>
  );
}
