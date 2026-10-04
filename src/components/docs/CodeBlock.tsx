import { Button } from "@/components/ui/button";
import { Check, Copy, Terminal } from "lucide-react";
import { useCopyToClipboard } from "@/hooks/shared";

interface CodeBlockProps {
  code: string;
  language: string;
  id: string;
}

export function CodeBlock({ code, language, id }: CodeBlockProps) {
  const { copiedId, copy } = useCopyToClipboard();
  const isCopied = copiedId === id;

  return (
    <div className="relative group/code rounded-2xl overflow-hidden my-4 shadow-lg">
      {/* Gradient halo */}
      <div
        aria-hidden
        className="absolute -inset-px rounded-2xl opacity-30 group-hover/code:opacity-60 transition-opacity blur-sm bg-neutral-900 dark:bg-neutral-800"
      />
      <div className="relative rounded-2xl bg-slate-950/95 ring-1 ring-ring overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-accent">
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-foreground" />
            <span className="text-xs font-mono font-medium text-foreground">
              {language}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => copy(code, id)}
            className={`h-7 text-xs rounded-full px-3 transition-all ${
              isCopied
                ? "bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30"
                : "text-slate-300 hover:text-white hover:bg-white/10"
            }`}
          >
            {isCopied ? <Check className="w-3 h-3 me-1" /> : <Copy className="w-3 h-3 me-1" />}
            {isCopied ? "Copied!" : "Copy"}
          </Button>
        </div>
        <pre className="p-4 overflow-x-auto text-sm leading-relaxed">
          <code className="text-slate-100 font-mono">{code}</code>
        </pre>
      </div>
    </div>
  );
}
