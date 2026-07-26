import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { validateDeal, type DealValidationIssue } from "@/lib/whatsappPipeline";
import type { WhatsAppDeal, WhatsAppPipelineStage } from "@/hooks/useWhatsAppPipelines";

export interface WorkspaceContactOption {
  id: string;
  display_name: string | null;
  phone_number: string | null;
}

export interface DealFormValues {
  contactId: string;
  title: string;
  amount: number;
  currency: string;
  stageId: string;
  conversationCacheId: string | null;
}

export interface DealDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stages: WhatsAppPipelineStage[];
  contacts: WorkspaceContactOption[];
  deal?: WhatsAppDeal | null;
  defaultStageId?: string;
  defaultConversationCacheId?: string | null;
  isSubmitting?: boolean;
  onSubmit: (values: DealFormValues) => void;
}

function contactLabel(contact: WorkspaceContactOption) {
  return contact.display_name || contact.phone_number || "Unknown contact";
}

export function DealDialog({
  open,
  onOpenChange,
  stages,
  contacts,
  deal,
  defaultStageId,
  defaultConversationCacheId = null,
  isSubmitting = false,
  onSubmit,
}: DealDialogProps) {
  const [contactId, setContactId] = useState("");
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("0");
  const [currency, setCurrency] = useState("USD");
  const [stageId, setStageId] = useState("");
  const [issues, setIssues] = useState<DealValidationIssue[]>([]);

  useEffect(() => {
    if (!open) return;
    setContactId(deal?.contact_id ?? "");
    setTitle(deal?.title ?? "");
    setAmount(String(deal?.amount ?? 0));
    setCurrency(deal?.currency ?? "USD");
    setStageId(deal?.stage_id ?? defaultStageId ?? stages[0]?.id ?? "");
    setIssues([]);
  }, [defaultStageId, deal, open, stages]);

  const issueFor = (field: DealValidationIssue["field"]) =>
    issues.find((issue) => issue.field === field)?.message;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    // Reuse the data layer's rules rather than restating them here, so the form
    // and the mutation can never disagree about what a valid deal is.
    const validation = validateDeal({
      contactId,
      title,
      amount: Number(amount),
      currency,
    });
    if ("errors" in validation) {
      setIssues(validation.errors);
      return;
    }
    setIssues([]);
    onSubmit({
      ...validation.value,
      stageId,
      conversationCacheId: deal?.conversation_cache_id ?? defaultConversationCacheId,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{deal ? "Edit deal" : "New deal"}</DialogTitle>
          <DialogDescription>
            Deals are linked to a contact so they can open the right conversation.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="deal-title">Title</Label>
            <Input
              id="deal-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Renewal for Acme"
            />
            {issueFor("title") ? (
              <p className="text-xs text-destructive">{issueFor("title")}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="deal-contact">Contact</Label>
            <Select value={contactId} onValueChange={setContactId}>
              <SelectTrigger id="deal-contact">
                <SelectValue placeholder="Select a contact" />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((contact) => (
                  <SelectItem key={contact.id} value={contact.id}>
                    {contactLabel(contact)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {issueFor("contactId") ? (
              <p className="text-xs text-destructive">{issueFor("contactId")}</p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="deal-amount">Amount</Label>
              <Input
                id="deal-amount"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
              {issueFor("amount") ? (
                <p className="text-xs text-destructive">{issueFor("amount")}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="deal-currency">Currency</Label>
              <Input
                id="deal-currency"
                value={currency}
                maxLength={3}
                onChange={(event) => setCurrency(event.target.value)}
              />
              {issueFor("currency") ? (
                <p className="text-xs text-destructive">{issueFor("currency")}</p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="deal-stage">Stage</Label>
            <Select value={stageId} onValueChange={setStageId}>
              <SelectTrigger id="deal-stage">
                <SelectValue placeholder="Select a stage" />
              </SelectTrigger>
              <SelectContent>
                {stages.map((stage) => (
                  <SelectItem key={stage.id} value={stage.id}>
                    {stage.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {deal ? "Save deal" : "Create deal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
