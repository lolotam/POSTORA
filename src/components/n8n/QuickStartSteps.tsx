import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ChevronRight, Rocket } from "lucide-react";
import { Icon3D, GradientHeading, GradientRingCard, Reveal } from "@/components/fx";
import type { GradientKey } from "@/components/fx";

interface QuickStartStep {
  step: number;
  title: string;
  description: string;
  action?: {
    text: string;
    link?: string;
    onClick?: () => void;
  };
}

interface QuickStartStepsProps {
  steps: QuickStartStep[];
}

export function QuickStartSteps({ steps }: QuickStartStepsProps) {
  const variants: GradientKey[] = ["sky", "violet", "emerald", "rose"];
  return (
    <section className="container mx-auto px-6 py-20">
      <Reveal className="text-center mb-12">
        <div className="flex flex-col items-center gap-4">
          <Icon3D icon={Rocket} variant="sky" size="md" />
          <GradientHeading as="h2" preset="sky-violet" size="lg">Quick Start Guide</GradientHeading>
          <p className="text-muted-foreground max-w-xl">Four simple steps to fully automate your publishing pipeline.</p>
        </div>
      </Reveal>
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
        {steps.map((s, idx) => {
          const v = variants[idx % variants.length];
          return (
            <Reveal key={s.step} delay={idx * 80}>
              <GradientRingCard variant={v} ringIntensity="subtle">
                <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-secondary text-foreground font-semibold">
                  {s.step}
                </div>
                <h3 className="font-semibold mb-2">{s.title}</h3>
                <p className="text-sm text-muted-foreground mb-4">{s.description}</p>
                {s.action && (
                  s.action.onClick ? (
                    <Button variant="outline" size="sm" className="border-border/70" onClick={() => s.action!.onClick!()}>
                      {s.action.text}
                      <ChevronRight className="w-3 h-3 ms-1" />
                    </Button>
                  ) : s.action.link ? (
                    <Link to={s.action.link}>
                      <Button variant="outline" size="sm" className="border-border/70">
                        {s.action.text}
                        <ChevronRight className="w-3 h-3 ms-1" />
                      </Button>
                    </Link>
                  ) : null
                )}
              </GradientRingCard>
            </Reveal>
          );
        })}
      </div>
    </section>
  );
}

export const defaultN8nSteps: QuickStartStep[] = [
  {
    step: 1,
    title: "Get Your Postora API Key",
    description: "Navigate to Settings → API Keys in your Postora dashboard",
    action: { text: "Get API Key", link: "/api-keys" }
  },
  {
    step: 2,
    title: "Download the Workflow Template",
    description: "Import our pre-built workflow template into n8n",
  },
  {
    step: 3,
    title: "Configure the Workflow",
    description: "Add your API key to the Configuration node in n8n"
  },
  {
    step: 4,
    title: "Test & Publish",
    description: "Run the workflow to publish to your connected platforms"
  }
];
