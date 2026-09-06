import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { MoreVertical } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { WhatsAppConnectionMode } from "../domain/whatsappCapabilities";
import {
  revokeCapability,
  revokeDisabledLabel,
} from "../domain/whatsappCapabilities";
import type { WhatsAppMessage } from "../application/ports";

export const LONG_PRESS_MS = 450;

interface WhatsAppMessageContextMenuProps {
  message: WhatsAppMessage;
  connectionMode: WhatsAppConnectionMode;
  children: ReactNode;
  onCopy(): void;
  onForward(): void;
  onPin(): void;
  onUnpin(): void;
  onHide(): void;
  onRevoke(): void;
}

interface ActionListProps {
  variant: "context" | "dropdown";
  pinned: boolean;
  revokeEnabled: boolean;
  revokeReason: string | null;
  onCopy(): void;
  onForward(): void;
  onTogglePin(): void;
  onHide(): void;
  onAskRevoke(): void;
}

function WhatsAppMessageActionList({
  variant,
  pinned,
  revokeEnabled,
  revokeReason,
  onCopy,
  onForward,
  onTogglePin,
  onHide,
  onAskRevoke,
}: ActionListProps): JSX.Element {
  const Item = variant === "context" ? ContextMenuItem : DropdownMenuItem;
  const Sub = variant === "context" ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger = variant === "context" ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent = variant === "context" ? ContextMenuSubContent : DropdownMenuSubContent;

  return (
    <>
      <Item onSelect={onCopy}>Copy</Item>
      <Item onSelect={onForward}>Forward</Item>
      <Item onSelect={onTogglePin}>{pinned ? "Unpin" : "Pin"}</Item>
      <Sub>
        <SubTrigger>Delete</SubTrigger>
        <SubContent forceMount>
          <Item onSelect={onHide}>Delete for me</Item>
          <Item
            disabled={!revokeEnabled}
            title={revokeReason ?? undefined}
            onSelect={(event) => {
              event.preventDefault();
              if (!revokeEnabled) return;
              onAskRevoke();
            }}
          >
            Delete for everyone
          </Item>
        </SubContent>
      </Sub>
    </>
  );
}

export function WhatsAppMessageContextMenu({
  message,
  connectionMode,
  children,
  onCopy,
  onForward,
  onPin,
  onUnpin,
  onHide,
  onRevoke,
}: WhatsAppMessageContextMenuProps): JSX.Element {
  const [, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = () => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  useEffect(() => () => clearTimer(), []);

  const revoke = revokeCapability(connectionMode, message.direction, message.provider_message_id);
  const revokeReason = revokeDisabledLabel(revoke.reason);
  const pinned = Boolean(message.pinned_at);
  const listProps: Omit<ActionListProps, "variant"> = {
    pinned,
    revokeEnabled: revoke.enabled,
    revokeReason,
    onCopy,
    onForward,
    onTogglePin: pinned ? onUnpin : onPin,
    onHide,
    onAskRevoke: () => {
      setMenuOpen(false);
      setConfirmOpen(true);
    },
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setMenuOpen(true);
    }, LONG_PRESS_MS);
  };

  return (
    <div className="group relative">
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          <div
            data-testid="wa-bubble"
            data-message-id={message.id}
            className="relative"
            onContextMenu={() => setMenuOpen(true)}
            onPointerDown={onPointerDown}
            onPointerMove={clearTimer}
            onPointerUp={clearTimer}
            onPointerCancel={clearTimer}
          >
            {children}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <WhatsAppMessageActionList variant="context" {...listProps} />
        </ContextMenuContent>
      </ContextMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Message actions"
            className={cn(
              "absolute right-0 top-6 z-10 rounded-md p-1 text-muted-foreground opacity-0",
              "hover:bg-muted hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <WhatsAppMessageActionList variant="dropdown" {...listProps} />
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete for everyone?</AlertDialogTitle>
            <AlertDialogDescription>
              This message will be deleted for everyone in this chat. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                onRevoke();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
