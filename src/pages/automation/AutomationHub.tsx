import { Link } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Icon3D, GradientHeading, GradientDivider, Reveal, GradientRingCard } from "@/components/fx";
import { Sparkles, MessageSquare, MessageCircle, Bot, ArrowRight, Zap, Cpu } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function AutomationHub() {
  const cards = [
    {
      title: "Agent Setup Portal",
      subtitle: "Unified AI Assistant Studio",
      description:
        "Centralized configuration for your AI agents across WhatsApp, Facebook, Instagram, and Threads. Manage system prompts, knowledge base (RAG), e-commerce tools, and model routing.",
      icon: Bot,
      variant: "violet" as const,
      path: "/automation/agents",
      badge: "Flagship AI",
      features: [
        "Multi-model routing (GPT-4o, Claude 3.5, Gemini 2.0)",
        "Shared business knowledge base & PDF/Excel ingest",
        "E-Commerce & CRM Tool Calling",
        "Interactive test sandbox simulator",
      ],
    },
    {
      title: "Messaging Automation",
      subtitle: "Direct Inbound Conversations",
      description:
        "Automate direct message replies, configure keyword rules, assign human agent handoffs, and select between internal AI or n8n workflows for WhatsApp, Messenger, IG, and Threads.",
      icon: MessageSquare,
      variant: "sky" as const,
      path: "/automation/agents?surface=dms",
      badge: "Inbound DMs",
      features: [
        "Rule-based keyword auto-replies",
        "Handler selection (Internal AI / n8n / Off)",
        "WhatsApp quick replies & sequences",
        "Human agent routing & triggers",
      ],
    },
    {
      title: "Comments Automation",
      subtitle: "Public Post Moderation & Replies",
      description:
        "Automate responses to post comments on Facebook Pages, Instagram Media, and Threads. Auto-hide spam, filter profanity, and trigger high-converting comment-to-DM workflows.",
      icon: MessageCircle,
      variant: "emerald" as const,
      path: "/automation/agents?surface=comments",
      badge: "Public Posts",
      features: [
        "Post comment auto-replies",
        "Spam and profanity auto-moderation",
        "Comment-to-DM automation hooks",
        "Multi-account rule assignments",
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
                    Automation Hub
                  </GradientHeading>
                  <Badge variant="outline" className="border-violet-500/30 text-violet-400 bg-violet-500/10 gap-1">
                    <Cpu className="w-3.5 h-3.5" /> All-in-One Engine
                  </Badge>
                </div>
                <p className="text-sm md:text-base text-muted-foreground mt-1">
                  Manage your AI agents, auto-replies, and communication rules across all connected platforms in one place
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
                      Key Capabilities:
                    </p>
                    <ul className="space-y-1.5 text-xs text-muted-foreground">
                      {card.features.map((f, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <Zap className="w-3 h-3 text-primary shrink-0" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="pt-6 mt-auto">
                  <Button asChild className="w-full gap-2 justify-between">
                    <Link to={card.path}>
                      <span>Open {card.title}</span>
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
