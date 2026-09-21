import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { GradientDivider } from "@/components/fx";

export function N8nFooter() {
  return (
    <footer className="mt-8">
      <GradientDivider tone="violet" />
      <div className="bg-card/50 backdrop-blur-md">
        <div className="container mx-auto px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <Logo size="sm" />
          <div className="flex gap-6">
            <Link to="/docs" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Documentation</Link>
            <Link to="/privacy" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Privacy</Link>
            <Link to="/terms" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Terms</Link>
          </div>
          <p className="text-sm text-muted-foreground text-center md:text-end">© 2026 Postora. A product developed and operated by WALEED PROLIFE LLC. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
