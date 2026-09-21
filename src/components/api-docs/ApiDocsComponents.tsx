import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button onClick={handleCopy} className="absolute top-3 end-3 p-1.5 rounded-md bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

export function CodeBlock({ code, lang = "bash" }: { code: string; lang?: string }) {
  return (
    <div className="relative rounded-lg border border-border bg-[#0d1117] overflow-hidden my-3">
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-border/50 bg-[#161b22]">
        <span className="text-xs text-muted-foreground font-mono">{lang}</span>
      </div>
      <CopyButton text={code} />
      <pre className="p-4 overflow-x-auto text-sm"><code className="text-gray-200 whitespace-pre">{code}</code></pre>
    </div>
  );
}

export function MethodBadge({ method }: { method: string }) {
  const colors: Record<string, string> = {
    GET: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    POST: "bg-blue-500/10 text-blue-400 border-blue-500/30",
    DELETE: "bg-red-500/10 text-red-400 border-red-500/30",
    PUT: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  };
  return <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold border ${colors[method] || ""}`}>{method}</span>;
}
