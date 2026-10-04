import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Terminal } from "lucide-react";

interface PlaygroundHeaderProps {
  isAuthenticated: boolean;
}

export function PlaygroundHeader({ isAuthenticated }: PlaygroundHeaderProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background">
      <div className="container mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <Link to="/" className="shrink-0"><Logo /></Link>
          <span className="text-muted-foreground max-sm:hidden">/</span>
          <Link to="/docs" className="text-muted-foreground hover:text-foreground max-sm:hidden">Docs</Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium flex items-center gap-2 min-w-0">
            <Terminal className="w-4 h-4 shrink-0" />
            <span className="truncate">API Playground</span>
          </span>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {isAuthenticated ? (
            <Link to="/dashboard"><Button variant="gradient">Dashboard</Button></Link>
          ) : (
            <Link to="/auth"><Button variant="gradient">Get Started</Button></Link>
          )}
        </div>
      </div>
    </header>
  );
}
