import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Send, X } from "lucide-react";
import { toast } from "sonner";
import { RichTextEditor } from "./RichTextEditor";
import { AIWriteAssistant } from "./AIWriteAssistant";
import { EmailAttachments, type EmailAttachment } from "./EmailAttachments";

interface ReplyFormProps {
  messageId: string;
  toEmail: string;
  originalSubject?: string | null;
  originalBody?: string | null;
  onCancel: () => void;
  onSent: () => void;
}

const FROM_ADDRESSES = [
  { value: "admin@postora.cloud", label: "admin@postora.cloud" },
  { value: "support@postora.cloud", label: "support@postora.cloud" },
] as const;

export function ReplyForm({
  messageId,
  toEmail,
  originalSubject,
  originalBody,
  onCancel,
  onSent,
}: ReplyFormProps) {
  const queryClient = useQueryClient();
  const [fromAddress, setFromAddress] = useState<string>("admin@postora.cloud");
  const [subject, setSubject] = useState(
    originalSubject ? `Re: ${originalSubject}` : "Re: (no subject)"
  );
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);

  const sendReplyMutation = useMutation({
    mutationFn: async () => {
      if (!body.trim()) {
        throw new Error("Message body is required");
      }

      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        throw new Error("Not authenticated");
      }

      const quotedOriginal = originalBody
        ? `
          <div style="margin-top: 20px; padding-left: 10px; border-left: 2px solid #ccc; color: #666;">
            <p style="margin: 0 0 10px 0; font-size: 12px;"><strong>On ${new Date().toLocaleDateString()}, ${toEmail} wrote:</strong></p>
            <div style="font-size: 13px;">${originalBody}</div>
          </div>
        `
        : "";

      const htmlBody = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6;">
          ${body}
          <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e5e5;" />
          <p style="color: #666; font-size: 12px;">Sent from Postora Admin</p>
          ${quotedOriginal}
        </div>
      `;

      const response = await supabase.functions.invoke("send-inbox-email", {
        body: {
          to: toEmail,
          from: fromAddress,
          subject: subject,
          html: htmlBody,
          text: body.replace(/<[^>]*>/g, ""),
          replyToMessageId: messageId,
          attachments: attachments.map((a) => ({
            filename: a.name,
            path: a.url,
          })),
        },
      });

      if (response.error) {
        throw new Error(response.error.message || "Failed to send email");
      }

      return response.data;
    },
    onSuccess: () => {
      toast.success("Reply sent successfully");
      queryClient.invalidateQueries({ queryKey: ["admin-inbox-messages"] });
      onSent();
    },
    onError: (error) => {
      toast.error(`Failed to send reply: ${error.message}`);
    },
  });

  const handleAIGenerate = (content: string) => {
    const htmlContent = content
      .split("\n")
      .map(line => line.trim() ? `<p>${line}</p>` : "<p><br></p>")
      .join("");
    setBody(htmlContent);
  };

  const getPlainTextBody = () => {
    return body.replace(/<[^>]*>/g, "").trim();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">Reply</h3>
        <Button variant="ghost" size="icon" onClick={onCancel}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      <div className="grid gap-4">
        <div className="flex items-center gap-4">
          <Label htmlFor="from" className="w-16 text-end text-muted-foreground text-sm">
            From
          </Label>
          <Select value={fromAddress} onValueChange={setFromAddress}>
            <SelectTrigger id="from" className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FROM_ADDRESSES.map((addr) => (
                <SelectItem key={addr.value} value={addr.value}>
                  {addr.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-4">
          <Label htmlFor="to" className="w-16 text-end text-muted-foreground text-sm">
            To
          </Label>
          <Input id="to" value={toEmail} disabled className="bg-muted flex-1" />
        </div>

        <div className="flex items-center gap-4">
          <Label htmlFor="subject" className="w-16 text-end text-muted-foreground text-sm">
            Subject
          </Label>
          <Input
            id="subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="flex-1"
          />
        </div>

        <div className="flex items-center gap-2">
          <div className="w-16" />
          <AIWriteAssistant
            onGenerate={handleAIGenerate}
            context={{ subject, recipient: toEmail }}
            mode="generate"
            buttonVariant="ghost"
            buttonSize="sm"
          />
          {getPlainTextBody() && (
            <AIWriteAssistant
              currentContent={getPlainTextBody()}
              onGenerate={handleAIGenerate}
              context={{ subject, recipient: toEmail }}
              mode="rewrite"
              buttonVariant="ghost"
              buttonSize="sm"
            />
          )}
        </div>

        <RichTextEditor
          value={body}
          onChange={setBody}
          placeholder="Type your reply..."
          minHeight="150px"
        />

        <EmailAttachments
          attachments={attachments}
          onAttachmentsChange={setAttachments}
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          onClick={() => sendReplyMutation.mutate()}
          disabled={!body.trim() || sendReplyMutation.isPending}
        >
          {sendReplyMutation.isPending ? (
            <Loader2 className="w-4 h-4 me-2 animate-spin" />
          ) : (
            <Send className="w-4 h-4 me-2" />
          )}
          Send Reply
        </Button>
      </div>
    </div>
  );
}
