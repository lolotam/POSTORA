import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AgentCardProps } from "./types";

export interface HumanHandoffCardProps extends AgentCardProps {
  phoneInput: string;
  phoneError: string | null;
  onPhoneInputChange: (next: string) => void;
  /** Validation stays in the container, which owns phoneError. */
  onAddPhone: () => void;
  onRemovePhone: (phone: string) => void;
}

export function HumanHandoffCard({
  form,
  update,
  phoneInput,
  phoneError,
  onPhoneInputChange,
  onAddPhone,
  onRemovePhone,
}: HumanHandoffCardProps) {
  const phones = form.admin_phone_numbers || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Human handoff</CardTitle>
        <CardDescription>Who takes over when the assistant cannot answer.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Real switches, unlike the locked guard rows next door: each of these
            gates both its prompt rule AND whether escalate_to_human is offered
            to the model at all. Turning both off removes the tool. */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="handoff-on-request" className="font-normal">
              Hand off when the customer asks for a person
            </Label>
            <Switch
              id="handoff-on-request"
              aria-label="Hand off when the customer asks for a person"
              checked={form.handoff_on_request ?? true}
              onCheckedChange={(checked) => update("handoff_on_request", checked)}
            />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <Label htmlFor="handoff-on-low-confidence" className="font-normal">
              Hand off when the assistant cannot answer
            </Label>
            <Switch
              id="handoff-on-low-confidence"
              aria-label="Hand off when the assistant cannot answer"
              checked={form.handoff_on_low_confidence ?? true}
              onCheckedChange={(checked) => update("handoff_on_low_confidence", checked)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Admin phone numbers</Label>
          <div className="flex flex-wrap gap-2 rounded-md border p-3">
            {phones.map((phone) => (
              <Badge key={phone} variant="secondary" className="gap-1 pr-1">
                {phone}
                <button
                  type="button"
                  aria-label={`Remove ${phone}`}
                  className="rounded-sm p-0.5 hover:bg-muted"
                  onClick={() => onRemovePhone(phone)}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {phones.length === 0 && (
              <span className="text-sm text-muted-foreground">No admin numbers added.</span>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={phoneInput}
              onChange={(event) => onPhoneInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onAddPhone();
                }
              }}
              placeholder="+96550000000"
            />
            <Button type="button" variant="outline" onClick={onAddPhone}>
              <Plus className="mr-1 h-4 w-4" /> Add
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            These numbers receive access to operational tools during customer conversations, and
            are notified when a conversation is handed off.
          </p>
          {phoneError && <p className="text-sm text-destructive">{phoneError}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
