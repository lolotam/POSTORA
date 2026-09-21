import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Download, FileJson, Key } from "lucide-react";
import { Icon3D, GradientHeading, GradientRingCard, Reveal } from "@/components/fx";

interface DownloadCTAProps {
  onDownloadComplete: () => void;
}

export function DownloadCTA({ onDownloadComplete }: DownloadCTAProps) {
  return (
    <section className="container mx-auto px-6 py-20">
      <Reveal>
        <GradientRingCard variant="violet" ringIntensity="strong" hoverLift={false}>
          <div className="flex flex-col items-center text-center py-6">
            <Icon3D icon={FileJson} variant="violet" size="lg" className="mb-5" />
            <GradientHeading as="h2" preset="sky-violet-pink" size="lg" className="mb-3">
              Ready to Automate?
            </GradientHeading>
            <p className="text-muted-foreground mb-8 max-w-md">
              Download our pre-built n8n workflow templates and start automating in minutes.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <Button onClick={onDownloadComplete} size="lg" className="bg-gradient-to-r from-violet-500 via-fuchsia-500 to-pink-500 text-white shadow-lg shadow-violet-500/30 hover:opacity-90">
                <Download className="w-4 h-4 me-2" />
                Download Complete Workflow
              </Button>
              <Link to="/api-keys">
                <Button variant="outline" size="lg" className="border-violet-500/50 hover:bg-violet-500/10">
                  <Key className="w-4 h-4 me-2" />
                  Get Your API Key
                </Button>
              </Link>
            </div>
          </div>
        </GradientRingCard>
      </Reveal>
    </section>
  );
}
