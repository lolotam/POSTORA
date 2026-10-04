import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Download, Key, Terminal, Zap } from "lucide-react";
import { Icon3D, GradientHeading, GradientRingCard, Reveal } from "@/components/fx";

interface N8nHeroProps {
  onDownloadComplete: () => void;
  onDownloadBasic: () => void;
}

export function N8nHero({ onDownloadComplete, onDownloadBasic }: N8nHeroProps) {
  return (
    <section className="relative overflow-hidden border-b border-border/60">
      {/* Background orbs */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
      </div>

      <div className="container relative mx-auto px-6 py-20 text-center">
        <Reveal className="flex flex-col items-center">
          <Icon3D icon={Zap} variant="violet" size="lg" className="mb-6" />
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-border bg-muted mb-6">
            <Zap className="w-3.5 h-3.5 text-foreground" />
            <span className="text-xs font-medium text-foreground">n8n Automation</span>
          </div>
          <GradientHeading as="h1" preset="sky-violet-pink" size="2xl" className="mb-5">
            n8n Integration Guide
          </GradientHeading>
          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
            Automate your social media publishing with n8n workflows. Post to Instagram, Facebook, TikTok, YouTube, and more with a single HTTP request.
          </p>
        </Reveal>

        <Reveal delay={120}>
          <GradientRingCard variant="violet" hoverLift={false} padded={false} className="max-w-3xl mx-auto">
            <div className="flex flex-wrap justify-center gap-3 p-5">
              <Button onClick={onDownloadComplete} size="lg" className="text-white shadow-lg hover:opacity-90 bg-neutral-900 dark:bg-neutral-800">
                <Download className="w-4 h-4 me-2" />
                Complete Workflow
              </Button>
              <Button onClick={onDownloadBasic} size="lg" variant="outline" className="border-input hover:bg-muted">
                <Download className="w-4 h-4 me-2" />
                Basic Workflow
              </Button>
              <Link to="/api-keys">
                <Button variant="outline" size="lg" className="border-border/70">
                  <Key className="w-4 h-4 me-2" />
                  Get API Key
                </Button>
              </Link>
              <Link to="/docs/playground">
                <Button variant="outline" size="lg" className="border-border/70">
                  <Terminal className="w-4 h-4 me-2" />
                  API Playground
                </Button>
              </Link>
            </div>
          </GradientRingCard>
        </Reveal>
      </div>
    </section>
  );
}
