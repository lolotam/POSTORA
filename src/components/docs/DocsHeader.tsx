import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { ThemeToggle } from "@/components/ThemeToggle";

interface DocsHeaderProps {
  breadcrumbs?: { label: string; href?: string }[];
}

export function DocsHeader({ breadcrumbs }: DocsHeaderProps) {
  const { user } = useAuth();

  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background">
      <div className="container mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3 group/header">
          <Link to="/" className="inline-flex transition-transform duration-300 group-hover/header:-translate-y-0.5">
            <Logo />
          </Link>
          {breadcrumbs &&
            breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-neutral-900 dark:bg-neutral-800"
                />
                {crumb.href ? (
                  <Link
                    to={crumb.href}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="text-sm font-semibold text-foreground">
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          {user ? (
            <Link to="/dashboard">
              <Button variant="gradient" className="rounded-full">Go to Dashboard</Button>
            </Link>
          ) : (
            <>
              <Link to="/auth">
                <Button variant="ghost" className="rounded-full">Sign In</Button>
              </Link>
              <Link to="/auth?mode=signup">
                <Button variant="gradient" className="rounded-full">Get Started</Button>
              </Link>
            </>
          )}
        </div>
      </div>
      {/* Bottom gradient hairline */}
      <div
        aria-hidden
        className="h-px w-full bg-border"
      />
    </header>
  );
}
