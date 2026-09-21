import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { LayoutList, Plus, X, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface InteractiveMessageBuilderProps {
  onSend: (payload: any) => void;
  isPending?: boolean;
}

interface ReplyButton {
  id: string;
  title: string;
}

interface ListSection {
  title: string;
  rows: { id: string; title: string; description: string }[];
}

export function InteractiveMessageBuilder({ onSend, isPending }: InteractiveMessageBuilderProps) {
  const { t } = useTranslation("inbox");
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"buttons" | "list">("buttons");
  const [bodyText, setBodyText] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [footerText, setFooterText] = useState("");

  // Button mode
  const [buttons, setButtons] = useState<ReplyButton[]>([]);

  // List mode
  const [buttonText, setButtonText] = useState("Select");
  const [sections, setSections] = useState<ListSection[]>([{ title: "", rows: [{ id: "1", title: "", description: "" }] }]);

  const reset = () => {
    setBodyText(""); setHeaderText(""); setFooterText("");
    setButtons([]); setButtonText("Select");
    setSections([{ title: "", rows: [{ id: "1", title: "", description: "" }] }]);
  };

  const addButton = () => {
    if (buttons.length >= 3) return;
    setButtons([...buttons, { id: `btn_${buttons.length + 1}`, title: "" }]);
  };

  const handleSend = () => {
    if (!bodyText.trim()) { toast.error(t("interactive.bodyRequired", "Body text is required")); return; }

    let payload: any;

    if (mode === "buttons") {
      if (buttons.length === 0) { toast.error(t("interactive.addAtLeastButton", "Add at least one button")); return; }
      payload = {
        type: "button",
        body: { text: bodyText },
        ...(headerText && { header: { type: "text", text: headerText } }),
        ...(footerText && { footer: { text: footerText } }),
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      };
    } else {
      const validSections = sections.filter(s => s.rows.some(r => r.title.trim()));
      if (validSections.length === 0) { toast.error(t("interactive.addAtLeastItem", "Add at least one list item")); return; }
      payload = {
        type: "list",
        body: { text: bodyText },
        ...(headerText && { header: { type: "text", text: headerText } }),
        ...(footerText && { footer: { text: footerText } }),
        action: {
          button: buttonText || "Select",
          sections: validSections.map(s => ({
            title: s.title,
            rows: s.rows.filter(r => r.title.trim()).map(r => ({
              id: r.id,
              title: r.title,
              description: r.description || undefined,
            })),
          })),
        },
      };
    }

    onSend(payload);
    setOpen(false);
    reset();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="shrink-0 h-9 w-9" title={t("interactive.tooltip", "Interactive message")}>
          <LayoutList className="w-4 h-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("interactive.title", "Interactive Message")}</DialogTitle></DialogHeader>

        <div className="flex gap-2 mb-4">
          <Button variant={mode === "buttons" ? "default" : "outline"} size="sm" onClick={() => setMode("buttons")}>{t("interactive.replyButtons", "Reply Buttons")}</Button>
          <Button variant={mode === "list" ? "default" : "outline"} size="sm" onClick={() => setMode("list")}>{t("interactive.listMenu", "List Menu")}</Button>
        </div>

        <div className="space-y-3">
          <div>
            <Label>{t("interactive.header", "Header (optional)")}</Label>
            <Input placeholder={t("interactive.headerPlaceholder", "Header text")} value={headerText} onChange={(e) => setHeaderText(e.target.value)} maxLength={60} />
          </div>
          <div>
            <Label>{t("interactive.body", "Body *")}</Label>
            <Textarea placeholder={t("interactive.bodyPlaceholder", "Message body text")} value={bodyText} onChange={(e) => setBodyText(e.target.value)} rows={3} maxLength={1024} />
          </div>
          <div>
            <Label>{t("interactive.footer", "Footer (optional)")}</Label>
            <Input placeholder={t("interactive.footerPlaceholder", "Footer text")} value={footerText} onChange={(e) => setFooterText(e.target.value)} maxLength={60} />
          </div>

          {mode === "buttons" && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>{t("interactive.buttonsMax", "Buttons (max 3)")}</Label>
                <span className="text-xs text-muted-foreground">{buttons.length}/3</span>
              </div>
              {buttons.map((btn, i) => (
                <div key={i} className="flex gap-2 mb-2">
                  <Input placeholder={t("interactive.buttonTitle", "Button title (max 20)")} maxLength={20} value={btn.title} onChange={(e) => {
                    const b = [...buttons]; b[i] = { ...b[i], title: e.target.value }; setButtons(b);
                  }} />
                  <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => setButtons(buttons.filter((_, j) => j !== i))}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              {buttons.length < 3 && (
                <Button variant="outline" size="sm" onClick={addButton} className="gap-1">
                  <Plus className="h-3 w-3" /> {t("interactive.addButton", "Add Button")}
                </Button>
              )}
            </div>
          )}

          {mode === "list" && (
            <div>
              <div className="mb-2">
                <Label>{t("interactive.menuButton", "Menu Button Text")}</Label>
                <Input placeholder={t("interactive.select", "Select")} value={buttonText} onChange={(e) => setButtonText(e.target.value)} maxLength={20} />
              </div>
              {sections.map((sec, si) => (
                <div key={si} className="border rounded-lg p-3 mb-2 space-y-2">
                  <div className="flex items-center justify-between">
                    <Input placeholder={t("interactive.sectionTitle", "Section title")} value={sec.title} onChange={(e) => {
                      const s = [...sections]; s[si] = { ...s[si], title: e.target.value }; setSections(s);
                    }} className="text-sm" />
                    {sections.length > 1 && (
                      <Button variant="ghost" size="icon" className="h-6 w-6 ms-2" onClick={() => setSections(sections.filter((_, j) => j !== si))}>
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                  {sec.rows.map((row, ri) => (
                    <div key={ri} className="ps-3 border-l-2 space-y-1">
                      <Input placeholder={t("interactive.itemTitle", "Item title (max 24)")} maxLength={24} value={row.title} onChange={(e) => {
                        const s = [...sections]; s[si].rows[ri] = { ...row, title: e.target.value }; setSections(s);
                      }} className="text-sm h-8" />
                      <Input placeholder={t("interactive.itemDesc", "Description (optional, max 72)")} maxLength={72} value={row.description} onChange={(e) => {
                        const s = [...sections]; s[si].rows[ri] = { ...row, description: e.target.value }; setSections(s);
                      }} className="text-xs h-7" />
                      {sec.rows.length > 1 && (
                        <Button variant="ghost" size="sm" className="h-5 text-xs" onClick={() => {
                          const s = [...sections]; s[si].rows = sec.rows.filter((_, j) => j !== ri); setSections(s);
                        }}>{t("common:remove", "Remove")}</Button>
                      )}
                    </div>
                  ))}
                  {sec.rows.length < 10 && (
                    <Button variant="ghost" size="sm" className="text-xs gap-1" onClick={() => {
                      const s = [...sections]; s[si].rows.push({ id: `r_${Date.now()}`, title: "", description: "" }); setSections(s);
                    }}>
                      <Plus className="h-3 w-3" /> {t("interactive.addItem", "Add Item")}
                    </Button>
                  )}
                </div>
              ))}
              {sections.length < 10 && (
                <Button variant="outline" size="sm" className="gap-1 text-xs" onClick={() => setSections([...sections, { title: "", rows: [{ id: `r_${Date.now()}`, title: "", description: "" }] }])}>
                  <Plus className="h-3 w-3" /> {t("interactive.addSection", "Add Section")}
                </Button>
              )}
            </div>
          )}

          <Button onClick={handleSend} disabled={isPending} className="w-full">
            {isPending ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : null}
            {t("interactive.send", "Send Interactive Message")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
