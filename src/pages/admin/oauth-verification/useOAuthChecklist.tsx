import { useState, useEffect } from "react";
import { toast } from "sonner";
import { CheckCircle2 } from "lucide-react";
import { ChecklistItem } from "./types";

interface PlatformState {
  completed: Set<string>;
  toggle: (id: string) => void;
}

interface UseOAuthChecklistReturn {
  google: PlatformState;
  tiktok: PlatformState;
  pinterest: PlatformState;
  linkedin: PlatformState;
  facebook: PlatformState;
  instagram: PlatformState;
  twitter: PlatformState;
  reddit: PlatformState;
  bluesky: PlatformState;
  resetAll: () => void;
  notifiedPlatforms: Set<string>;
}

const STORAGE_KEYS = {
  google: "oauth_verification_checklist",
  tiktok: "tiktok_verification_checklist",
  pinterest: "pinterest_verification_checklist",
  linkedin: "linkedin_verification_checklist",
  facebook: "facebook_verification_checklist",
  instagram: "instagram_verification_checklist",
  twitter: "twitter_verification_checklist",
  reddit: "reddit_verification_checklist",
  bluesky: "bluesky_verification_checklist",
  notified: "oauth_completion_notified",
};

function createToggle(
  completed: Set<string>,
  setCompleted: React.Dispatch<React.SetStateAction<Set<string>>>,
  storageKey: string
) {
  return (id: string) => {
    const newCompleted = new Set(completed);
    if (newCompleted.has(id)) {
      newCompleted.delete(id);
    } else {
      newCompleted.add(id);
    }
    setCompleted(newCompleted);
    localStorage.setItem(storageKey, JSON.stringify([...newCompleted]));
  };
}

export function useOAuthChecklist(): UseOAuthChecklistReturn {
  const [googleCompleted, setGoogleCompleted] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.google);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  const [tiktokCompleted, setTiktokCompleted] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.tiktok);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  const [pinterestCompleted, setPinterestCompleted] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.pinterest);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  const [linkedinCompleted, setLinkedinCompleted] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.linkedin);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  const [facebookCompleted, setFacebookCompleted] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.facebook);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  const [instagramCompleted, setInstagramCompleted] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.instagram);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  const [twitterCompleted, setTwitterCompleted] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.twitter);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  const [redditCompleted, setRedditCompleted] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.reddit);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  const [blueskyCompleted, setBlueskyCompleted] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.bluesky);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  const [notifiedPlatforms, setNotifiedPlatforms] = useState<Set<string>>(() => {
    const saved = localStorage.getItem(STORAGE_KEYS.notified);
    return saved ? new Set(JSON.parse(saved)) : new Set();
  });

  const resetAll = () => {
    setGoogleCompleted(new Set());
    setTiktokCompleted(new Set());
    setPinterestCompleted(new Set());
    setLinkedinCompleted(new Set());
    setFacebookCompleted(new Set());
    setInstagramCompleted(new Set());
    setTwitterCompleted(new Set());
    setRedditCompleted(new Set());
    setBlueskyCompleted(new Set());
    setNotifiedPlatforms(new Set());

    Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));

    toast.success("All checklists have been reset", {
      description: "You can start tracking your OAuth verification progress from scratch.",
    });
  };

  return {
    google: {
      completed: googleCompleted,
      toggle: createToggle(googleCompleted, setGoogleCompleted, STORAGE_KEYS.google),
    },
    tiktok: {
      completed: tiktokCompleted,
      toggle: createToggle(tiktokCompleted, setTiktokCompleted, STORAGE_KEYS.tiktok),
    },
    pinterest: {
      completed: pinterestCompleted,
      toggle: createToggle(pinterestCompleted, setPinterestCompleted, STORAGE_KEYS.pinterest),
    },
    linkedin: {
      completed: linkedinCompleted,
      toggle: createToggle(linkedinCompleted, setLinkedinCompleted, STORAGE_KEYS.linkedin),
    },
    facebook: {
      completed: facebookCompleted,
      toggle: createToggle(facebookCompleted, setFacebookCompleted, STORAGE_KEYS.facebook),
    },
    instagram: {
      completed: instagramCompleted,
      toggle: createToggle(instagramCompleted, setInstagramCompleted, STORAGE_KEYS.instagram),
    },
    twitter: {
      completed: twitterCompleted,
      toggle: createToggle(twitterCompleted, setTwitterCompleted, STORAGE_KEYS.twitter),
    },
    reddit: {
      completed: redditCompleted,
      toggle: createToggle(redditCompleted, setRedditCompleted, STORAGE_KEYS.reddit),
    },
    bluesky: {
      completed: blueskyCompleted,
      toggle: createToggle(blueskyCompleted, setBlueskyCompleted, STORAGE_KEYS.bluesky),
    },
    resetAll,
    notifiedPlatforms,
  };
}

export function useCompletionNotifications(
  platformStats: Array<{
    name: string;
    storageKey: string;
    items: ChecklistItem[];
    completed: Set<string>;
  }>,
  notifiedPlatforms: Set<string>,
  setNotifiedPlatforms: (platforms: Set<string>) => void
) {
  useEffect(() => {
    platformStats.forEach((platform) => {
      const required = platform.items.filter((item) => item.required);
      const completedRequired = required.filter((item) => platform.completed.has(item.id)).length;
      const isComplete = required.length > 0 && completedRequired === required.length;

      if (isComplete && !notifiedPlatforms.has(platform.storageKey)) {
        const newNotified = new Set(notifiedPlatforms);
        newNotified.add(platform.storageKey);
        setNotifiedPlatforms(newNotified);
        localStorage.setItem("oauth_completion_notified", JSON.stringify([...newNotified]));

        toast.success(`${platform.name} OAuth checklist complete!`, {
          description: `All ${required.length} required items have been completed. You're ready for OAuth verification.`,
          icon: <CheckCircle2 className="h-5 w-5 text-green-500" />,
          duration: 6000,
          action: {
            label: "Send Email",
            onClick: () => {
              const subject = encodeURIComponent(`${platform.name} OAuth Verification Checklist Complete`);
              const body = encodeURIComponent(
                `The ${platform.name} OAuth verification checklist has been completed.\n\n` +
                `All ${required.length} required items have been verified.\n\n` +
                `Platform: ${platform.name}\n` +
                `Completed: ${new Date().toLocaleString()}\n\n` +
                `Next steps:\n` +
                `- Submit for OAuth verification review\n` +
                `- Prepare test credentials if needed\n` +
                `- Monitor verification status`
              );
              window.open(`mailto:?subject=${subject}&body=${body}`);
            },
          },
        });
      }
    });
  }, [platformStats, notifiedPlatforms, setNotifiedPlatforms]);
}
