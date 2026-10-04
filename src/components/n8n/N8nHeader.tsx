import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";

interface N8nHeaderProps {
  isAuthenticated: boolean;
}

export function N8nHeader({ isAuthenticated }: N8nHeaderProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background">
      <div className="container mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Link to="/" className="shrink-0"><Logo /></Link>
          <span className="text-muted-foreground/60 max-sm:hidden">/</span>
          <Link to="/docs" className="text-sm text-muted-foreground hover:text-foreground transition-colors max-sm:hidden">Docs</Link>
          <span className="text-muted-foreground/60">/</span>
          <span className="text-sm font-medium text-foreground truncate">
            n8n Integration
          </span>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          {isAuthenticated ? (
            <Link to="/dashboard">
              <Button className="text-primary-foreground bg-primary">
                Dashboard
              </Button>
            </Link>
          ) : (
            <Link to="/auth">
              <Button className="text-primary-foreground bg-primary">
                Get Started
              </Button>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
