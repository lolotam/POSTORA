import { useState, useEffect, useRef, useImperativeHandle, forwardRef } from "react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { sanitizeEmailHtml, escapeHtmlText } from "@/lib/sanitizeHtml";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Send, Plus, Paperclip, PenLine, MousePointer, ArrowDown, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { RichTextEditor, type RichTextEditorRef } from "./RichTextEditor";
import { AIWriteAssistant } from "./AIWriteAssistant";
import { EmailAutocomplete } from "./EmailAutocomplete";
import { EmailAttachments, type EmailAttachment } from "./EmailAttachments";
import { EmailScheduler } from "./EmailScheduler";
import { EmailSignatureManager } from "./EmailSignatureManager";
import { EmailTemplateManager } from "./EmailTemplateManager";
import { EmailPreviewDialog } from "./EmailPreviewDialog";
import { SaveAsTemplateDialog } from "./SaveAsTemplateDialog";
import { SubscriberSelector } from "./SubscriberSelector";
import { format } from "date-fns";

const FROM_ADDRESSES = [
  { value: "admin@postora.cloud", label: "admin@postora.cloud" },
  { value: "support@postora.cloud", label: "support@postora.cloud" },
] as const;

interface EmailSignature {
  id: string;
  name: string;
  content: string;
  is_default: boolean;
}

export interface ReplyData {
  toEmail: string;
  subject: string;
  originalBody: string | null;
  replyToMessageId: string;
}

export interface ForwardData {
  subject: string;
  originalBody: string | null;
  originalFrom: string;
  originalTo: string;
  originalDate: string;
  attachments?: Array<{ name: string; url: string; publicId?: string }>;
}

export interface DraftData {
  id: string;
  fromEmail: string;
  toEmails: string[];
  ccEmails: string[];
  bccEmails: string[];
  subject: string | null;
  body: string | null;
  htmlBody: string | null;
  attachments: Array<{ id: string; name: string; url: string; publicId?: string; path?: string; type: string; size: number }> | null;
  replyToMessageId: string | null;
}

export interface ComposeEmailRef {
  openReply: (data: ReplyData) => void;
  openForward: (data: ForwardData) => void;
  openDraft: (data: DraftData) => void;
}

export const ComposeEmail = forwardRef<ComposeEmailRef, object>(function ComposeEmail(_, ref) {
  const queryClient = useQueryClient();
  const editorRef = useRef<RichTextEditorRef>(null);
  const [open, setOpen] = useState(false);
  const [isReplyMode, setIsReplyMode] = useState(false);
  const [isDraftMode, setIsDraftMode] = useState(false);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [fromAddress, setFromAddress] = useState<string>("admin@postora.cloud");
  const [toEmails, setToEmails] = useState<string[]>([]);
  const [ccEmails, setCcEmails] = useState<string[]>([]);
  const [bccEmails, setBccEmails] = useState<string[]>([]);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [originalBodyQuote, setOriginalBodyQuote] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<EmailAttachment[]>([]);
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const [selectedSignature, setSelectedSignature] = useState<EmailSignature | null>(null);
  const [signatureInserted, setSignatureInserted] = useState(false);
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<Date | null>(null);
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Expose openReply, openForward, and openDraft methods to parent via ref
  useImperativeHandle(ref, () => ({
    openReply: (data: ReplyData) => {
      setIsReplyMode(true);
      setIsDraftMode(false);
      setCurrentDraftId(null);
      setReplyToMessageId(data.replyToMessageId);
      setToEmails([data.toEmail]);
      setSubject(data.subject.startsWith("Re:") ? data.subject : `Re: ${data.subject || "(no subject)"}`);
      setOriginalBodyQuote(data.originalBody);
      setBody("");
      setOpen(true);
    },
    openForward: (data: ForwardData) => {
      setIsReplyMode(false);
      setIsDraftMode(false);
      setCurrentDraftId(null);
      setReplyToMessageId(null);
      setToEmails([]);
      setSubject(data.subject.startsWith("Fwd:") ? data.subject : `Fwd: ${data.subject || "(no subject)"}`);
      
      // Format forwarded message body
      const forwardedContent = `
        <br><br>
        <div style="border-left: 2px solid #ccc; padding-left: 10px; margin-left: 10px; color: #666;">
          <p style="margin: 0 0 10px 0; font-size: 12px;">
            <strong>---------- Forwarded message ----------</strong><br>
            From: ${escapeHtmlText(data.originalFrom)}<br>
            To: ${escapeHtmlText(data.originalTo)}<br>
            Date: ${escapeHtmlText(data.originalDate)}<br>
            Subject: ${escapeHtmlText(data.subject || "(no subject)")}
          </p>
          <div style="font-size: 13px;">${sanitizeEmailHtml(data.originalBody || "")}</div>
        </div>
      `;
      setBody(forwardedContent);
      setOriginalBodyQuote(null);
      
      // Pre-load attachments if any (with proper EmailAttachment structure)
      if (data.attachments && data.attachments.length > 0) {
        setAttachments(data.attachments.map((a, idx) => ({
          id: `forwarded-${idx}`,
          name: a.name,
          url: a.url,
          publicId: a.publicId || a.url,
          type: "application/octet-stream",
          size: 0,
        })));
      }
      
      setOpen(true);
    },
    openDraft: (data: DraftData) => {
      setIsReplyMode(false);
      setIsDraftMode(true);
      setCurrentDraftId(data.id);
      setReplyToMessageId(data.replyToMessageId);
      setFromAddress(data.fromEmail || "admin@postora.cloud");
      setToEmails(data.toEmails || []);
      setCcEmails(data.ccEmails || []);
      setBccEmails(data.bccEmails || []);
      setShowCcBcc((data.ccEmails?.length || 0) > 0 || (data.bccEmails?.length || 0) > 0);
      setSubject(data.subject || "");
      setBody(data.htmlBody || data.body || "");
      setOriginalBodyQuote(null);
      
      // Load attachments if any
      if (data.attachments && data.attachments.length > 0) {
        setAttachments(data.attachments.map(a => ({
          ...a,
          publicId: a.publicId || a.path || a.url,
        })));
      }
      
      setOpen(true);
    },
  }));

  // Fetch default signature
  const { data: defaultSignature } = useQuery({
    queryKey: ["email-signatures", "default"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_signatures")
        .select("*")
        .eq("is_default", true)
        .single();

      if (error && error.code !== "PGRST116") throw error;
      return data as EmailSignature | null;
    },
  });

  // Fetch all signatures for quick-switch
  const { data: allSignatures = [] } = useQuery({
    queryKey: ["email-signatures"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_signatures")
        .select("*")
        .order("is_default", { ascending: false })
        .order("name");

      if (error) throw error;
      return data as EmailSignature[];
    },
  });

  // Set default signature on load
  useEffect(() => {
    if (defaultSignature && !selectedSignature) {
      setSelectedSignature(defaultSignature);
    }
  }, [defaultSignature]);

  const sendEmailMutation = useMutation({
    mutationFn: async () => {
      if (toEmails.length === 0) throw new Error("Recipient email is required");
      if (!subject.trim()) throw new Error("Subject is required");
      if (!body.trim()) throw new Error("Message body is required");

      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        throw new Error("Not authenticated");
      }

      // Only add signature if not manually inserted
      let htmlBody = body;
      if (!signatureInserted) {
        const signatureHtml = selectedSignature
          ? `<div style="margin-top: 20px; padding-top: 10px; border-top: 1px solid #e5e5e5; color: #666; font-size: 14px;">${selectedSignature.content}</div>`
          : `<hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e5e5;" /><p style="color: #666; font-size: 12px;">Sent from Postora Admin</p>`;
        htmlBody = `${body}${signatureHtml}`;
      }

      // Add quoted original for replies
      if (isReplyMode && originalBodyQuote) {
        const quotedOriginal = `
          <div style="margin-top: 20px; padding-left: 10px; border-left: 2px solid #ccc; color: #666;">
            <p style="margin: 0 0 10px 0; font-size: 12px;"><strong>On ${new Date().toLocaleDateString()}, ${escapeHtmlText(toEmails[0])} wrote:</strong></p>
            <div style="font-size: 13px;">${sanitizeEmailHtml(originalBodyQuote)}</div>
          </div>
        `;
        htmlBody = `${htmlBody}${quotedOriginal}`;
      }

      // Wrap in styled container
      const finalHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6;">
          ${htmlBody}
        </div>
      `;

      const response = await supabase.functions.invoke("send-inbox-email", {
        body: {
          to: toEmails[0], // Primary recipient
          cc: ccEmails.length > 0 ? ccEmails : undefined,
          bcc: bccEmails.length > 0 ? bccEmails : undefined,
          from: fromAddress,
          subject: subject,
          html: finalHtml,
          text: body.replace(/<[^>]*>/g, ""),
          attachments: attachments.map((a) => ({
            filename: a.name,
            path: a.url,
          })),
          scheduledAt: scheduledAt?.toISOString(),
          replyToMessageId: isReplyMode ? replyToMessageId : undefined,
        },
      });

      if (response.error) {
        throw new Error(response.error.message || "Failed to send email");
      }

      return response.data;
    },
    onSuccess: () => {
      if (scheduledAt) {
        toast.success(`Email scheduled for ${format(scheduledAt, "MMM d, yyyy 'at' h:mm a")}`);
      } else {
        toast.success(isReplyMode ? "Reply sent successfully!" : "Email sent successfully!");
      }
      queryClient.invalidateQueries({ queryKey: ["admin-inbox-messages"] });
      queryClient.invalidateQueries({ queryKey: ["scheduled-emails"] });
      
      // If this was a draft, delete it after sending
      if (isDraftMode && currentDraftId) {
        supabase.from("email_drafts").delete().eq("id", currentDraftId);
        queryClient.invalidateQueries({ queryKey: ["email-drafts"] });
      }
      
      resetForm();
      setOpen(false);
    },
    onError: (error) => {
      toast.error(`Failed to send email: ${error.message}`);
    },
  });

  // Save as draft mutation
  const saveDraftMutation = useMutation({
    mutationFn: async (options?: { silent?: boolean }) => {
      const { data: session } = await supabase.auth.getSession();
      if (!session.session) {
        throw new Error("Not authenticated");
      }

      const draftData = {
        admin_id: session.session.user.id,
        from_email: fromAddress,
        to_emails: toEmails,
        cc_emails: ccEmails,
        bcc_emails: bccEmails,
        subject: subject || null,
        body: body.replace(/<[^>]*>/g, "") || null,
        html_body: body || null,
        attachments: attachments.length > 0 ? JSON.parse(JSON.stringify(attachments)) : null,
        reply_to_message_id: replyToMessageId || null,
        signature_id: selectedSignature?.id || null,
      };

      if (isDraftMode && currentDraftId) {
        // Update existing draft
        const { error } = await supabase
          .from("email_drafts")
          .update(draftData)
          .eq("id", currentDraftId);

        if (error) throw error;
        return { isNew: false, silent: options?.silent };
      } else {
        // Create new draft and get the ID
        const { data, error } = await supabase
          .from("email_drafts")
          .insert(draftData)
          .select("id")
          .single();

        if (error) throw error;
        
        // Set draft mode with the new ID for future auto-saves
        setIsDraftMode(true);
        setCurrentDraftId(data.id);
        
        return { isNew: true, silent: options?.silent };
      }
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["email-drafts"] });
      queryClient.invalidateQueries({ queryKey: ["email-drafts-count"] });
      
      if (data.silent) {
        // Silent auto-save - just update the timestamp
        setLastAutoSavedAt(new Date());
      } else {
        // Manual save - show toast and close
        toast.success(data.isNew ? "Draft saved" : "Draft updated");
        resetForm();
        setOpen(false);
      }
    },
    onError: (error, variables) => {
      if (!variables?.silent) {
        toast.error(`Failed to save draft: ${error.message}`);
      }
    },
  });

  // Auto-save effect - saves every 30 seconds when dialog is open and there's content
  useEffect(() => {
    if (!open) {
      // Clear timeout when dialog closes
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
        autoSaveTimeoutRef.current = null;
      }
      return;
    }

    // Check if there's content worth saving
    const hasContent = body.trim().length > 0 || subject.trim().length > 0 || toEmails.length > 0;
    
    if (!hasContent) return;

    // Set up auto-save interval
    autoSaveTimeoutRef.current = setTimeout(() => {
      // Only auto-save if not currently sending
      if (!sendEmailMutation.isPending) {
        saveDraftMutation.mutate({ silent: true });
      }
    }, 30000); // 30 seconds

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, [open, body, subject, toEmails, fromAddress, ccEmails, bccEmails, attachments]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
      }
    };
  }, []);

  const resetForm = () => {
    setIsReplyMode(false);
    setIsDraftMode(false);
    setCurrentDraftId(null);
    setReplyToMessageId(null);
    setToEmails([]);
    setCcEmails([]);
    setBccEmails([]);
    setSubject("");
    setBody("");
    setOriginalBodyQuote(null);
    setShowCcBcc(false);
    setAttachments([]);
    setScheduledAt(null);
    setSelectedSignature(defaultSignature || null);
    setSignatureInserted(false);
    setLastAutoSavedAt(null);
  };

  // Insert signature at cursor or end
  const handleInsertSignature = (signature?: EmailSignature, position: "cursor" | "end" = "cursor") => {
    const sig = signature || selectedSignature;
    if (!sig) return;
    
    const signatureHtml = `<div style="margin-top: 20px; padding-top: 10px; border-top: 1px solid #e5e5e5; color: #666; font-size: 14px;">${sig.content}</div>`;
    
    if (position === "cursor" && editorRef.current) {
      // Insert at cursor position
      editorRef.current.insertHtmlAtCursor(signatureHtml);
      toast.success(`Signature "${sig.name}" inserted at cursor`);
    } else {
      // Insert at end of body
      setBody(prev => prev + signatureHtml);
      toast.success(`Signature "${sig.name}" added at end`);
    }
    
    setSignatureInserted(true);
    setSelectedSignature(sig);
  };

  const handleAIGenerate = (content: string, isHtml?: boolean) => {
    if (isHtml) {
      // Content is already HTML formatted
      setBody(content);
    } else {
      // Convert plain text to HTML paragraphs
      const htmlContent = content
        .split("\n")
        .map(line => line.trim() ? `<p>${line}</p>` : "<p><br></p>")
        .join("");
      setBody(htmlContent);
    }
  };

  const getPlainTextBody = () => {
    return body.replace(/<[^>]*>/g, "").trim();
  };

  // Check if body has actual content (not just empty HTML tags)
  const hasBodyContent = () => {
    const plainText = getPlainTextBody();
    return plainText.length > 0;
  };

  // Validation for send button
  const hasRecipient = toEmails.length > 0;
  const hasSubject = subject.trim().length > 0;
  const hasBody = hasBodyContent();
  const isNotSending = !sendEmailMutation.isPending;

  const canSend = hasRecipient && hasSubject && hasBody && isNotSending;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen);
      if (!isOpen) resetForm();
    }}>
      {!isReplyMode && (
        <DialogTrigger asChild>
          <Button>
            <Plus className="w-4 h-4 me-2" />
            Compose Email
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isReplyMode ? "Reply" : "New Message"}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* From Address */}
          <div className="flex items-center gap-2 sm:gap-4">
            <Label htmlFor="from" className="w-16 shrink-0 text-end text-muted-foreground max-sm:w-12">
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

          {/* To Emails */}
          <div className="flex items-center gap-2 sm:gap-4">
            <Label htmlFor="to" className="w-16 shrink-0 text-end text-muted-foreground max-sm:w-12">
              To
            </Label>
            <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
              <EmailAutocomplete
                id="to"
                value={toEmails}
                onChange={setToEmails}
                placeholder="recipient@example.com"
                className="flex-1 max-sm:basis-full"
              />
              <SubscriberSelector
                selectedEmails={toEmails}
                onSelectEmails={setToEmails}
              />
              {!showCcBcc && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCcBcc(true)}
                  className="text-muted-foreground text-xs"
                >
                  Cc Bcc
                </Button>
              )}
            </div>
          </div>

          {/* CC/BCC */}
          {showCcBcc && (
            <>
              <div className="flex items-center gap-2 sm:gap-4">
                <Label htmlFor="cc" className="w-16 shrink-0 text-end text-muted-foreground max-sm:w-12">
                  Cc
                </Label>
                <EmailAutocomplete
                  id="cc"
                  value={ccEmails}
                  onChange={setCcEmails}
                  placeholder="cc@example.com"
                  className="flex-1"
                />
              </div>
              <div className="flex items-center gap-2 sm:gap-4">
                <Label htmlFor="bcc" className="w-16 shrink-0 text-end text-muted-foreground max-sm:w-12">
                  Bcc
                </Label>
                <EmailAutocomplete
                  id="bcc"
                  value={bccEmails}
                  onChange={setBccEmails}
                  placeholder="bcc@example.com"
                  className="flex-1"
                />
              </div>
            </>
          )}

          {/* Subject */}
          <div className="flex items-center gap-2 sm:gap-4">
            <Label htmlFor="subject" className="w-16 shrink-0 text-end text-muted-foreground max-sm:w-12">
              Subject
            </Label>
            <Input
              id="subject"
              placeholder="Email subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="flex-1"
            />
          </div>

          {/* AI Help, Templates, Preview & Signature */}
          <div className="flex items-center gap-4">
            <div className="w-16 max-sm:hidden" />
            <div className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
              <EmailTemplateManager
                onSelectTemplate={({ subject: s, body: b }) => {
                  setSubject(s);
                  setBody(b);
                }}
                currentSubject={subject}
                currentBody={body}
              />
              <AIWriteAssistant
                onGenerate={handleAIGenerate}
                context={{ subject, recipient: toEmails[0] || "" }}
                mode="generate"
                buttonVariant="ghost"
                buttonSize="sm"
              />
              {getPlainTextBody() && (
                <AIWriteAssistant
                  currentContent={getPlainTextBody()}
                  onGenerate={handleAIGenerate}
                  context={{ subject, recipient: toEmails[0] || "" }}
                  mode="rewrite"
                  buttonVariant="ghost"
                  buttonSize="sm"
                />
              )}
              <SaveAsTemplateDialog
                subject={subject}
                body={body}
              />
              <EmailPreviewDialog
                subject={subject}
                htmlContent={body}
                fromAddress={fromAddress}
              />
              <div className="ms-auto">
                <EmailSignatureManager
                  selectedSignatureId={selectedSignature?.id}
                  onSelectSignature={setSelectedSignature}
                />
              </div>
            </div>
          </div>

          {/* Rich Text Body */}
          <RichTextEditor
            ref={editorRef}
            value={body}
            onChange={setBody}
            placeholder="Compose your email..."
            minHeight="200px"
          />

          {/* Signature Section */}
          <div className="border-t pt-3 mt-2 space-y-3">
            {/* Quick-switch signature buttons */}
            {allSignatures.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">Insert Signature:</p>
                <div className="flex flex-wrap gap-2">
                  {allSignatures.map((sig) => (
                    <div key={sig.id} className="flex items-center gap-1">
                      {/* Insert at cursor button */}
                      <Button
                        type="button"
                        variant={selectedSignature?.id === sig.id ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => handleInsertSignature(sig, "cursor")}
                        className="text-xs h-7"
                        title="Insert at cursor position"
                      >
                        <MousePointer className="h-3 w-3 me-1" />
                        {sig.name}
                        {sig.is_default && " ★"}
                      </Button>
                      {/* Insert at end button */}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleInsertSignature(sig, "end")}
                        className="text-xs h-7 px-2"
                        title="Insert at end of email"
                      >
                        <ArrowDown className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  <MousePointer className="h-3 w-3 inline me-1" />= at cursor, 
                  <ArrowDown className="h-3 w-3 inline mx-1" />= at end
                </p>
              </div>
            )}

            {/* Current signature preview (when not inserted) */}
            {selectedSignature && !signatureInserted && (
              <div>
                <p className="text-xs text-muted-foreground mb-2">
                  Will auto-append "{selectedSignature.name}":
                </p>
                <div 
                  className="text-sm text-muted-foreground bg-muted/30 p-3 rounded-md"
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(selectedSignature.content) }}
                />
              </div>
            )}

            {/* Inserted confirmation */}
            {signatureInserted && (
              <p className="text-xs text-green-600 dark:text-green-400">
                ✓ Signature inserted at cursor position
              </p>
            )}
          </div>

          {/* Attachments */}
          <EmailAttachments
            attachments={attachments}
            onAttachmentsChange={setAttachments}
          />
        </div>

        {/* Footer Actions */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-4 border-t">
          <div className="flex flex-wrap items-center gap-2">
            {/* Main send/schedule button */}
            <Button
              disabled={!canSend}
              onClick={() => sendEmailMutation.mutate()}
            >
              {sendEmailMutation.isPending ? (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              ) : (
                <Send className="w-4 h-4 me-2" />
              )}
              {scheduledAt ? "Schedule Email" : "Send Now"}
            </Button>
            
            {/* Send now option when scheduled */}
            {scheduledAt && (
              <Button
                variant="outline"
                size="sm"
                disabled={!canSend}
                onClick={() => {
                  setScheduledAt(null);
                  sendEmailMutation.mutate();
                }}
              >
                Send Now Instead
              </Button>
            )}
            
            <EmailScheduler
              scheduledAt={scheduledAt}
              onScheduleChange={setScheduledAt}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            {/* Auto-save indicator */}
            <div className="text-xs text-muted-foreground">
              {saveDraftMutation.isPending && saveDraftMutation.variables?.silent ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Saving...
                </span>
              ) : lastAutoSavedAt ? (
                <span className="flex items-center gap-1.5">
                  <CheckCircle className="w-3 h-3 text-green-500" />
                  Auto-saved at {format(lastAutoSavedAt, "h:mm a")}
                </span>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              {/* Save as Draft button */}
              <Button 
                variant="outline" 
                onClick={() => saveDraftMutation.mutate({ silent: false })}
                disabled={saveDraftMutation.isPending}
              >
                {saveDraftMutation.isPending && !saveDraftMutation.variables?.silent ? (
                  <Loader2 className="w-4 h-4 me-2 animate-spin" />
                ) : (
                  <PenLine className="w-4 h-4 me-2" />
                )}
                {isDraftMode ? "Update Draft" : "Save Draft"}
              </Button>
              
              <Button variant="ghost" onClick={() => { resetForm(); setOpen(false); }}>
                Discard
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});
