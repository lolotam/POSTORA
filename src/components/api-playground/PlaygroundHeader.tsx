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
      <div className="container mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/"><Logo /></Link>
          <span className="text-muted-foreground">/</span>
          <Link to="/docs" className="text-muted-foreground hover:text-foreground">Docs</Link>
          <span className="text-muted-foreground">/</span>
          <span className="font-medium flex items-center gap-2">
            <Terminal className="w-4 h-4" />
            API Playground
          </span>
        </div>
        <div className="flex items-center gap-4">
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
