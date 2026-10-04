import { useAuth } from "@/hooks/useAuth";
import { Icon3D, GradientHeading, Reveal } from "@/components/fx";
import { Layers } from "lucide-react";
import {
  N8nHeader,
  N8nHero,
  QuickStartSteps,
  defaultN8nSteps,
  WorkflowDiagrams,
  PlatformCardsGrid,
  ApiEndpointsSection,
  PlatformSettingsCards,
  CompleteExampleSection,
  FailureAlertsSection,
  DownloadCTA,
  N8nFooter,
} from "@/components/n8n";

export default function N8nIntegration() {
  const { user } = useAuth();

  const downloadWorkflow = (type: 'basic' | 'complete' | 'alerts' | 'slack' = 'basic') => {
    const link = document.createElement('a');
    switch (type) {
      case 'complete':
        link.href = '/n8n-complete-workflow.json';
        link.download = 'postora-n8n-complete-workflow.json';
        break;
      case 'alerts':
        link.href = '/n8n-failure-alerts-workflow.json';
        link.download = 'postora-failure-alerts-workflow.json';
        break;
      case 'slack':
        link.href = '/n8n-slack-alerts-workflow.json';
        link.download = 'postora-slack-alerts-workflow.json';
        break;
      default:
        link.href = '/n8n-workflow-template.json';
        link.download = 'postora-n8n-workflow.json';
    }
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const steps = [
    ...defaultN8nSteps.slice(0, 1),
    {
      step: 2,
      title: "Download the Workflow Template",
      description: "Import our pre-built workflow template into n8n",
      action: { text: "Download Template", onClick: () => downloadWorkflow('basic') }
    },
    ...defaultN8nSteps.slice(2)
  ];

  return (
    <div className="min-h-screen bg-background relative overflow-hidden">
      {/* Page-wide subtle violet halo */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
      </div>
      <N8nHeader isAuthenticated={!!user} />

      <N8nHero 
        onDownloadComplete={() => downloadWorkflow('complete')}
        onDownloadBasic={() => downloadWorkflow('basic')}
      />

      <QuickStartSteps steps={steps} />

      <WorkflowDiagrams 
        onDownloadBasic={() => downloadWorkflow('basic')}
        onDownloadComplete={() => downloadWorkflow('complete')}
        onDownloadAlerts={() => downloadWorkflow('alerts')}
      />

      {/* Platform API Documentation Cards */}
      <section className="container mx-auto px-6 py-20 border-t border-border/40">
        <Reveal className="text-center mb-12">
          <div className="flex flex-col items-center gap-4">
            <Icon3D icon={Layers} variant="rose" size="md" />
            <GradientHeading as="h2" preset="amber-rose-violet" size="lg">Platform API Documentation</GradientHeading>
            <p className="text-muted-foreground max-w-2xl">
              Each platform has specific settings and requirements. Click a platform for detailed API documentation.
            </p>
          </div>
        </Reveal>
        <PlatformCardsGrid />
      </section>

      <ApiEndpointsSection />

      <PlatformSettingsCards />

      <CompleteExampleSection />

      <FailureAlertsSection 
        onDownloadAlerts={() => downloadWorkflow('alerts')}
        onDownloadSlackOnly={() => downloadWorkflow('slack')}
      />

      <DownloadCTA onDownloadComplete={() => downloadWorkflow('complete')} />

      <N8nFooter />
    </div>
  );
}
