import { useEffect, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { normalizePhone } from "@/components/messaging/contacts/contactCodecs";
import { contactLabel, useUpdateSocialContact, type SocialContact } from "@/features/audience";

interface Draft { display_name: string; email: string; phone_number: string; company: string; notes: string; tags: string[]; }

function toDraft(c: SocialContact): Draft {
  return {
    display_name: c.display_name, email: c.email ?? "", phone_number: c.phone_number ?? "",
    company: c.company ?? "", notes: c.notes ?? "", tags: c.tags,
  };
}

export function ContactDetailsDrawer({ contact, onClose }: { contact: SocialContact | null; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tagInput, setTagInput] = useState("");
  const update = useUpdateSocialContact();

  useEffect(() => { setDraft(contact ? toDraft(contact) : null); setTagInput(""); }, [contact]);
  if (!contact || !draft) return null;

  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft({ ...draft, [key]: e.target.value });

  const addTag = () => {
    const tag = tagInput.trim();
    if (tag && !draft.tags.includes(tag)) setDraft({ ...draft, tags: [...draft.tags, tag] });
    setTagInput("");
  };

  const save = () => {
    const phone = draft.phone_number.trim();
    update.mutate({
      id: contact.id,
      patch: {
        display_name: draft.display_name.trim(),
        email: draft.email.trim().toLowerCase() || null,
        phone_number: phone ? normalizePhone(phone) || null : null,
        company: draft.company.trim() || null,
        notes: draft.notes.trim() || null,
        tags: draft.tags,
      },
    }, { onSuccess: onClose });
  };

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader><SheetTitle>{contactLabel(contact)}</SheetTitle></SheetHeader>
        <div className="mt-4 space-y-4">
          <div className="text-sm text-muted-foreground">
            {contact.platform} · {contact.total_comments_count} comments · last comment: {contact.last_comment_text ?? "—"}
          </div>
          <div><Label htmlFor="display_name">Name</Label><Input id="display_name" value={draft.display_name} onChange={set("display_name")} /></div>
          <div><Label htmlFor="email">Email</Label><Input id="email" value={draft.email} onChange={set("email")} /></div>
          <div><Label htmlFor="phone">Phone</Label><Input id="phone" value={draft.phone_number} onChange={set("phone_number")} /></div>
          <div><Label htmlFor="company">Company</Label><Input id="company" value={draft.company} onChange={set("company")} /></div>
          <div><Label htmlFor="notes">Notes</Label><Textarea id="notes" value={draft.notes} onChange={set("notes")} /></div>
          <div>
            <Label htmlFor="tag">Tags</Label>
            <div className="mb-2 flex flex-wrap gap-1">
              {draft.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                  <button type="button" aria-label={`Remove tag ${tag}`} className="ml-1" onClick={() => setDraft({ ...draft, tags: draft.tags.filter((t) => t !== tag) })}>×</button>
                </Badge>
              ))}
            </div>
            <Input id="tag" placeholder="Add tag" value={tagInput} onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={update.isPending}>Save</Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
