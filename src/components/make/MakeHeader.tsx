import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ArrowLeft, BookOpen } from "lucide-react";

interface MakeHeaderProps {
  isAuthenticated: boolean;
}

export function MakeHeader({ isAuthenticated }: MakeHeaderProps) {
  return (
    <header className="border-b border-border bg-card sticky top-0 z-50">
      <div className="container mx-auto px-6 py-4 flex items-center gap-4">
        <Link to="/docs">
          <Button variant="ghost" size="icon"><ArrowLeft className="w-4 h-4" /></Button>
        </Link>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#6E00FF]/10 flex items-center justify-center">
            <BookOpen className="w-4 h-4 text-[#6E00FF]" />
          </div>
          <div>
            <h1 className="text-lg font-bold">Make.com Integration</h1>
            <p className="text-xs text-muted-foreground">Custom App — Postora API</p>
          </div>
        </div>
        <div className="ms-auto flex items-center gap-2">
          {isAuthenticated && (
            <Link to="/api-keys">
              <Button size="sm" variant="outline">Get API Key</Button>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
