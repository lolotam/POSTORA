import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, AtSign, Instagram, Linkedin, Plus, Search, Youtube, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTikTokAccounts } from "../../application/useTikTokReview";
import { useTikTokConnection } from "../../application/useTikTokConnection";
import { REVIEW_PATHS } from "../../domain/shellRoutes";
import type { TikTokAccount } from "../../domain/types";
import { useDescribeError } from "../reviewCopy";
import { TikTokGlyph } from "../shell/TikTokGlyph";
import "../approvals/approvals.css";
import "./integrations.css";


interface SoonChannel {
  name: string;
  description: string;
  icon: typeof Instagram;
  tile: string;
}

const SOON_CHANNELS: SoonChannel[] = [
  { name: "Instagram", description: "Share Reels and posts to your Instagram account.", icon: Instagram, tile: "#E63946" },
  { name: "LinkedIn", description: "Share posts to your personal LinkedIn profile.", icon: Linkedin, tile: "#0A66C2" },
  { name: "YouTube", description: "Upload Shorts and videos to your channel.", icon: Youtube, tile: "#C4302B" },
  { name: "Threads", description: "Post to your Threads profile.", icon: AtSign, tile: "#1A1814" },
];

export function IntegrationsView() {
  const accountsQuery = useTikTokAccounts();
  const describeError = useDescribeError();
  const { connect, disconnect } = useTikTokConnection();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [toDisconnect, setToDisconnect] = useState<TikTokAccount | null>(null);
  const accounts = accountsQuery.data ?? [];
  const justConnected = params.get("connected") === "tiktok";
  const newest = accounts[accounts.length - 1] ?? null;
  const query = search.trim().toLowerCase();
  const showTikTok = !query || "tiktok".includes(query) || "social channels".includes(query);
  const soon = SOON_CHANNELS.filter((channel) => !query || channel.name.toLowerCase().includes(query));
  const error = connect.error ?? disconnect.error ?? (accountsQuery.isError ? accountsQuery.error : null);

  return (
    <div className="mx-auto max-w-[1072px]">
      <header className="mb-8">
        <div className="rs-eyebrow">Settings</div>
        <h1 className="rs-title">Integrations</h1>
        <p className="rs-subtitle">Connect the channels you publish to. Postora posts on your behalf, only when you approve it.</p>
      </header>

      {error ? <p className="ap-alert mb-4" role="alert">{describeError(error)}</p> : null}

      <section className="mb-8">
        <h2 className="rs-section-title">
          Connected accounts <span className="rs-section-count">· {accounts.length}</span>
        </h2>
        <div className="rs-card mt-3">
          {accountsQuery.isPending ? (
            <div className="p-4"><div className="rs-skeleton h-4 w-1/3" /></div>
          ) : accounts.length === 0 ? (
            <p className="ap-empty !py-6">No accounts connected yet</p>
          ) : (
            accounts.map((account) => (
              <div key={account.id} className="in-account-row">
                <AccountAvatar account={account} size={20} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold">@{account.username}</span>
                  <span className="ap-meta block !mt-0">TikTok</span>
                </span>
                <span className="rs-pill" data-tone="connected">Connected</span>
                <button
                  type="button"
                  className="rs-btn rs-btn-ghost !h-7 !w-7 !p-0"
                  aria-label={`Disconnect ${account.username}`}
                  onClick={() => setToDisconnect(account)}
                >
                  <X />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <div className="in-search">
        <Search className="h-4 w-4 text-[color:var(--rs-ink-mute)]" aria-hidden="true" />
        <input
          type="search"
          placeholder="Search integrations…"
          aria-label="Search integrations"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <section className="mt-8">
        <h2 className="rs-section-title">
          Social channels <span className="rs-section-count">· {(showTikTok ? 1 : 0) + soon.length}</span>
        </h2>
        <div className="in-grid">
          {showTikTok ? (
            <article className="rs-card in-card">
              <div className="flex items-start justify-between">
                <span className="in-tile" style={{ background: "#1A1814" }}><TikTokGlyph className="h-6 w-6" /></span>
                {accounts.length > 0 ? (
                  <span className="rs-pill" data-tone="connected">● Connected · {accounts.length}</span>
                ) : (
                  <span className="rs-pill" data-tone="mute">Available</span>
                )}
              </div>
              <h3 className="in-card-title">TikTok</h3>
              <p className="in-card-text">Connect your TikTok account.</p>
              {accounts.length > 0 ? (
                <ul className="mb-3 space-y-1.5">
                  {accounts.map((account) => (
                    <li key={account.id} className="flex items-center gap-2 text-[13px]">
                      <AccountAvatar account={account} size={20} />
                      <span className="min-w-0 flex-1 truncate">@{account.username}</span>
                      <button
                        type="button"
                        className="rs-btn rs-btn-ghost !h-6 !w-6 !p-0"
                        aria-label={`Disconnect ${account.username}`}
                        onClick={() => setToDisconnect(account)}
                      >
                        <X />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="mt-auto">
                {accounts.length > 0 ? (
                  <button type="button" className="rs-btn rs-btn-outline" disabled={connect.isPending} onClick={() => connect.mutate()}>
                    <Plus /> Add another TikTok
                  </button>
                ) : (
                  <button type="button" className="rs-btn rs-btn-ink" disabled={connect.isPending} onClick={() => connect.mutate()}>
                    Connect TikTok <ArrowRight />
                  </button>
                )}
              </div>
            </article>
          ) : null}
          {soon.map((channel) => {
            const Icon = channel.icon;
            return (
              <article key={channel.name} className="rs-card in-card in-card-soon" aria-label={`${channel.name}, coming soon`}>
                <div className="flex items-start justify-between">
                  <span className="in-tile" style={{ background: channel.tile }}><Icon className="h-6 w-6" /></span>
                  <span className="in-soon">Soon</span>
                </div>
                <h3 className="in-card-title">{channel.name}</h3>
                <p className="in-card-text">{channel.description}</p>
                <div className="rs-label mt-auto">In the works</div>
              </article>
            );
          })}
        </div>
        {!showTikTok && soon.length === 0 ? <p className="ap-empty">No integrations match “{search}”.</p> : null}
      </section>

      <AlertDialog open={toDisconnect !== null} onOpenChange={(open) => { if (!open) setToDisconnect(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect @{toDisconnect?.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              Postora will stop publishing to this TikTok account. Posts already on TikTok stay there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (toDisconnect) disconnect.mutate(toDisconnect.id);
                setToDisconnect(null);
              }}
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={justConnected}
        onOpenChange={(open) => {
          if (open) return;
          const next = new URLSearchParams(params);
          next.delete("connected");
          setParams(next, { replace: true });
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <span className="in-tile mb-2" style={{ background: "#1A1814" }}><TikTokGlyph className="h-6 w-6" /></span>
            <DialogTitle>TikTok connected</DialogTitle>
            <DialogDescription>
              {newest ? `@${newest.username} is ready. ` : ""}
              Create a post in Approvals, choose its TikTok settings, then approve or schedule it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Link to={REVIEW_PATHS.approvals} className="rs-btn rs-btn-ink">
              Continue to Approvals <ArrowRight />
            </Link>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AccountAvatar({ account, size }: { account: TikTokAccount; size: number }) {
  return (
    <span className="rs-avatar shrink-0" style={{ width: size, height: size, fontSize: size / 2 }}>
      {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : account.username.charAt(0).toUpperCase()}
    </span>
  );
}
