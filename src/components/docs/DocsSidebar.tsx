import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { cn } from "@/lib/utils";
import { NavItem } from "./data/navItems";

interface DocsSidebarProps {
  navItems: NavItem[];
  activeSection: string;
  onSectionClick: (id: string) => void;
}

export function DocsSidebar({ navItems, activeSection, onSectionClick }: DocsSidebarProps) {
  return (
    <nav className="hidden lg:block sticky top-24 h-fit space-y-1.5 rounded-2xl border border-border/60 bg-card/50 backdrop-blur-md p-3 shadow-sm">
      {navItems.map((item) =>
        item.isLink ? (
          <div key={item.id}>
            <Link
              to={item.href!}
              className="group/nav flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all duration-300 text-muted-foreground hover:text-foreground hover:bg-violet-500/10 hover:translate-x-0.5"
            >
              <span className="inline-flex items-center justify-center h-6 w-6 rounded-lg bg-gradient-to-br from-violet-500/15 to-sky-500/15 ring-1 ring-violet-400/20 text-violet-500 group-hover/nav:from-violet-500/25 group-hover/nav:to-sky-500/25 transition-colors">
                <item.icon className="w-3.5 h-3.5" />
              </span>
              <span className="font-medium">{item.label}</span>
              <ChevronRight className="w-3 h-3 ms-auto opacity-50 group-hover/nav:opacity-100 group-hover/nav:translate-x-0.5 transition-all" />
            </Link>
            {item.subItems && (
              <div className="ms-7 mt-1 space-y-0.5 border-l border-gradient-violet ps-3 relative">
                <span
                  aria-hidden
                  className="absolute start-0 top-0 bottom-0 w-px bg-gradient-to-b from-violet-500/40 via-sky-500/30 to-transparent"
                />
                {item.subItems.map((sub) => (
                  <Link
                    key={sub.id}
                    to={sub.href}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-all duration-300 text-muted-foreground hover:text-foreground hover:bg-card/80 hover:translate-x-0.5"
                  >
                    {sub.platform && <PlatformIcon platform={sub.platform} size="xs" />}
                    {sub.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ) : (
          <a
            key={item.id}
            href={`#${item.id}`}
            onClick={() => onSectionClick(item.id)}
            className={cn(
              "group/nav flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm transition-all duration-300",
              activeSection === item.id
                ? "bg-gradient-to-r from-violet-500/20 via-fuchsia-500/10 to-transparent text-violet-600 dark:text-violet-300 ring-1 ring-violet-400/40 shadow-sm shadow-violet-500/20"
                : "text-muted-foreground hover:text-foreground hover:bg-card/80 hover:translate-x-0.5",
            )}
          >
            <span
              className={cn(
                "inline-flex items-center justify-center h-6 w-6 rounded-lg ring-1 transition-colors",
                activeSection === item.id
                  ? "bg-gradient-to-br from-violet-500 to-fuchsia-500 ring-white/30 text-white shadow-md shadow-violet-500/30"
                  : "bg-gradient-to-br from-violet-500/10 to-sky-500/10 ring-violet-400/20 text-violet-500",
              )}
            >
              <item.icon className="w-3.5 h-3.5" />
            </span>
            <span className="font-medium">{item.label}</span>
          </a>
        ),
      )}
    </nav>
  );
}
