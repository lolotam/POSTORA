import type { LucideIcon } from "lucide-react";

interface WhatsAppPageHeaderProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

export function WhatsAppPageHeader({ icon: Icon, title, description }: WhatsAppPageHeaderProps) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#25D366]/10 text-[#128C7E] ring-1 ring-[#25D366]/25 dark:bg-[#25D366]/20 dark:text-[#25D366]">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}
