import { cn } from "@/lib/utils";
import { 
  CheckCircle2, 
  Clock, 
  Send, 
  AlertTriangle, 
  XCircle,
  Mail,
  MessageSquare,
  Eye,
  MousePointer
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type DeliveryStatus = 
  | "sent" 
  | "delivered" 
  | "bounced" 
  | "complaint" 
  | "pending" 
  | "received" 
  | "replied"
  | "failed"
  | "processing";

interface MessageMetadata {
  open_count?: number;
  first_opened_at?: string;
  click_count?: number;
  first_clicked_at?: string;
  [key: string]: unknown;
}

interface DeliveryStatusBadgeProps {
  status: string;
  direction: "inbound" | "outbound";
  className?: string;
  showLabel?: boolean;
  metadata?: MessageMetadata | null;
}

const statusConfig: Record<DeliveryStatus, {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  description: string;
  colorClass: string;
  bgClass: string;
}> = {
  sent: {
    icon: Send,
    label: "Sent",
    description: "Email sent to mail server",
    colorClass: "text-blue-500",
    bgClass: "bg-blue-500/10",
  },
  delivered: {
    icon: CheckCircle2,
    label: "Delivered",
    description: "Email successfully delivered to inbox",
    colorClass: "text-green-500",
    bgClass: "bg-green-500/10",
  },
  bounced: {
    icon: XCircle,
    label: "Bounced",
    description: "Email could not be delivered",
    colorClass: "text-red-500",
    bgClass: "bg-red-500/10",
  },
  complaint: {
    icon: AlertTriangle,
    label: "Spam",
    description: "Recipient marked as spam",
    colorClass: "text-orange-500",
    bgClass: "bg-orange-500/10",
  },
  pending: {
    icon: Clock,
    label: "Pending",
    description: "Email is being processed",
    colorClass: "text-yellow-500",
    bgClass: "bg-yellow-500/10",
  },
  received: {
    icon: Mail,
    label: "Received",
    description: "Email received in inbox",
    colorClass: "text-blue-500",
    bgClass: "bg-blue-500/10",
  },
  replied: {
    icon: MessageSquare,
    label: "Replied",
    description: "You replied to this email",
    colorClass: "text-green-500",
    bgClass: "bg-green-500/10",
  },
  failed: {
    icon: XCircle,
    label: "Failed",
    description: "Email failed to send",
    colorClass: "text-red-500",
    bgClass: "bg-red-500/10",
  },
  processing: {
    icon: Clock,
    label: "Processing",
    description: "Awaiting delivery confirmation",
    colorClass: "text-yellow-500",
    bgClass: "bg-yellow-500/10",
  },
};

export function DeliveryStatusBadge({ 
  status, 
  direction, 
  className,
  showLabel = false,
  metadata 
}: DeliveryStatusBadgeProps) {
  // For inbound messages, only show "replied" status
  if (direction === "inbound" && status !== "replied") {
    return null;
  }

  // Use the actual status from database - only show "processing" if status is literally "sent" or "processing"
  // When webhook updates status to "delivered", show that
  const normalizedStatus = status?.toLowerCase() || "pending";
  const displayStatus: DeliveryStatus = 
    normalizedStatus === "sent" ? "processing" : // "sent" means awaiting delivery confirmation
    normalizedStatus === "processing" ? "processing" :
    normalizedStatus === "delivered" ? "delivered" :
    normalizedStatus === "bounced" ? "bounced" :
    normalizedStatus === "complaint" ? "complaint" :
    normalizedStatus === "failed" ? "failed" :
    normalizedStatus === "replied" ? "replied" :
    normalizedStatus === "received" ? "received" :
    "pending";

  const config = statusConfig[displayStatus] || statusConfig.pending;
  const Icon = config.icon;
  
  // Extract tracking data
  const openCount = metadata?.open_count || 0;
  const clickCount = metadata?.click_count || 0;
  const firstOpenedAt = metadata?.first_opened_at;
  const firstClickedAt = metadata?.first_clicked_at;

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      {/* Status Badge */}
      <TooltipProvider>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex items-center gap-1 text-xs rounded-full",
                showLabel && "px-2 py-0.5",
                config.bgClass,
                config.colorClass
              )}
            >
              <Icon className="w-3 h-3" />
              {showLabel && <span>{config.label}</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="text-xs">
            <p className="font-medium">{config.label}</p>
            <p className="text-muted-foreground">{config.description}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Open Tracking Badge */}
      {direction === "outbound" && openCount > 0 && (
        <TooltipProvider>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <span
                className="inline-flex items-center gap-0.5 text-xs rounded-full px-1.5 py-0.5 bg-muted text-foreground"
              >
                <Eye className="w-3 h-3" />
                <span>{openCount}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <p className="font-medium">Opened {openCount} time{openCount > 1 ? 's' : ''}</p>
              {firstOpenedAt && (
                <p className="text-muted-foreground">
                  First opened: {new Date(firstOpenedAt).toLocaleString()}
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Click Tracking Badge */}
      {direction === "outbound" && clickCount > 0 && (
        <TooltipProvider>
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <span
                className="inline-flex items-center gap-0.5 text-xs rounded-full px-1.5 py-0.5 bg-cyan-500/10 text-cyan-500"
              >
                <MousePointer className="w-3 h-3" />
                <span>{clickCount}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              <p className="font-medium">Clicked {clickCount} time{clickCount > 1 ? 's' : ''}</p>
              {firstClickedAt && (
                <p className="text-muted-foreground">
                  First clicked: {new Date(firstClickedAt).toLocaleString()}
                </p>
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}