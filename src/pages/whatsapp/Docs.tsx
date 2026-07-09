import type { LucideIcon } from "lucide-react";
import { BookOpen, Clock3, LifeBuoy, PlugZap, ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { WhatsAppPageHeader } from "@/components/whatsapp/WhatsAppPageHeader";
import {
  whatsappNavItems,
  whatsappSectionDescriptions,
  whatsappSectionRoute,
} from "@/components/whatsapp/waNav";

const guideSectionItems = whatsappNavItems.filter(
  (item) => item.path !== "" && item.path !== "docs"
);

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

function DocsCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#25D366]/10 text-[#128C7E] dark:text-[#25D366]">
            <Icon className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-lg">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-6 text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  );
}

function ConnectionModes() {
  return (
    <DocsCard
      icon={PlugZap}
      title="Getting started: connecting a number"
      description="Connect a WhatsApp Business number from the Setup page using Meta Embedded Signup."
    >
      <p>
        Open <SectionLink path="setup">Setup</SectionLink> and follow the Meta Embedded Signup
        dialog. Postora supports two connection modes:
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-foreground">Cloud API</p>
            <Badge variant="outline">Full API</Badge>
          </div>
          <p className="mt-2">
            Postora registers the phone number with Meta and sends and receives all messages
            through the WhatsApp Cloud API. The number can no longer be used in the WhatsApp
            Business app. Availability is controlled by an admin feature flag and enforced on the
            server.
          </p>
        </div>
        <div className="rounded-lg border p-4">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-foreground">Coexistence</p>
            <Badge variant="outline">App + Postora</Badge>
          </div>
          <p className="mt-2">
            Your number keeps working in the WhatsApp Business app while Postora receives a copy
            of conversations through webhooks. Phone registration is skipped, so you can answer
            from either place.
          </p>
        </div>
      </div>
    </DocsCard>
  );
}

function MessagingRules() {
  return (
    <DocsCard
      icon={Clock3}
      title="Messaging rules: the 24-hour window"
      description="WhatsApp only allows free-form replies inside a 24-hour customer service window."
    >
      <p>
        You can send free-form messages to a customer only within 24 hours of their last message
        to you. Outside that window, WhatsApp rejects free-form sends — you must use a message
        template that Meta has approved.
      </p>
      <p>
        Manage and submit templates in the <SectionLink path="templates">Templates</SectionLink>{" "}
        section. Broadcasts and scheduled messages to contacts outside the window must also use
        approved templates.
      </p>
    </DocsCard>
  );
}

function SectionGuide() {
  return (
    <DocsCard
      icon={BookOpen}
      title="Section guide"
      description="What each part of the WhatsApp mini-app does."
    >
      <ul className="grid gap-2 md:grid-cols-2">
        {guideSectionItems.map((item) => (
          <li key={item.path} className="rounded-lg border p-3">
            <Link
              to={whatsappSectionRoute(item.path)}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              {item.label}
            </Link>
            <p className="mt-1 text-sm text-muted-foreground">
              {whatsappSectionDescriptions[item.path]}
            </p>
          </li>
        ))}
      </ul>
    </DocsCard>
  );
}

function Troubleshooting() {
  return (
    <DocsCard
      icon={LifeBuoy}
      title="Troubleshooting"
      description="Common connection and delivery problems, and where to look first."
    >
      <p>
        Start with the diagnostics on the <SectionLink path="setup">Setup</SectionLink> page — it
        validates the Meta configuration and your connected number.
      </p>
      <Accordion type="single" collapsible className="w-full">
        <AccordionItem value="two-step">
          <AccordionTrigger>Registration fails with error 2388001</AccordionTrigger>
          <AccordionContent className="text-muted-foreground">
            The phone number has two-step verification enabled in the WhatsApp Business app.
            Disable it in the app (Settings → Account → Two-step verification), then reconnect the
            number from the Setup page so registration can complete.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="no-inbound">
          <AccordionTrigger>Messages are not arriving in the inbox</AccordionTrigger>
          <AccordionContent className="text-muted-foreground">
            Inbound messages arrive through the Meta webhook. Ask an admin to confirm the webhook
            callback URL and verify token in the Meta App Dashboard, and that the WhatsApp
            Business Account is subscribed to the <code>messages</code> webhook field.
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="outside-window">
          <AccordionTrigger>Sends are rejected outside the 24-hour window</AccordionTrigger>
          <AccordionContent className="text-muted-foreground">
            This is expected WhatsApp behavior, not a Postora error. Re-engage the customer with
            an approved template from the Templates section; once they reply, the 24-hour
            free-form window reopens.
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </DocsCard>
  );
}

function AdminNotes() {
  return (
    <DocsCard
      icon={ShieldCheck}
      title="For admins"
      description="Platform-side configuration lives outside this page."
    >
      <p>
        Admins can open the step-by-step Meta App Dashboard guide (domains, Embedded Signup
        configurations, permissions, webhook fields) on the{" "}
        <SectionLink path="setup">Setup</SectionLink> page. Full self-hosting documentation —
        required secrets, feature-flag SQL, and deployment notes — lives in the repository under{" "}
        <code>docs/whatsapp/</code>.
      </p>
    </DocsCard>
  );
}

export default function WhatsAppDocs() {
  return (
    <div className="space-y-6">
      <WhatsAppPageHeader
        icon={BookOpen}
        title="Docs"
        description={whatsappSectionDescriptions.docs}
      />
      <ConnectionModes />
      <MessagingRules />
      <SectionGuide />
      <Troubleshooting />
      <AdminNotes />
    </div>
  );
}
