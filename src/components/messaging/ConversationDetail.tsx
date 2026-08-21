import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Send, Paperclip, Loader2, MessageCircle, Image, FileIcon, Mic, Video, X } from "lucide-react";
import { MessageBubble } from "./MessageBubble";
import { useMessages, useSendMessage, useDeleteMessage } from "@/hooks/useMessaging";
import type { Conversation } from "@/hooks/useMessaging";
import { toast } from "sonner";
import { QuickReplyPicker, SlashCommandSuggestions } from "./QuickReplyPicker";
import { InteractiveMessageBuilder } from "./InteractiveMessageBuilder";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";
import { buildPostoraFileName } from "@/lib/postoraFileName";
import { AiConversationModeSelect } from "./AiConversationModeSelect";

interface ConversationDetailProps {
  conversation: Conversation | null;
  socialAccountId: string;
  pageId: string;
  platform?: "facebook" | "instagram" | "whatsapp";
}

async function callMessagingApi(action: string, body: Record<string, unknown>) {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    session = refreshed.session;
    if (!session?.access_token) throw new Error("Not authenticated");
  }
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const res = await fetch(
    `${supabaseUrl}/functions/v1/messaging-api`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, apikey: anonKey },
      body: JSON.stringify({ action, ...body }),
    }
  );
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (data.error_type) throw new Error(data.error);
  if (!res.ok) throw new Error(data.error || `API error ${res.status}`);
  return data;
}

export function ConversationDetail({ conversation, socialAccountId, pageId, platform }: ConversationDetailProps) {
  const [messageText, setMessageText] = useState("");
  const [showSlashSuggestions, setShowSlashSuggestions] = useState(false);
  const [mediaPreview, setMediaPreview] = useState<{ file: File; url: string; type: string } | null>(null);
  const [sendingMedia, setSendingMedia] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data: messages = [], isLoading } = useMessages(conversation?.id || null, socialAccountId, platform);
  const sendMutation = useSendMessage();
  const deleteMutation = useDeleteMessage();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (!conversation) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
          <MessageCircle className="w-8 h-8 text-primary" />
        </div>
        <h3 className="text-lg font-semibold mb-1">Select a conversation</h3>
        <p className="text-sm text-muted-foreground">Choose a conversation from the list to view messages</p>
      </div>
    );
  }

  const handleSend = () => {
    if (!messageText.trim() && !mediaPreview) return;

    if (mediaPreview) {
      handleSendMedia();
      return;
    }

    const recipientPhone = platform === "whatsapp" ? conversation.participant_id : undefined;

    sendMutation.mutate(
      {
        socialAccountId,
        conversationId: conversation.id,
        message: messageText.trim(),
        platform,
        recipientPhone,
        recipientId: conversation.participant_id,
      },
      {
        onSuccess: () => { setMessageText(""); toast.success("Message sent"); },
        onError: (err) => toast.error(err.message),
      }
    );
  };

  const handleSendMedia = async () => {
    if (!mediaPreview) return;
    setSendingMedia(true);
    try {
      // Upload to Supabase storage first
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const ext = mediaPreview.file.name.split(".").pop() || "bin";
      const path = `whatsapp-media/${await buildPostoraFileName(user.id, ext)}`;
      const { data: uploadData, error: uploadError } = await supabase.storage.from("media").upload(path, mediaPreview.file);
      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage.from("media").getPublicUrl(uploadData.path);
      const mediaUrl = urlData.publicUrl;

      // Determine media type for WhatsApp
      let mediaType = "document";
      if (mediaPreview.type.startsWith("image/")) mediaType = "image";
      else if (mediaPreview.type.startsWith("video/")) mediaType = "video";
      else if (mediaPreview.type.startsWith("audio/")) mediaType = "audio";

      if (platform === "whatsapp") {
        await callMessagingApi("whatsapp_send_media", {
          social_account_id: socialAccountId,
          recipient_phone: conversation.participant_id,
          media_url: mediaUrl,
          media_type: mediaType,
          caption: messageText.trim() || undefined,
        });
      } else {
        // Facebook/Instagram media
        await callMessagingApi("send_media", {
          social_account_id: socialAccountId,
          recipient_id: conversation.participant_id,
          media_url: mediaUrl,
          media_type: mediaType,
        });
      }

      toast.success("Media sent");
      setMediaPreview(null);
      setMessageText("");
    } catch (err: any) {
      toast.error(err.message || "Failed to send media");
    } finally {
      setSendingMedia(false);
    }
  };

  const handleDelete = (messageId: string) => {
    deleteMutation.mutate(
      { socialAccountId, messageId },
      {
        onSuccess: () => toast.success("Message deleted"),
        onError: (err) => toast.error(err.message),
      }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleMessageChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setMessageText(val);
    const trimmed = val.trim();
    setShowSlashSuggestions(trimmed.startsWith("/") && !trimmed.includes(" "));
  };

  const handleQuickReplySelect = (msg: string, quickReplyId?: string) => {
    setMessageText(msg);
    setShowSlashSuggestions(false);

    // Log quick reply usage for analytics (fire-and-forget)
    if (quickReplyId && conversation) {
      supabase.auth.getUser().then(({ data }) => {
        if (data.user?.id) {
          supabase.from("whatsapp_quick_reply_usage").insert({
            user_id: data.user.id,
            quick_reply_id: quickReplyId,
            conversation_id: conversation.id,
          });
        }
      });
    }
  };

  const handleFileSelect = (accept: string) => {
    if (fileInputRef.current) {
      fileInputRef.current.accept = accept;
      fileInputRef.current.click();
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 16MB limit for WhatsApp
    if (file.size > 16 * 1024 * 1024) {
      toast.error("File size must be under 16MB");
      return;
    }

    const url = URL.createObjectURL(file);
    setMediaPreview({ file, url, type: file.type });
    e.target.value = "";
  };

  const handleSendInteractive = async (payload: any) => {
    if (platform !== "whatsapp") {
      toast.error("Interactive messages are only supported on WhatsApp");
      return;
    }
    try {
      await callMessagingApi("whatsapp_send_interactive", {
        social_account_id: socialAccountId,
        recipient_phone: conversation.participant_id,
        interactive: payload,
      });
      toast.success("Interactive message sent");
    } catch (err: any) {
      toast.error(err.message || "Failed to send interactive message");
    }
  };

  const sortedMessages = [...messages].reverse();

  return (
    <div className="flex flex-col h-full">
      {/* Hidden file input */}
      <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileChange} />

      {/* Header */}
      <div className="p-4 border-b flex items-center gap-3">
        <Avatar className="w-8 h-8">
          <AvatarImage src={conversation.participant_avatar || undefined} alt={conversation.participant_name} />
          <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
            {conversation.participant_name?.charAt(0)?.toUpperCase() || "?"}
          </AvatarFallback>
        </Avatar>
        <div>
          <p className="text-sm font-semibold">{conversation.participant_name}</p>
          <p className="text-xs text-muted-foreground">
            {conversation.unread_count > 0 ? `${conversation.unread_count} unread` : "Active"}
          </p>
        </div>
        {platform && (
          <div className="ml-auto">
            {/* FB/IG use assignment_key: the webhook (which resolves the AI mode)
                never sees Meta's own conversation id. */}
            <AiConversationModeSelect
              platform={platform}
              conversationId={conversation.assignment_key || conversation.id}
            />
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : sortedMessages.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-8">No messages in this conversation</p>
        ) : (
          sortedMessages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isSent={msg.from?.id === pageId}
              onDelete={handleDelete}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Media Preview */}
      {mediaPreview && (
        <div className="px-3 pt-2 border-t">
          <div className="relative inline-block">
            {mediaPreview.type.startsWith("image/") ? (
              <img src={mediaPreview.url} alt="preview" className="h-20 rounded-lg object-cover" />
            ) : mediaPreview.type.startsWith("video/") ? (
              <video src={mediaPreview.url} className="h-20 rounded-lg" />
            ) : (
              <div className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2">
                <FileIcon className="h-4 w-4" />
                <span className="text-xs truncate max-w-[200px]">{mediaPreview.file.name}</span>
              </div>
            )}
            <Button
              variant="destructive"
              size="icon"
              className="absolute -top-2 -right-2 h-5 w-5 rounded-full"
              onClick={() => { URL.revokeObjectURL(mediaPreview.url); setMediaPreview(null); }}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}

      {/* Compose */}
      <div className="p-3 border-t relative">
        <SlashCommandSuggestions
          query={messageText.trim()}
          onSelect={handleQuickReplySelect}
          visible={showSlashSuggestions}
        />
        <div className="flex gap-2 items-end">
          {/* Attachment menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0 h-9 w-9">
                <Paperclip className="w-4 h-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => handleFileSelect("image/*")} className="gap-2">
                <Image className="h-4 w-4" /> Image
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleFileSelect("video/*")} className="gap-2">
                <Video className="h-4 w-4" /> Video
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleFileSelect("audio/*")} className="gap-2">
                <Mic className="h-4 w-4" /> Audio
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleFileSelect("*/*")} className="gap-2">
                <FileIcon className="h-4 w-4" /> Document
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {platform === "whatsapp" && (
            <>
              <QuickReplyPicker onSelect={handleQuickReplySelect} />
              <InteractiveMessageBuilder onSend={handleSendInteractive} />
            </>
          )}
          <Textarea
            value={messageText}
            onChange={handleMessageChange}
            onKeyDown={handleKeyDown}
            placeholder={mediaPreview ? "Add a caption..." : "Type a message... (/ for quick replies)"}
            className="min-h-[36px] max-h-24 resize-none"
            rows={1}
          />
          <Button
            size="icon"
            className="shrink-0 h-9 w-9"
            onClick={handleSend}
            disabled={(!messageText.trim() && !mediaPreview) || sendMutation.isPending || sendingMedia}
          >
            {sendMutation.isPending || sendingMedia ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
