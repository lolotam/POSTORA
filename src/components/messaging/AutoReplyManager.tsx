import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, Pencil, Trash2, Clock, MessageSquare, Loader2 } from "lucide-react";
import { useWhatsAppAutoReplies, type AutoReplyInput } from "@/hooks/useWhatsAppAutoReplies";
import { useMessengerAutoReplies, type MessengerPlatform } from "@/hooks/useMessengerAutoReplies";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function RuleForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<AutoReplyInput>;
  onSubmit: (data: AutoReplyInput) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || "");
  const [ruleType, setRuleType] = useState<"away" | "keyword">(initial?.rule_type || "keyword");
  const [keywords, setKeywords] = useState(initial?.keywords?.join(", ") || "");
  const [replyMessage, setReplyMessage] = useState(initial?.reply_message || "");
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [scheduleStart, setScheduleStart] = useState(initial?.schedule_start || "");
  const [scheduleEnd, setScheduleEnd] = useState(initial?.schedule_end || "");
  const [scheduleDays, setScheduleDays] = useState<number[]>(initial?.schedule_days || []);

  const handleSubmit = () => {
    if (!name.trim() || !replyMessage.trim()) return;
    onSubmit({
      name: name.trim(),
      rule_type: ruleType,
      keywords: ruleType === "keyword" ? keywords.split(",").map((k) => k.trim()).filter(Boolean) : null,
      reply_message: replyMessage.trim(),
      is_active: isActive,
      schedule_start: ruleType === "away" && scheduleStart ? scheduleStart : null,
      schedule_end: ruleType === "away" && scheduleEnd ? scheduleEnd : null,
      schedule_days: ruleType === "away" && scheduleDays.length > 0 ? scheduleDays : null,
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <Label>Name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. After Hours Reply" />
      </div>
      <div>
        <Label>Rule Type</Label>
        <Select value={ruleType} onValueChange={(v) => setRuleType(v as "away" | "keyword")}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="away">Away Message</SelectItem>
            <SelectItem value="keyword">Keyword Trigger</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {ruleType === "keyword" && (
        <div>
          <Label>Keywords (comma-separated)</Label>
          <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="hello, help, pricing" />
        </div>
      )}
      {ruleType === "away" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start Time</Label>
              <Input type="time" value={scheduleStart} onChange={(e) => setScheduleStart(e.target.value)} />
            </div>
            <div>
              <Label>End Time</Label>
              <Input type="time" value={scheduleEnd} onChange={(e) => setScheduleEnd(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>Active Days</Label>
            <div className="flex flex-wrap gap-2 mt-1">
              {DAYS.map((day, i) => (
                <label key={i} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={scheduleDays.includes(i)}
                    onCheckedChange={(checked) =>
                      setScheduleDays(checked ? [...scheduleDays, i] : scheduleDays.filter((d) => d !== i))
                    }
                  />
                  {day}
                </label>
              ))}
            </div>
          </div>
        </>
      )}
      <div>
        <Label>Reply Message</Label>
        <Textarea value={replyMessage} onChange={(e) => setReplyMessage(e.target.value)} placeholder="Thank you for reaching out..." rows={3} />
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={isActive} onCheckedChange={setIsActive} />
        <Label>Active</Label>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={!name.trim() || !replyMessage.trim()}>Save</Button>
      </div>
    </div>
  );
}

// Threads has no direct messages: rules there fire on public replies and mentions, and the
// reply is posted in public. Describing them as message automation would have users writing
// inbox copy for a comment thread.
const COPY = {
  message: {
    subtitle: "Set up automatic responses for incoming messages",
    emptyState: "No auto-reply rules yet. Create one to automatically respond to messages.",
  },
  comment: {
    subtitle: "Set up automatic public replies to comments and mentions",
    emptyState: "No auto-reply rules yet. Create one to reply publicly when a comment matches.",
  },
};

export function AutoReplyManager({ platform }: { platform?: MessengerPlatform } = {}) {
  const copy = platform === "threads" ? COPY.comment : COPY.message;
  const whatsapp = useWhatsAppAutoReplies(!platform);
  const messenger = useMessengerAutoReplies(platform ?? "facebook", !!platform);
  const { rules, isLoading, createRule, updateRule, deleteRule, toggleRule } = platform ? messenger : whatsapp;
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Auto-Reply Rules</h3>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </div>
        <Dialog open={showAdd} onOpenChange={setShowAdd}>
          <DialogTrigger asChild>
            <Button className="gap-1.5"><Plus className="w-4 h-4" /> Add Rule</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Create Auto-Reply Rule</DialogTitle></DialogHeader>
            <RuleForm
              onSubmit={(data) => { createRule.mutate(data); setShowAdd(false); }}
              onCancel={() => setShowAdd(false)}
            />
          </DialogContent>
        </Dialog>
      </div>

      {rules.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <MessageSquare className="h-12 w-12 mx-auto mb-4 opacity-50" />
            <p>{copy.emptyState}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <Card key={rule.id}>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-medium truncate">{rule.name}</h4>
                      <Badge variant={rule.rule_type === "away" ? "secondary" : "outline"} className="shrink-0">
                        {rule.rule_type === "away" ? <><Clock className="w-3 h-3 mr-1" /> Away</> : "Keyword"}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground line-clamp-2">{rule.reply_message}</p>
                    {rule.rule_type === "keyword" && rule.keywords && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {rule.keywords.map((k) => (
                          <Badge key={k} variant="outline" className="text-xs">{k}</Badge>
                        ))}
                      </div>
                    )}
                    {rule.rule_type === "away" && rule.schedule_start && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {rule.schedule_start} – {rule.schedule_end}
                        {rule.schedule_days && ` • ${rule.schedule_days.map((d) => DAYS[d]).join(", ")}`}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Switch
                      checked={rule.is_active}
                      onCheckedChange={(checked) => toggleRule.mutate({ id: rule.id, is_active: checked })}
                    />
                    <Dialog open={editingId === rule.id} onOpenChange={(open) => setEditingId(open ? rule.id : null)}>
                      <DialogTrigger asChild>
                        <Button variant="ghost" size="icon"><Pencil className="w-4 h-4" /></Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader><DialogTitle>Edit Rule</DialogTitle></DialogHeader>
                        <RuleForm
                          initial={rule}
                          onSubmit={(data) => { updateRule.mutate({ id: rule.id, ...data }); setEditingId(null); }}
                          onCancel={() => setEditingId(null)}
                        />
                      </DialogContent>
                    </Dialog>
                    <Button variant="ghost" size="icon" onClick={() => deleteRule.mutate(rule.id)}>
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
