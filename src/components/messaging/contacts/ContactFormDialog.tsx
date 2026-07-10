import { useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Camera, Loader2 } from "lucide-react";
import { deriveDisplayName, type ContactRecord } from "./contactCodecs";
import { useContactMutations, uploadContactAvatar } from "./useContacts";
import { PhoneInput } from "./PhoneInput";

interface ContactFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: ContactRecord | null;
}

const EMPTY = {
  first_name: "",
  last_name: "",
  phone_number: "",
  phone_secondary: "",
  email: "",
  company: "",
  job_title: "",
  street: "",
  city: "",
  country: "",
  birthday: "",
  website: "",
  notes: "",
  tags: "",
  avatar_url: "",
};

export function ContactFormDialog({ open, onOpenChange, contact }: ContactFormDialogProps) {
  const { session } = useAuth();
  const { toast } = useToast();
  const { createContact, updateContact } = useContactMutations();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState(EMPTY);

  useEffect(() => {
    if (!open) return;
    setForm(
      contact
        ? {
            first_name: contact.first_name || "",
            last_name: contact.last_name || "",
            phone_number: contact.phone_number || "",
            phone_secondary: contact.phone_secondary || "",
            email: contact.email || "",
            company: contact.company || "",
            job_title: contact.job_title || "",
            street: contact.street || "",
            city: contact.city || "",
            country: contact.country || "",
            birthday: contact.birthday || "",
            website: contact.website || "",
            notes: contact.notes || "",
            tags: (contact.tags || []).join(", "),
            avatar_url: contact.avatar_url || "",
          }
        : EMPTY,
    );
  }, [open, contact]);

  const set = (k: keyof typeof EMPTY) => (v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  const pickAvatar = async (file: File) => {
    if (!session?.user?.id) return;
    setUploading(true);
    try {
      const url = await uploadContactAvatar(file, session.user.id);
      set("avatar_url")(url);
    } catch (e) {
      toast({
        title: "Photo upload failed",
        description: (e as Error).message,
        variant: "destructive",
      });
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    const payload = {
      first_name: form.first_name || null,
      last_name: form.last_name || null,
      display_name: deriveDisplayName(
        form.first_name,
        form.last_name,
        `+${form.phone_number}`,
      ),
      phone_number: form.phone_number,
      phone_secondary: form.phone_secondary || null,
      email: form.email || null,
      company: form.company || null,
      job_title: form.job_title || null,
      street: form.street || null,
      city: form.city || null,
      country: form.country || null,
      birthday: form.birthday || null,
      website: form.website || null,
      notes: form.notes || null,
      tags: form.tags
        ? form.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : [],
      avatar_url: form.avatar_url || null,
    };
    try {
      if (contact) await updateContact.mutateAsync({ id: contact.id, ...payload });
      else await createContact.mutateAsync(payload);
      toast({ title: contact ? "Contact updated" : "Contact added" });
      onOpenChange(false);
    } catch (e) {
      const msg = (e as Error).message;
      toast({
        title: "Save failed",
        description: msg.includes("duplicate")
          ? "A contact with this number already exists."
          : msg,
        variant: "destructive",
      });
    }
  };

  const initials = (form.first_name[0] || "") + (form.last_name[0] || "");
  const pending = createContact.isPending || updateContact.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{contact ? "Edit Contact" : "New Contact"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex justify-center">
            <button
              type="button"
              className="relative"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              aria-label={uploading ? "Uploading photo" : "Upload contact photo"}
            >
              <Avatar className="h-20 w-20">
                <AvatarImage src={form.avatar_url || undefined} />
                <AvatarFallback className="text-xl">
                  {initials || <Camera className="h-6 w-6" />}
                </AvatarFallback>
              </Avatar>
              <span className="absolute bottom-0 right-0 rounded-full bg-primary p-1.5 text-primary-foreground">
                {uploading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Camera className="h-3 w-3" />
                )}
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && pickAvatar(e.target.files[0])}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>First name</Label>
              <Input
                value={form.first_name}
                onChange={(e) => set("first_name")(e.target.value)}
              />
            </div>
            <div>
              <Label>Last name</Label>
              <Input
                value={form.last_name}
                onChange={(e) => set("last_name")(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>WhatsApp number *</Label>
            <PhoneInput value={form.phone_number} onChange={set("phone_number")} />
          </div>
          <div>
            <Label>Second phone</Label>
            <PhoneInput
              value={form.phone_secondary}
              onChange={set("phone_secondary")}
            />
          </div>
          <div>
            <Label>Email</Label>
            <Input
              type="email"
              value={form.email}
              onChange={(e) => set("email")(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Company</Label>
              <Input
                value={form.company}
                onChange={(e) => set("company")(e.target.value)}
              />
            </div>
            <div>
              <Label>Job title</Label>
              <Input
                value={form.job_title}
                onChange={(e) => set("job_title")(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Street</Label>
            <Input
              value={form.street}
              onChange={(e) => set("street")(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>City</Label>
              <Input value={form.city} onChange={(e) => set("city")(e.target.value)} />
            </div>
            <div>
              <Label>Country</Label>
              <Input
                value={form.country}
                onChange={(e) => set("country")(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Birthday</Label>
              <Input
                type="date"
                value={form.birthday}
                onChange={(e) => set("birthday")(e.target.value)}
              />
            </div>
            <div>
              <Label>Website</Label>
              <Input
                value={form.website}
                onChange={(e) => set("website")(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label>Notes</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => set("notes")(e.target.value)}
            />
          </div>
          <div>
            <Label>Tags (comma-separated)</Label>
            <Input
              value={form.tags}
              onChange={(e) => set("tags")(e.target.value)}
              placeholder="vip, customer"
            />
          </div>

          <Button
            className="w-full"
            onClick={save}
            disabled={!form.phone_number || pending || uploading}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            {contact ? "Save changes" : "Add contact"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
