import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Download, Key, Terminal, Zap } from "lucide-react";

interface MakeHeroProps {
  onDownloadAll: () => void;
}

export function MakeHero({ onDownloadAll }: MakeHeroProps) {
  return (
    <section className="border-b border-border bg-gradient-to-b from-[#6E00FF]/5 to-transparent">
      <div className="container mx-auto px-6 py-16 text-center">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-[#6E00FF]/30 bg-[#6E00FF]/10 mb-6">
          <Zap className="w-4 h-4 text-[#6E00FF]" />
          <span className="text-sm text-[#6E00FF]">Make.com Automation</span>
        </div>
        <h1 className="text-4xl md:text-5xl font-bold mb-4">Make.com Integration Guide</h1>
        <p className="text-xl text-muted-foreground max-w-2xl mx-auto mb-8">
          Build powerful social media automation scenarios with Make.com. Publish to Instagram, Facebook, TikTok, YouTube, and more using Postora's custom app modules.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <Button onClick={onDownloadAll} size="lg" className="bg-[#6E00FF] hover:bg-[#5A00D6]">
            <Download className="w-4 h-4 me-2" />
            Download All JSON Configs
          </Button>
          <Link to="/api-keys">
            <Button variant="outline" size="lg">
              <Key className="w-4 h-4 me-2" />
              Get API Key
            </Button>
          </Link>
          <Link to="/docs/playground">
            <Button variant="outline" size="lg">
              <Terminal className="w-4 h-4 me-2" />
              API Playground
            </Button>
          </Link>
        </div>
      </div>
    </section>
  );
}
