import type { ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { Activity, CalendarDays, CircleCheckBig } from "lucide-react";
import { REVIEW_PATHS } from "../../domain/shellRoutes";
import { usePipelineCounts } from "./usePipelineCounts";

interface PipelineHeaderProps {
  title: string;
  subtitle?: ReactNode;
  /** Controls on the right of the title row (Calendar: Today / Previous / Next). */
  actions?: ReactNode;
}

/** Eyebrow, title and the Activity / Calendar / Approvals tabs shared by the pipeline pages. */
export function PipelineHeader({ title, subtitle, actions }: PipelineHeaderProps) {
  const { pathname } = useLocation();
  const counts = usePipelineCounts();
  const tabs = [
    { label: "Activity", path: REVIEW_PATHS.activity, icon: Activity, count: 0, countLabel: "" },
    {
      label: "Calendar",
      path: REVIEW_PATHS.calendar,
      icon: CalendarDays,
      count: counts.failed,
      countLabel: `${counts.failed} failed to publish`,
    },
    {
      label: "Approvals",
      path: REVIEW_PATHS.approvals,
      icon: CircleCheckBig,
      count: counts.pending,
      countLabel: `${counts.pending} waiting for approval`,
    },
  ];

  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="rs-eyebrow">Pipeline</div>
          <h1 className="rs-title">{title}</h1>
          {subtitle ? <p className="rs-subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      <nav className="rs-tabs" aria-label="Content views">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <Link
              key={tab.path}
              to={tab.path}
              className="rs-tab"
              aria-current={pathname === tab.path ? "page" : undefined}
            >
              <Icon aria-hidden="true" />
              {tab.label}
              {tab.count > 0 ? <span className="rs-count" aria-label={tab.countLabel}>{tab.count}</span> : null}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
