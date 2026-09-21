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
    <div className="relative group/code rounded-2xl overflow-hidden my-4 shadow-lg shadow-violet-500/10">
      {/* Gradient halo */}
      <div
        aria-hidden
        className="absolute -inset-px rounded-2xl bg-gradient-to-br from-violet-500/40 via-fuchsia-500/20 to-sky-500/30 opacity-30 group-hover/code:opacity-60 transition-opacity blur-sm"
      />
      <div className="relative rounded-2xl bg-slate-950/95 ring-1 ring-violet-500/20 overflow-hidden backdrop-blur">
        <div className="flex items-center justify-between px-4 py-2 border-b border-violet-500/15 bg-gradient-to-r from-violet-500/10 via-fuchsia-500/5 to-transparent">
          <div className="flex items-center gap-2">
            <Terminal className="w-3.5 h-3.5 text-violet-400" />
            <span className="text-xs font-mono font-medium bg-clip-text text-transparent bg-gradient-to-r from-violet-300 to-sky-300">
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
