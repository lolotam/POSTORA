import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { ThemeToggle } from "@/components/ThemeToggle";
import { cn } from "@/lib/utils";

interface DocsHeaderProps {
  breadcrumbs?: { label: string; href?: string }[];
}

export function DocsHeader({ breadcrumbs }: DocsHeaderProps) {
  const { user } = useAuth();

  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background">
      <div className="container mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 group/header min-w-0">
          <Link to="/" className="inline-flex shrink-0 transition-transform duration-300 group-hover/header:-translate-y-0.5">
            <Logo />
          </Link>
          {breadcrumbs &&
            breadcrumbs.map((crumb, i) => (
              <span
                key={i}
                className={cn(
                  "flex items-center gap-3 min-w-0",
                  i < breadcrumbs.length - 1 && "max-sm:hidden",
                )}
              >
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
                  <span className="text-sm font-semibold text-foreground truncate">
                    {crumb.label}
                  </span>
                )}
              </span>
            ))}
        </div>
        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          <ThemeToggle />
          {user ? (
            <Link to="/dashboard">
              <Button variant="gradient" className="rounded-full max-sm:h-9 max-sm:px-3">Go to Dashboard</Button>
            </Link>
          ) : (
            <>
              <Link to="/auth" className="max-sm:hidden">
                <Button variant="ghost" className="rounded-full">Sign In</Button>
              </Link>
              <Link to="/auth?mode=signup">
                <Button variant="gradient" className="rounded-full max-sm:h-9 max-sm:px-3">Get Started</Button>
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
