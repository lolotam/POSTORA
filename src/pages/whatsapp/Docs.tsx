import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Clock3,
  LifeBuoy,
  PlugZap,
  ShieldCheck,
  Bot,
  Sparkles,
  Smartphone,
  Users,
  Layers,
  Settings,
  AlertCircle,
  CheckCircle2,
  Info,
  ArrowRight,
  ExternalLink,
  MessageSquareCode
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import {
  whatsappSectionDescriptions,
  whatsappSectionRoute,
} from "@/components/whatsapp/waNav";

function SectionLink({ path, children }: { path: string; children: React.ReactNode }) {
  return (
    <Link
      to={whatsappSectionRoute(path)}
      className="font-medium text-[#128C7E] underline-offset-4 hover:underline dark:text-[#25D366]"
    >
      {children}
    </Link>
  );
}

export default function WhatsAppDocs() {
  const [activeTab, setActiveTab] = useState("connection");

  return (
    <div className="space-y-6 max-w-6xl mx-auto pb-12">
      <WhatsAppPageHeader
        icon={BookOpen}
        title="Knowledge Center"
        description="Unlock the full capabilities of your WhatsApp Business integration with interactive guides and workflow diagnostics."
      />

      {/* Hero Welcome Banner */}
      <div className="relative rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-500 p-6 text-white shadow-xl md:p-8 overflow-hidden">
        <div className="relative z-10 space-y-4 max-w-3xl">
          <Badge className="bg-white/20 hover:bg-white/30 text-white border-none py-1 px-3 text-xs uppercase tracking-wider font-semibold">
            Assistant & Onboarding Guide
          </Badge>
          <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight">
            WhatsApp Business User Journey
          </h2>
          <p className="text-white/90 text-sm md:text-base leading-relaxed">
            Welcome to the central guide for your WhatsApp workspace. Here, you'll learn how to successfully connect numbers, configure chatbot logic (keyword and AI), set up campaign automation, and assign human agents.
          </p>
          <div className="flex flex-wrap gap-3 pt-2">
            <Link
              to={whatsappSectionRoute("setup")}
              className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-[#128C7E] hover:bg-white/95 transition-all shadow-sm active:scale-95"
            >
              <PlugZap className="h-4 w-4" />
              Onboarding Diagnostics
            </Link>
            <Link
              to={whatsappSectionRoute("conversations")}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-700/30 border border-white/20 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700/50 transition-all active:scale-95"
            >
              Open Shared Inbox
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
        <div className="absolute end-0 bottom-0 top-0 w-1/3 bg-[radial-gradient(circle_at_bottom_right,_var(--tw-gradient-stops))] from-white/10 via-transparent to-transparent pointer-events-none" />
      </div>

      {/* Interactive Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full space-y-6">
        <TabsList className="grid grid-cols-2 md:grid-cols-5 h-auto gap-2 bg-muted p-1.5 rounded-xl border">
          <TabsTrigger value="connection" className="gap-2 text-xs md:text-sm py-2.5">
            <Smartphone className="h-4 w-4" />
            <span>Connection & Sync</span>
          </TabsTrigger>
          <TabsTrigger value="chatbot" className="gap-2 text-xs md:text-sm py-2.5">
            <Bot className="h-4 w-4" />
            <span>Chatbot Builder</span>
          </TabsTrigger>
          <TabsTrigger value="automation" className="gap-2 text-xs md:text-sm py-2.5">
            <Layers className="h-4 w-4" />
            <span>Automated Channels</span>
          </TabsTrigger>
          <TabsTrigger value="inbox" className="gap-2 text-xs md:text-sm py-2.5">
            <Users className="h-4 w-4" />
            <span>Team Inbox</span>
          </TabsTrigger>
          <TabsTrigger value="troubleshooting" className="gap-2 text-xs md:text-sm py-2.5">
            <LifeBuoy className="h-4 w-4" />
            <span>FAQs & Help</span>
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Connection & Sync */}
        <TabsContent value="connection" className="space-y-6 animate-in fade-in duration-300">
          <div className="grid gap-6 md:grid-cols-3">
            {/* Onboarding Flow Steps */}
            <Card className="md:col-span-2 overflow-hidden border-2 border-emerald-500/10 dark:border-emerald-500/5">
              <CardHeader className="bg-emerald-500/5 dark:bg-emerald-500/10">
                <CardTitle className="flex items-center gap-2">
                  <Smartphone className="h-5 w-5 text-emerald-500" />
                  Step-by-Step Connection Journey
                </CardTitle>
                <CardDescription>
                  How new numbers are onboarded to Postora automatically. No manual server interventions required.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-6 space-y-6">
                <div className="relative ps-6 border-l-2 border-emerald-500/20 space-y-6">
                  {/* Step 1 */}
                  <div className="relative">
                    <div className="absolute -start-[31px] top-0 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-background text-[10px] font-bold text-white">1</div>
                    <h4 className="font-semibold text-foreground">Launch Embedded Signup</h4>
                    <p className="text-sm text-muted-foreground mt-1">
                      Navigate to <SectionLink path="setup">Setup</SectionLink> and click <strong>Connect with Coexistence</strong> (recommended for active phone apps) or <strong>Cloud API</strong>. A Meta onboarding popup opens.
                    </p>
                  </div>
                  {/* Step 2 */}
                  <div className="relative">
                    <div className="absolute -start-[31px] top-0 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-background text-[10px] font-bold text-white">2</div>
                    <h4 className="font-semibold text-foreground">Scan QR & Share History</h4>
                    <p className="text-sm text-muted-foreground mt-1">
                      Scan the QR code with the WhatsApp Business app on your phone, and make sure to <strong>approve chat-history sharing</strong> on the screen the phone displays.
                    </p>
                  </div>
                  {/* Step 3 */}
                  <div className="relative">
                    <div className="absolute -start-[31px] top-0 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-background text-[10px] font-bold text-white">3</div>
                    <h4 className="font-semibold text-foreground">Background Activation & Webhooks</h4>
                    <p className="text-sm text-muted-foreground mt-1">
                      The moment you complete the popup, Postora's backend exchanges the authorization code, registers your WABA, and automatically issues sync requests to Meta.
                    </p>
                  </div>
                  {/* Step 4 */}
                  <div className="relative">
                    <div className="absolute -start-[31px] top-0 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 ring-4 ring-background text-[10px] font-bold text-white">4</div>
                    <h4 className="font-semibold text-foreground">Immediate Sync & Diagnostics</h4>
                    <p className="text-sm text-muted-foreground mt-1">
                      Your chats and contacts start populating the inbox. If sync fails, use the **Sync phone chats** diagnostics button in Setup within 24 hours.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Connection Modes Info */}
            <Card className="flex flex-col justify-between">
              <CardHeader>
                <CardTitle className="text-lg">Connection Modes</CardTitle>
                <CardDescription>Two configurations mapped to your operational needs.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm flex-1">
                <div className="rounded-xl border p-4 bg-muted/40">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground">Coexistence Mode</span>
                    <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-600 border-none">Active</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    Your number keeps working in the WhatsApp Business mobile app. Postora receives duplicates, syncing your 1-to-1 conversations. Answer from either surface!
                  </p>
                </div>
                <div className="rounded-xl border p-4 bg-muted/40">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-foreground">Cloud API Mode</span>
                    <Badge variant="outline">Dedicated</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                    Postora controls the number directly. The number stops working in the phone app, sending/receiving messages solely through the high-throughput Meta Cloud API.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Phased History Sync Infographic */}
          <Card className="border-2 border-emerald-500/10 dark:border-emerald-500/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock3 className="h-5 w-5 text-emerald-500" />
                Phased History Sync (Coexistence)
              </CardTitle>
              <CardDescription>
                Meta delivers older messages in progressive waves. Here is what to expect and why older chats take time to populate.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid md:grid-cols-2 gap-6 items-center">
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    When you link a phone in coexistence mode, Meta delivers your historic chat database in **three distinct waves**. You do not need to repeat connections — just keep your phone powered on and connected to the internet.
                  </p>
                  
                  {/* Inline visual checklist of limitations */}
                  <div className="space-y-3 rounded-xl border p-4 bg-muted/30">
                    <h5 className="font-semibold text-sm flex items-center gap-2 text-foreground">
                      <AlertCircle className="h-4 w-4 text-emerald-500" />
                      Key Synchronization Rules & Limits:
                    </h5>
                    <ul className="text-xs text-muted-foreground space-y-2">
                      <li className="flex items-start gap-2">
                        <span className="text-emerald-500 font-bold">•</span>
                        <span><strong>1-to-1 Only:</strong> Meta never syncs group chats. Only direct customer chats appear.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-emerald-500 font-bold">•</span>
                        <span><strong>180-Day Cap:</strong> Conversations without active messages in the last 6 months are excluded.</span>
                      </li>
                      <li className="flex items-start gap-2">
                        <span className="text-emerald-500 font-bold">•</span>
                        <span><strong>14-Day Media:</strong> Images/files older than 2 weeks are synced as placeholders (no file download).</span>
                      </li>
                    </ul>
                  </div>
                </div>

                <div className="space-y-3">
                  <div className="relative rounded-xl overflow-hidden border bg-background shadow-md">
                    <img 
                      src="/images/whatsapp/whatsapp-sync-timeline.png" 
                      alt="WhatsApp History Sync Waves" 
                      className="w-full h-auto object-cover max-h-56 select-none"
                    />
                  </div>
                  {/* Dynamic HTML Timeline Indicator */}
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="p-2 border rounded bg-emerald-500/5 dark:bg-emerald-500/10">
                      <p className="font-bold text-emerald-600 dark:text-emerald-400">Wave 1</p>
                      <p className="text-[10px] text-muted-foreground">Last 24 Hours (Instant)</p>
                    </div>
                    <div className="p-2 border rounded bg-teal-500/5 dark:bg-teal-500/10">
                      <p className="font-bold text-teal-600 dark:text-teal-400">Wave 2</p>
                      <p className="text-[10px] text-muted-foreground">Last 90 Days (Minutes)</p>
                    </div>
                    <div className="p-2 border rounded bg-indigo-500/5 dark:bg-indigo-500/10">
                      <p className="font-bold text-indigo-600 dark:text-indigo-400">Wave 3</p>
                      <p className="text-[10px] text-muted-foreground">90–180 Days (Hours)</p>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 2: Chatbot Builder */}
        <TabsContent value="chatbot" className="space-y-6 animate-in fade-in duration-300">
          <div className="grid gap-6 md:grid-cols-2">
            {/* Level 1 Card */}
            <Card className="flex flex-col justify-between border-2 border-emerald-500/10">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-xs">Level 1 — Default</Badge>
                  <MessageSquareCode className="h-5 w-5 text-emerald-500" />
                </div>
                <CardTitle className="text-xl mt-2">Keyword Auto-Replies</CardTitle>
                <CardDescription>Rules-based responder built directly into Postora.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm flex-1">
                <p className="text-muted-foreground">
                  A pure rules responder that matches incoming message text instantly. Setup is done in the <Link
      to="/automation/agents?platform=whatsapp&surface=dms"
      className="font-medium text-[#128C7E] underline-offset-4 hover:underline dark:text-[#25D366]"
    >
      Auto Replies
    </Link> page.
                </p>
                <ul className="space-y-2 text-xs text-muted-foreground bg-muted/40 p-3 rounded-lg">
                  <li><strong>Keyword Rules:</strong> e.g., if message contains <code>["hours", "open"]</code> → send "We are open Sat-Thu, 9am-9pm."</li>
                  <li><strong>Away Rules:</strong> Out-of-office reply based on custom time windows.</li>
                  <li><strong>Anti-Spam Cooldown:</strong> Hardcoded 5-minute cooldown per conversation to avoid loop execution.</li>
                </ul>
              </CardContent>
            </Card>

            {/* Level 2 Card */}
            <Card className="flex flex-col justify-between border-2 border-emerald-500/10">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <Badge variant="secondary" className="bg-[#25D366]/10 text-emerald-600 border-none text-xs">Level 2 — Advanced</Badge>
                  <Sparkles className="h-5 w-5 text-emerald-500" />
                </div>
                <CardTitle className="text-xl mt-2">Real AI Chatbot (Webhooks)</CardTitle>
                <CardDescription>Connect Postora to n8n workflows and LLMs.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm flex-1">
                <p className="text-muted-foreground">
                  Postora does not host an AI chatbot. Instead, connect outbound triggers in <SectionLink path="webhooks">Webhooks</SectionLink> to run a visual workflow inside n8n:
                </p>
                <ul className="space-y-2 text-xs text-muted-foreground bg-muted/40 p-3 rounded-lg">
                  <li><strong>Ingest:</strong> Message received event triggers webhook.</li>
                  <li><strong>Analyze:</strong> n8n workflow queries an LLM (e.g. OpenAI) with your FAQ context.</li>
                  <li><strong>Reply:</strong> n8n hits Postora API endpoint (<code>whatsapp_send_message</code>) to reply.</li>
                  <li><strong>Security:</strong> All webhooks are HMAC-signed; auto-disable after 10 failed runs.</li>
                </ul>
              </CardContent>
            </Card>
          </div>

          {/* Webhook AI Diagram */}
          <Card className="border-2 border-emerald-500/10 dark:border-emerald-500/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-emerald-500" />
                AI Chatbot Webhook Diagram (n8n Integration)
              </CardTitle>
              <CardDescription>
                The complete visual data loop from a customer's incoming message to an automated AI response.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid md:grid-cols-2 gap-6 items-center">
                <div className="relative rounded-xl overflow-hidden border bg-background shadow-md">
                  <img 
                    src="/images/whatsapp/whatsapp-chatbot-flow.png" 
                    alt="Webhook AI chatbot flow diagram" 
                    className="w-full h-auto object-cover max-h-60 select-none"
                  />
                </div>

                <div className="space-y-4">
                  <div className="rounded-xl border p-4 bg-amber-500/5 dark:bg-amber-500/10 border-amber-500/20">
                    <h5 className="font-semibold text-sm flex items-center gap-2 text-amber-600 dark:text-amber-400">
                      <Clock3 className="h-4 w-4" />
                      Important: The 24-Hour Rule
                    </h5>
                    <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                      WhatsApp restricts free-form text messages to within 24 hours of the customer's last incoming text. Your n8n/AI chatbot must be built to recognize this window and fall back to an approved <strong>Template message</strong> (or stay silent) after 24 hours.
                    </p>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Because Postora provides a native n8n community node (<code>n8n-nodes-postora</code>), you can visually build and scale the AI chatbot directly in n8n, handling contacts and messages easily.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 3: Automated Channels */}
        <TabsContent value="automation" className="space-y-6 animate-in fade-in duration-300">
          <Card className="border-2 border-emerald-500/10">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-emerald-500" />
                Automated Messaging Channels
              </CardTitle>
              <CardDescription>
                Postora provides four distinct channels to automate your WhatsApp communication.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm border-collapse">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="p-4 font-semibold text-foreground">Channel</th>
                      <th className="p-4 font-semibold text-foreground">Action Slug</th>
                      <th className="p-4 font-semibold text-foreground">Purpose</th>
                      <th className="p-4 font-semibold text-foreground">Rule Limits</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    <tr>
                      <td className="p-4 font-medium text-foreground">
                        <Link
      to="/automation/agents?platform=whatsapp&surface=dms"
      className="font-medium text-[#128C7E] underline-offset-4 hover:underline dark:text-[#25D366]"
    >
      Auto Replies
    </Link>
                      </td>
                      <td className="p-4"><code>keyword / away</code></td>
                      <td className="p-4 text-muted-foreground">Business hours, FAQs, instant auto-acknowledgment</td>
                      <td className="p-4 text-muted-foreground">5-min cooldown per conversation</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-medium text-foreground">
                        <SectionLink path="scheduled">Scheduled</SectionLink>
                      </td>
                      <td className="p-4"><code>scheduled</code></td>
                      <td className="p-4 text-muted-foreground">Appointment reminders, customer follow-up queues</td>
                      <td className="p-4 text-muted-foreground">Free-form if &lt;24h window, else template required</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-medium text-foreground">
                        <SectionLink path="broadcasts">Broadcasts</SectionLink>
                      </td>
                      <td className="p-4"><code>broadcasts</code></td>
                      <td className="p-4 text-muted-foreground">Promotions, monthly newsletters, service announcements</td>
                      <td className="p-4 text-muted-foreground">Requires approved Meta Templates</td>
                    </tr>
                    <tr>
                      <td className="p-4 font-medium text-foreground">
                        <SectionLink path="webhooks">Webhooks</SectionLink>
                      </td>
                      <td className="p-4"><code>webhooks</code></td>
                      <td className="p-4 text-muted-foreground">External custom CRM syncs, Zapier automation trigger</td>
                      <td className="p-4 text-muted-foreground">Auto-disables on 10 consecutive failures</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Note on Templates */}
              <div className="p-6 border-t bg-muted/10 space-y-4">
                <h4 className="font-semibold text-foreground flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5 text-emerald-500" />
                  Prerequisite: Approved Templates
                </h4>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Before launching Broadcasts or sending Scheduled Messages outside the 24-hour window, you must configure and submit templates in the <SectionLink path="templates">Templates</SectionLink> section. Meta review generally takes 2–24 hours.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tab 4: Team Inbox */}
        <TabsContent value="inbox" className="space-y-6 animate-in fade-in duration-300">
          <div className="grid gap-6 md:grid-cols-3">
            {/* Left Column: Team Inbox Elements */}
            <Card className="md:col-span-2 border-2 border-emerald-500/10 dark:border-emerald-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-emerald-500" />
                  Shared Team Inbox & Human Agents
                </CardTitle>
                <CardDescription>
                  Collaboratively resolve messages with concurrent caps and agent assignments.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 text-sm">
                <p className="text-muted-foreground">
                  The <SectionLink path="conversations">Conversations</SectionLink> view is a real-time collaborative workspace for your support team. Human agents can easily answer, tag, and transfer threads:
                </p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="p-4 rounded-xl border bg-muted/20">
                    <h5 className="font-semibold text-foreground">Agents Registry</h5>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      Register team members in <SectionLink path="agents">Agents</SectionLink>. Agents set their status (Online/Away/Offline) and configure concurrent conversation caps.
                    </p>
                  </div>
                  <div className="p-4 rounded-xl border bg-muted/20">
                    <h5 className="font-semibold text-foreground">Canned Quick Replies</h5>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      Create shortcuts in <SectionLink path="quick-replies">Quick Replies</SectionLink> (e.g., <code>/thanks</code>) to reply consistently and speed up response times.
                    </p>
                  </div>
                  <div className="p-4 rounded-xl border bg-muted/20">
                    <h5 className="font-semibold text-foreground">Contact Labels</h5>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      Tag chats (e.g., "VIP", "Support", "Lead") in <SectionLink path="contacts">Contacts</SectionLink> to filter the shared inbox layout instantly.
                    </p>
                  </div>
                  <div className="p-4 rounded-xl border bg-muted/20">
                    <h5 className="font-semibold text-foreground">Analytics Tracker</h5>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      Monitor message volume trends, average agent response times, and quick reply statistics in <SectionLink path="analytics">Analytics</SectionLink>.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Visual Workspace & Handoff */}
            <Card className="flex flex-col justify-between">
              <CardHeader>
                <CardTitle className="text-lg">Inbox Visual</CardTitle>
                <CardDescription>Human collaboration view.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 flex-1">
                <div className="relative rounded-xl overflow-hidden border bg-background shadow-md">
                  <img 
                    src="/images/whatsapp/whatsapp-team-inbox.png" 
                    alt="WhatsApp Team Inbox UI Layout" 
                    className="w-full h-auto object-cover max-h-56 select-none"
                  />
                </div>
                <div className="rounded-xl border p-3.5 bg-emerald-500/5 border-emerald-500/10">
                  <h6 className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Recommended Handoff Pattern:
                  </h6>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                    Auto-reply acknowledges instantly → if the query is unresolved → assign thread to online human agent → agent replies using canned Quick Replies → mark resolved.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 5: FAQs & Diagnostics */}
        <TabsContent value="troubleshooting" className="space-y-6 animate-in fade-in duration-300">
          <Card className="border-2 border-emerald-500/10 dark:border-emerald-500/5">
            <CardHeader className="bg-emerald-500/5 dark:bg-emerald-500/10">
              <CardTitle className="flex items-center gap-2">
                <LifeBuoy className="h-5 w-5 text-emerald-500" />
                Frequently Asked Questions
              </CardTitle>
              <CardDescription>
                Find answers to common connection, messaging, and chat synchronization problems.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-6">
              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="two-step">
                  <AccordionTrigger className="text-foreground hover:no-underline font-semibold">
                    Registration fails with error code 2388001
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground leading-relaxed text-sm pt-2">
                    This means the phone number currently has two-step verification active in the WhatsApp Business mobile application. To fix this:
                    <ol className="list-decimal ps-5 mt-2 space-y-1 text-xs">
                      <li>Open WhatsApp Business on your phone.</li>
                      <li>Navigate to Settings → Account → Two-step verification and **disable** it.</li>
                      <li>Go back to Postora Setup and reconnect the number. Once verified, you can re-enable the PIN inside the Meta App settings.</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="no-inbound">
                  <AccordionTrigger className="text-foreground hover:no-underline font-semibold">
                    Customer messages are not arriving in the inbox
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground leading-relaxed text-sm pt-2">
                    Inbound messages arrive through the Meta webhook. If they stop showing:
                    <ol className="list-decimal ps-5 mt-2 space-y-1 text-xs">
                      <li>Ask an admin to check the webhook callback URL and verify token under Meta Developer Portal.</li>
                      <li>Ensure that your WhatsApp Business Account (WABA) is subscribed specifically to the <code>messages</code> webhook field.</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="decline-history">
                  <AccordionTrigger className="text-foreground hover:no-underline font-semibold">
                    Chat history is not syncing (Error 2593109)
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground leading-relaxed text-sm pt-2">
                    This error indicates that history sharing permission was declined on the phone during the QR scan step. To resolve this:
                    <ol className="list-decimal ps-5 mt-2 space-y-1 text-xs">
                      <li>On your phone, open WhatsApp Business.</li>
                      <li>Navigate to Settings → Linked Devices (or Business Platforms) and **disconnect** Postora.</li>
                      <li>Restart the connection flow in Postora Setup, scan the QR code again, and make sure to **accept** chat history sharing when prompted.</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
                <AccordionItem value="outside-window">
                  <AccordionTrigger className="text-foreground hover:no-underline font-semibold">
                    Meta rejects sends outside the 24-hour window
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground leading-relaxed text-sm pt-2">
                    This is expected WhatsApp policy to prevent customer spam, not a Postora error. If 24 hours pass since the customer's last message, you must send an approved message template. Once the customer replies to the template, the 24-hour free-form communication window reopens.
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </CardContent>
          </Card>

          {/* Diagnostic Tool Quick Link */}
          <Card className="bg-muted/30">
            <CardContent className="p-6 flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3 text-sm">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                  <Settings className="h-5 w-5" />
                </div>
                <div>
                  <h4 className="font-semibold text-foreground">Onboarding Diagnostics Tool</h4>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Run health checks on your verify tokens, App IDs, and phone registration statuses.
                  </p>
                </div>
              </div>
              <Link
                to={whatsappSectionRoute("setup")}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 transition-all shadow-sm shrink-0"
              >
                Go to Diagnostics
                <ExternalLink className="h-4 w-4" />
              </Link>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
