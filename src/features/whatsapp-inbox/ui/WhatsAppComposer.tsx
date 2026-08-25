import { useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FileIcon, Image, Loader2, Mic, Paperclip, Send, Video, X } from "lucide-react";
import { toast } from "sonner";
import { InteractiveMessageBuilder } from "@/components/messaging/InteractiveMessageBuilder";
import { QuickReplyPicker, SlashCommandSuggestions } from "@/components/messaging/QuickReplyPicker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import { useSendMessage, type Conversation } from "@/hooks/useMessaging";
import { supabase } from "@/integrations/supabase/client";
import { buildPostoraFileName } from "@/lib/postoraFileName";
import { useWhatsAppInboxApi } from "./WhatsAppInboxApiProvider";

const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;

interface WhatsAppComposerProps {
  conversation: Conversation;
  socialAccountId: string;
}

interface MediaPreview {
  file: File;
  url: string;
  type: string;
}

function mediaTypeFor(mimeType: string): "image" | "video" | "audio" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

export function WhatsAppComposer({ conversation, socialAccountId }: WhatsAppComposerProps): JSX.Element {
  const [messageText, setMessageText] = useState("");
  const [showSlashSuggestions, setShowSlashSuggestions] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<MediaPreview | null>(null);
  const [sendingMedia, setSendingMedia] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendMutation = useSendMessage();
  const api = useWhatsAppInboxApi();
  const queryClient = useQueryClient();

  const clearPreview = (preview: MediaPreview | null) => {
    if (preview) URL.revokeObjectURL(preview.url);
    setMediaPreview(null);
  };

  const handleSendMedia = async () => {
    if (!mediaPreview) return;
    setSendingMedia(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const extension = mediaPreview.file.name.split(".").pop() || "bin";
      const path = `${user.id}/whatsapp/outbound/${await buildPostoraFileName(user.id, extension)}`;
      const { error: uploadError } = await supabase.storage
        .from("media")
        .upload(path, mediaPreview.file);
      if (uploadError) throw uploadError;

      await api.sendMedia({
        social_account_id: socialAccountId,
        recipient_phone: conversation.participant_id,
        media_path: path,
        media_type: mediaTypeFor(mediaPreview.type),
        caption: messageText.trim() || undefined,
      });

      await queryClient.invalidateQueries({ queryKey: ["messaging-messages", conversation.id] });
      toast.success("Media sent");
      clearPreview(mediaPreview);
      setMessageText("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send media");
    } finally {
      setSendingMedia(false);
    }
  };

  const handleSend = () => {
    if (!messageText.trim() && !mediaPreview) return;
    if (mediaPreview) {
      void handleSendMedia();
      return;
    }

    sendMutation.mutate(
      {
        socialAccountId,
        conversationId: conversation.id,
        message: messageText.trim(),
        platform: "whatsapp",
        recipientPhone: conversation.participant_id,
        recipientId: conversation.participant_id,
      },
      {
        onSuccess: () => {
          setMessageText("");
          toast.success("Message sent");
        },
        onError: (error) => toast.error(error.message),
      },
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleMessageChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setMessageText(value);
    const trimmed = value.trim();
    setShowSlashSuggestions(trimmed.startsWith("/") && !trimmed.includes(" "));
  };

  const handleQuickReplySelect = (message: string, quickReplyId?: string) => {
    setMessageText(message);
    setShowSlashSuggestions(false);
    if (!quickReplyId) return;
    // Fire-and-forget analytics: a failed usage log must not block the reply.
    void supabase.auth.getUser().then(({ data }) => {
      if (!data.user?.id) return;
      return supabase.from("whatsapp_quick_reply_usage").insert({
        user_id: data.user.id,
        quick_reply_id: quickReplyId,
        conversation_id: conversation.id,
      });
    });
  };

  const handleFileSelect = (accept: string) => {
    if (!fileInputRef.current) return;
    fileInputRef.current.accept = accept;
    fileInputRef.current.click();
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error("File size must be under 16MB");
      return;
    }
    clearPreview(mediaPreview);
    setMediaPreview({ file, url: URL.createObjectURL(file), type: file.type });
    event.target.value = "";
  };

  const handleSendInteractive = async (payload: unknown) => {
    try {
      await api.sendInteractive({
        social_account_id: socialAccountId,
        recipient_phone: conversation.participant_id,
        interactive: payload,
      });
      toast.success("Interactive message sent");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to send interactive message");
    }
  };

  const isSending = sendMutation.isPending || sendingMedia;

  return (
    <div className="shrink-0">
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />

      {mediaPreview && (
        <div className="border-t px-3 pt-2">
          <div className="relative inline-block">
            {mediaPreview.type.startsWith("image/") ? (
              <img src={mediaPreview.url} alt="Attachment preview" className="h-20 rounded-lg object-cover" />
            ) : mediaPreview.type.startsWith("video/") ? (
              <video src={mediaPreview.url} className="h-20 rounded-lg" />
            ) : (
              <div className="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
                <FileIcon className="h-4 w-4" />
                <span className="max-w-[200px] truncate text-xs">{mediaPreview.file.name}</span>
              </div>
            )}
            <Button
              variant="destructive"
              size="icon"
              aria-label="Remove attachment"
              className="absolute -right-2 -top-2 h-5 w-5 rounded-full"
              onClick={() => clearPreview(mediaPreview)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}

      <div className="relative border-t p-3">
        <SlashCommandSuggestions
          query={messageText.trim()}
          onSelect={handleQuickReplySelect}
          visible={showSlashSuggestions}
        />
        <div className="flex items-end gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Attach a file" className="h-9 w-9 shrink-0">
                <Paperclip className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => handleFileSelect("image/*")} className="gap-2">
                <Image className="h-4 w-4" /> Image
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleFileSelect("video/*")} className="gap-2">
                <Video className="h-4 w-4" /> Video
              </DropdownMenuItem>
              {/* An audio FILE, not a voice note: this opens the OS picker. Recording arrives in Phase 5. */}
              <DropdownMenuItem onClick={() => handleFileSelect("audio/*")} className="gap-2">
                <Mic className="h-4 w-4" /> Audio file
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleFileSelect("*/*")} className="gap-2">
                <FileIcon className="h-4 w-4" /> Document
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <QuickReplyPicker onSelect={handleQuickReplySelect} />
          <InteractiveMessageBuilder onSend={handleSendInteractive} />

          <Textarea
            value={messageText}
            onChange={handleMessageChange}
            onKeyDown={handleKeyDown}
            placeholder={mediaPreview ? "Add a caption..." : "Type a message... (/ for quick replies)"}
            className="max-h-24 min-h-[36px] resize-none"
            rows={1}
          />
          <Button
            size="icon"
            aria-label="Send message"
            className="h-9 w-9 shrink-0"
            onClick={handleSend}
            disabled={(!messageText.trim() && !mediaPreview) || isSending}
          >
            {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
