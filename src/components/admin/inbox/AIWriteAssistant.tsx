import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sparkles, Loader2, Wand2, FileText, Code2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface AIWriteAssistantProps {
  currentContent?: string;
  onGenerate: (content: string, isHtml?: boolean) => void;
  context?: {
    subject?: string;
    recipient?: string;
  };
  mode?: "generate" | "rewrite";
  buttonVariant?: "default" | "ghost" | "outline";
  buttonSize?: "default" | "sm" | "icon";
}

const EMAIL_STYLES = [
  { value: "professional", label: "Professional", emoji: "💼" },
  { value: "friendly", label: "Friendly", emoji: "😊" },
  { value: "funny", label: "Funny", emoji: "😄" },
  { value: "formal", label: "Formal", emoji: "🎩" },
  { value: "casual", label: "Casual", emoji: "👋" },
  { value: "persuasive", label: "Persuasive", emoji: "🎯" },
] as const;

const EMAIL_TEMPLATES = [
  { value: "minimal", label: "Minimal", description: "Clean, simple text" },
  { value: "modern", label: "Modern", description: "Styled with colors" },
  { value: "newsletter", label: "Newsletter", description: "Header + sections" },
  { value: "announcement", label: "Announcement", description: "Banner style" },
] as const;

type EmailStyle = typeof EMAIL_STYLES[number]["value"];
type EmailTemplate = typeof EMAIL_TEMPLATES[number]["value"];
type OutputFormat = "text" | "html";

export function AIWriteAssistant({
  currentContent,
  onGenerate,
  context,
  mode = "generate",
  buttonVariant = "outline",
  buttonSize = "default",
}: AIWriteAssistantProps) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState<EmailStyle>("professional");
  const [outputFormat, setOutputFormat] = useState<OutputFormat>("text");
  const [template, setTemplate] = useState<EmailTemplate>("modern");

  const aiMutation = useMutation({
    mutationFn: async () => {
      const response = await supabase.functions.invoke("ai-email-assistant", {
        body: {
          action: mode === "rewrite" ? "rewrite" : "generate",
          content: currentContent,
          prompt: prompt,
          style: style,
          context: context,
          outputFormat: outputFormat,
          template: outputFormat === "html" ? template : undefined,
        },
      });

      if (response.error) {
        throw new Error(response.error.message || "Failed to generate content");
      }

      if (response.data?.error) {
        throw new Error(response.data.error);
      }

      return response.data;
    },
    onSuccess: (data) => {
      if (data?.content) {
        onGenerate(data.content, data.isHtml);
        setOpen(false);
        setPrompt("");
        toast.success(mode === "rewrite" ? "Email rewritten!" : "Email generated!");
      }
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const handleGenerate = () => {
    if (mode === "generate" && !prompt.trim()) {
      toast.error("Please describe what you want to write");
      return;
    }
    if (mode === "rewrite" && !currentContent?.trim()) {
      toast.error("No content to rewrite");
      return;
    }
    aiMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {mode === "rewrite" ? (
          <Button variant={buttonVariant} size={buttonSize}>
            <Wand2 className="h-4 w-4 me-2" />
            AI Rewrite
          </Button>
        ) : (
          <Button variant={buttonVariant} size={buttonSize}>
            <Sparkles className="h-4 w-4 me-2" />
            Help me write
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[550px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            {mode === "rewrite" ? "AI Rewrite" : "AI Writing Assistant"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {mode === "generate" && (
            <div className="grid gap-2">
              <Label htmlFor="prompt">What do you want to write?</Label>
              <Textarea
                id="prompt"
                placeholder="e.g., Write a follow-up email about our meeting yesterday, thanking them for their time and proposing next steps..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="min-h-[80px]"
              />
            </div>
          )}

          {mode === "rewrite" && (
            <div className="p-3 bg-muted rounded-lg text-sm">
              <p className="text-muted-foreground mb-1 text-xs">Current content:</p>
              <p className="line-clamp-3">{currentContent || "No content"}</p>
            </div>
          )}

          {/* Output Format Selection */}
          <div className="grid gap-2">
            <Label>Output Format</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setOutputFormat("text")}
                className={cn(
                  "flex items-center gap-2 px-4 py-3 rounded-lg border text-sm transition-colors",
                  outputFormat === "text"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted hover:bg-muted"
                )}
              >
                <FileText className="h-4 w-4" />
                <div className="text-start">
                  <div className="font-medium">Plain Text</div>
                  <div className="text-xs text-muted-foreground">Simple formatted email</div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setOutputFormat("html")}
                className={cn(
                  "flex items-center gap-2 px-4 py-3 rounded-lg border text-sm transition-colors",
                  outputFormat === "html"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted hover:bg-muted"
                )}
              >
                <Code2 className="h-4 w-4" />
                <div className="text-start">
                  <div className="font-medium">HTML Template</div>
                  <div className="text-xs text-muted-foreground">Styled with design</div>
                </div>
              </button>
            </div>
          </div>

          {/* HTML Template Selection */}
          {outputFormat === "html" && (
            <div className="grid gap-2">
              <Label>Template Style</Label>
              <div className="grid grid-cols-2 gap-2">
                {EMAIL_TEMPLATES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setTemplate(t.value)}
                    className={cn(
                      "flex flex-col px-3 py-2 rounded-lg border text-sm transition-colors text-start",
                      template === t.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-muted hover:bg-muted"
                    )}
                  >
                    <span className="font-medium">{t.label}</span>
                    <span className="text-xs text-muted-foreground">{t.description}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Label>Email Tone</Label>
            <div className="grid grid-cols-3 gap-2">
              {EMAIL_STYLES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setStyle(s.value)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors",
                    style === s.value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-muted hover:bg-muted"
                  )}
                >
                  <span>{s.emoji}</span>
                  <span>{s.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleGenerate} disabled={aiMutation.isPending}>
            {aiMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 me-2 animate-spin" />
                {mode === "rewrite" ? "Rewriting..." : "Generating..."}
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4 me-2" />
                {mode === "rewrite" ? "Rewrite" : "Generate"} {outputFormat === "html" ? "HTML" : ""}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
