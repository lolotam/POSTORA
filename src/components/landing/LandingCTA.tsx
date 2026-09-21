import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal, BlobHero, GradientHeading } from "@/components/fx";

export default function LandingCTA() {
  return (
    <section className="relative z-10 container mx-auto px-6 pb-20">
      <div className="group relative rounded-3xl overflow-hidden">
        <div aria-hidden className="absolute -inset-0.5 rounded-3xl bg-gradient-to-br from-sky-500 via-violet-500 to-pink-500 opacity-60 blur transition-opacity duration-500 group-hover:opacity-90" />
        <div className="relative rounded-3xl border border-border/60 bg-card/85 backdrop-blur-md overflow-hidden">
          <BlobHero preset="sky-violet-pink" />
          <div className="relative p-12 md:p-20 text-center">
            <Reveal>
              <GradientHeading preset="sky-violet-pink" size="xl">
                Ready to streamline your social media?
              </GradientHeading>
            </Reveal>
            <Reveal delay={120}>
              <p className="mt-4 text-muted-foreground mb-8 max-w-xl mx-auto">
                Join thousands of creators and marketers who save hours every week with Postora.
              </p>
            </Reveal>
            <Reveal delay={240}>
              <a href="https://postora.cloud/auth?mode=signup">
                <Button size="lg" variant="gradient">
                  Get Started for Free
                  <ArrowRight className="w-4 h-4 ms-2" />
                </Button>
              </a>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}
