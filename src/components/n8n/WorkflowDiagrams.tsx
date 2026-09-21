import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  ArrowRight, Check, Download, Play, Settings, Upload, 
  Globe, FileJson, Users, MessageSquare, Zap, Workflow 
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Icon3D, GradientHeading, GradientRingCard, Reveal } from "@/components/fx";

interface WorkflowDiagramsProps {
  onDownloadBasic: () => void;
  onDownloadComplete: () => void;
  onDownloadAlerts: () => void;
}

export function WorkflowDiagrams({ onDownloadBasic, onDownloadComplete, onDownloadAlerts }: WorkflowDiagramsProps) {
  return (
    <section className="container mx-auto px-6 py-20 border-t border-border/40">
      <Reveal className="text-center mb-12">
        <div className="flex flex-col items-center gap-4">
          <Icon3D icon={Workflow} variant="indigo" size="md" />
          <GradientHeading as="h2" preset="violet-sky" size="lg">Workflow Diagrams</GradientHeading>
          <p className="text-muted-foreground max-w-2xl">
            Visual preview of how the n8n workflows are structured.
          </p>
        </div>
      </Reveal>

      <Tabs defaultValue="basic" className="max-w-5xl mx-auto">
        <TabsList className="grid w-full grid-cols-3 mb-8 bg-card/50 backdrop-blur-md border border-border/40 rounded-xl p-1 h-auto
          [&>[data-state=active]]:bg-gradient-to-r [&>[data-state=active]]:from-violet-500
          [&>[data-state=active]]:via-fuchsia-500 [&>[data-state=active]]:to-pink-500
          [&>[data-state=active]]:text-white [&>[data-state=active]]:shadow-md">
          <TabsTrigger value="basic">Basic Workflow</TabsTrigger>
          <TabsTrigger value="complete">Complete Workflow</TabsTrigger>
          <TabsTrigger value="alerts">Failure Alerts</TabsTrigger>
        </TabsList>
        
        {/* Basic Workflow Diagram */}
        <TabsContent value="basic">
          <GradientRingCard variant="sky" ringIntensity="subtle" hoverLift={false}>
            <h3 className="text-xl font-bold mb-6 text-center">Basic Publishing Workflow</h3>
            <div className="flex flex-col lg:flex-row items-center justify-center gap-4 lg:gap-6">
              {[
                { icon: Play, label: "Manual Trigger", desc: "Start workflow", color: "bg-blue-500/20 text-blue-500" },
                { icon: Settings, label: "Configuration", desc: "Set API Key", color: "bg-purple-500/20 text-purple-500" },
                { icon: Upload, label: "Upload Media", desc: "HTTP Request", color: "bg-emerald-500/20 text-emerald-500" },
                { icon: MessageSquare, label: "Create Post", desc: "HTTP Request", color: "bg-orange-500/20 text-orange-500" },
                { icon: Globe, label: "Published!", desc: "All platforms", color: "bg-green-500/20 text-green-500" }
              ].map((node, i) => (
                <div key={i} className="flex items-center gap-4">
                  <div className="relative group">
                    <Card className="p-4 bg-background/80 backdrop-blur text-center min-w-[130px] hover:scale-105 transition-transform border-2 hover:border-primary/50">
                      <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-2", node.color)}>
                        <node.icon className="w-6 h-6" />
                      </div>
                      <h4 className="font-semibold text-sm">{node.label}</h4>
                      <p className="text-xs text-muted-foreground">{node.desc}</p>
                    </Card>
                    <div className="absolute -bottom-1 start-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-primary/50 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  {i < 4 && <ArrowRight className="w-5 h-5 text-muted-foreground hidden lg:block animate-pulse" />}
                </div>
              ))}
            </div>
            <div className="mt-6 flex justify-center">
              <Button onClick={onDownloadBasic} variant="outline" size="sm" className="border-sky-500/50 hover:bg-sky-500/10">
                <Download className="w-4 h-4 me-2" />
                Download This Workflow
              </Button>
            </div>
          </GradientRingCard>
        </TabsContent>
        
        {/* Complete Workflow Diagram */}
        <TabsContent value="complete">
          <GradientRingCard variant="violet" ringIntensity="subtle" hoverLift={false}>
            <h3 className="text-xl font-bold mb-6 text-center">Complete Multi-Upload Workflow</h3>
            
            {/* Trigger and Config Row */}
            <div className="flex justify-center gap-6 mb-6">
              <Card className="p-3 bg-blue-500/10 border-blue-500/30 text-center min-w-[120px]">
                <Play className="w-8 h-8 mx-auto mb-1 text-blue-500" />
                <p className="text-xs font-semibold">Manual Trigger</p>
              </Card>
              <ArrowRight className="w-5 h-5 text-muted-foreground self-center" />
              <Card className="p-3 bg-purple-500/10 border-purple-500/30 text-center min-w-[120px]">
                <Settings className="w-8 h-8 mx-auto mb-1 text-purple-500" />
                <p className="text-xs font-semibold">Configuration</p>
              </Card>
            </div>
            
            {/* Branch indicator */}
            <div className="flex justify-center mb-4">
              <div className="w-px h-8 bg-gradient-to-b from-purple-500/50 to-emerald-500/50" />
            </div>
            
            {/* Three Upload Methods */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
              {[
                { label: "URL Upload", desc: "media_urls array", icon: Globe },
                { label: "Form-Data", desc: "files[] binary", icon: Upload },
                { label: "Base64", desc: "files_data array", icon: FileJson },
                { label: "Binary Data", desc: "n8n binary input", icon: Zap }
              ].map((method, i) => (
                <Card key={i} className="p-4 bg-emerald-500/10 border-emerald-500/30 text-center">
                  <method.icon className="w-8 h-8 mx-auto mb-2 text-emerald-500" />
                  <p className="text-sm font-semibold">{method.label}</p>
                  <p className="text-xs text-muted-foreground">{method.desc}</p>
                </Card>
              ))}
            </div>
            
            {/* Merge and Post */}
            <div className="flex justify-center items-center gap-6">
              <Card className="p-3 bg-yellow-500/10 border-yellow-500/30 text-center min-w-[120px]">
                <Users className="w-8 h-8 mx-auto mb-1 text-yellow-500" />
                <p className="text-xs font-semibold">Merge Results</p>
              </Card>
              <ArrowRight className="w-5 h-5 text-muted-foreground" />
              <Card className="p-3 bg-orange-500/10 border-orange-500/30 text-center min-w-[120px]">
                <MessageSquare className="w-8 h-8 mx-auto mb-1 text-orange-500" />
                <p className="text-xs font-semibold">Create Post</p>
              </Card>
              <ArrowRight className="w-5 h-5 text-muted-foreground" />
              <Card className="p-3 bg-green-500/10 border-green-500/30 text-center min-w-[120px]">
                <Check className="w-8 h-8 mx-auto mb-1 text-green-500" />
                <p className="text-xs font-semibold">Success!</p>
              </Card>
            </div>
            
            <div className="mt-6 flex justify-center">
              <Button onClick={onDownloadComplete} variant="outline" size="sm" className="border-violet-500/50 hover:bg-violet-500/10">
                <Download className="w-4 h-4 me-2" />
                Download This Workflow
              </Button>
            </div>
          </GradientRingCard>
        </TabsContent>
        
        {/* Failure Alerts Diagram */}
        <TabsContent value="alerts">
          <GradientRingCard variant="amber" ringIntensity="subtle" hoverLift={false}>
            <h3 className="text-xl font-bold mb-6 text-center">Failure Alerts Workflow</h3>
            
            {/* Webhook Trigger */}
            <div className="flex justify-center mb-6">
              <Card className="p-4 bg-orange-500/10 border-orange-500/30 text-center min-w-[160px]">
                <Zap className="w-10 h-10 mx-auto mb-2 text-orange-500" />
                <p className="font-semibold">Webhook Trigger</p>
                <p className="text-xs text-muted-foreground">Receives Postora events</p>
              </Card>
            </div>
            
            {/* Decision Branch */}
            <div className="flex justify-center mb-4">
              <div className="w-px h-6 bg-muted-foreground/30" />
            </div>
            
            <div className="flex justify-center mb-4">
              <Card className="p-3 bg-blue-500/10 border-blue-500/30 text-center">
                <p className="text-sm font-semibold">Is Post Failed?</p>
                <p className="text-xs text-muted-foreground">IF condition check</p>
              </Card>
            </div>
            
            {/* Two Branches */}
            <div className="flex justify-center gap-2 mb-4">
              <div className="w-24 h-px bg-red-500/50 self-center" />
              <span className="text-xs text-muted-foreground">Yes</span>
              <div className="w-24 h-px bg-green-500/50 self-center" />
              <span className="text-xs text-muted-foreground">No</span>
            </div>
            
            <div className="grid grid-cols-2 gap-8">
              {/* Failed Path */}
              <div className="space-y-4">
                <Card className="p-4 bg-red-500/10 border-red-500/30 text-center">
                  <div className="flex items-center justify-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded bg-[#4A154B] flex items-center justify-center">
                      <span className="text-white text-xs font-bold">S</span>
                    </div>
                    <span className="font-semibold">Slack Alert</span>
                  </div>
                  <p className="text-xs text-muted-foreground">#social-media-alerts</p>
                </Card>
                <Card className="p-4 bg-red-500/10 border-red-500/30 text-center">
                  <div className="flex items-center justify-center gap-2 mb-2">
                    <div className="w-8 h-8 rounded bg-blue-600 flex items-center justify-center">
                      <span className="text-white text-xs font-bold">@</span>
                    </div>
                    <span className="font-semibold">Email Alert</span>
                  </div>
                  <p className="text-xs text-muted-foreground">Notify team</p>
                </Card>
              </div>
              
              {/* Success Path */}
              <div className="flex items-center justify-center">
                <Card className="p-4 bg-green-500/10 border-green-500/30 text-center">
                  <Check className="w-8 h-8 mx-auto mb-2 text-green-500" />
                  <p className="font-semibold">No Action</p>
                  <p className="text-xs text-muted-foreground">Or optional success log</p>
                </Card>
              </div>
            </div>
            
            <div className="mt-6 flex justify-center">
              <Button onClick={onDownloadAlerts} variant="outline" size="sm" className="border-amber-500/50 hover:bg-amber-500/10">
                <Download className="w-4 h-4 me-2" />
                Download This Workflow
              </Button>
            </div>
          </GradientRingCard>
        </TabsContent>
      </Tabs>
    </section>
  );
}
