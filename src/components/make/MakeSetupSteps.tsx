import { Card } from "@/components/ui/card";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ChevronRight } from "lucide-react";

export function MakeSetupSteps() {
  const steps = [
    {
      step: 1,
      title: "Get Your Postora API Key",
      description: "Navigate to Settings → API Keys in your Postora dashboard to generate an API key.",
      action: { text: "Get API Key", link: "/api-keys" },
    },
    {
      step: 2,
      title: "Create a Custom App in Make.com",
      description: "Go to Make.com → Custom Apps → Create a new app. Name it 'Postora'.",
    },
    {
      step: 3,
      title: "Import Module Configs",
      description: "Copy the JSON configurations into each module's Communication and Parameters tabs.",
    },
    {
      step: 4,
      title: "Build Your Scenario",
      description: "Add Postora modules to any Make.com scenario and connect your API key.",
    },
  ];

  return (
    <section className="container mx-auto px-6 py-16">
      <h2 className="text-3xl font-bold text-center mb-12">Quick Start Guide</h2>
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
        {steps.map((s) => (
          <Card key={s.step} className="p-6 bg-card/50 relative">
            <div className="w-10 h-10 rounded-full bg-[#6E00FF]/10 flex items-center justify-center mb-4">
              <span className="text-[#6E00FF] font-bold">{s.step}</span>
            </div>
            <h3 className="font-semibold mb-2">{s.title}</h3>
            <p className="text-sm text-muted-foreground mb-4">{s.description}</p>
            {s.action?.link && (
              <Link to={s.action.link}>
                <Button variant="outline" size="sm">
                  {s.action.text}
                  <ChevronRight className="w-3 h-3 ms-1" />
                </Button>
              </Link>
            )}
          </Card>
        ))}
      </div>
    </section>
  );
}
