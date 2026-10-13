import { useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, LogOut } from "lucide-react";
import { browserTimeZone } from "@/features/scheduled";
import { useAuth } from "@/hooks/useAuth";
import { useSubscription } from "@/hooks/useSubscription";
import { useTikTokAccounts } from "../../application/useTikTokReview";
import { REVIEW_PATHS } from "../../domain/shellRoutes";
import "../approvals/approvals.css";

type WorkspaceTab = "general" | "plan";

const TABS: { key: WorkspaceTab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "plan", label: "Plan" },
];

export function WorkspaceView() {
  const [params, setParams] = useSearchParams();
  const tab: WorkspaceTab = params.get("tab") === "plan" ? "plan" : "general";

  return (
    <div className="mx-auto max-w-[1072px]">
      <header className="mb-2">
        <div className="rs-eyebrow">Settings</div>
        <h1 className="rs-title">Workspace</h1>
        <p className="rs-subtitle">Your account and plan.</p>
      </header>
      <nav className="rs-tabs" aria-label="Workspace sections">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            className="rs-tab border-x-0 border-t-0 bg-transparent"
            aria-current={tab === item.key ? "page" : undefined}
            onClick={() => setParams(item.key === "general" ? {} : { tab: item.key }, { replace: true })}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="mt-6">{tab === "general" ? <GeneralTab /> : <PlanTab />}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--rs-rule)] px-5 py-4 last:border-b-0">
      <span className="rs-label">{label}</span>
      <span className="text-[14px]">{value}</span>
    </div>
  );
}

function GeneralTab() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const accounts = useTikTokAccounts();
  const timeZone = useMemo(() => profile?.preferred_timezone || browserTimeZone(), [profile?.preferred_timezone]);

  return (
    <div className="space-y-6">
      <section className="rs-card">
        <Row label="Name" value={profile?.full_name || "—"} />
        <Row label="Email" value={profile?.email || "—"} />
        <Row label="Time zone" value={timeZone} />
        <Row label="TikTok accounts" value={accounts.isPending ? "…" : String(accounts.data?.length ?? 0)} />
      </section>
      <div className="flex flex-wrap gap-2">
        <Link to={REVIEW_PATHS.integrations} className="rs-btn rs-btn-outline">
          Manage integrations <ArrowRight />
        </Link>
        <button
          type="button"
          className="rs-btn rs-btn-ghost"
          onClick={() => {
            void signOut().then(() => navigate("/"));
          }}
        >
          <LogOut /> Log out
        </button>
      </div>
    </div>
  );
}

function PlanTab() {
  const { planName } = useSubscription();
  return (
    <section className="rs-card flex flex-wrap items-center justify-between gap-4 p-5">
      <div>
        <div className="rs-label">Current plan</div>
        <div className="mt-1 text-[24px] font-semibold tracking-tight">{planName}</div>
      </div>
      <Link to={REVIEW_PATHS.pricing} className="rs-btn rs-btn-ink">
        See plans <ArrowRight />
      </Link>
    </section>
  );
}
