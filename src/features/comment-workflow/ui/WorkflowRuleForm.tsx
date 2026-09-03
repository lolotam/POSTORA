import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AccountAvatar } from "@/components/AccountAvatar";
import { getPlatformName, PlatformIcon } from "@/components/PlatformIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { cn } from "@/lib/utils";
import {
  accountNoun,
  accountPlaceholder,
  connectedAccountsFor,
  connectedCountByPlatform,
  isAccountConnected,
  reconnectNeededCount,
} from "../domain/accountChoices";
import {
  COMMENT_WORKFLOW_PLATFORMS,
  type CommentWorkflowMatchType,
  type CommentWorkflowPlatform,
  supportsPrivateReply,
} from "../domain/rule";
import {
  DM_MAX_CHARS,
  dmCharacterBudget,
  EMPTY_RULE_FORM,
  MAX_PUBLIC_REPLIES,
  type RuleFormErrors,
  type RuleFormValues,
  validateRuleForm,
} from "../domain/ruleForm";
import {
  fetchAttachableMedia,
  fetchRecentPosts,
  type MediaOption,
  type PostOption,
} from "../infrastructure/commentWorkflowApi";
import { useCommentWorkflowRules } from "./hooks/useCommentWorkflowRules";

const NO_FILE = "none";

interface WorkflowRuleFormProps {
  ruleId: string | null;
  onDone: () => void;
}

export function WorkflowRuleForm({ ruleId, onDone }: WorkflowRuleFormProps) {
  const { rules, create, update } = useCommentWorkflowRules();
  const { data: accounts = [], isError: accountsFailed } = useSocialAccounts();
  const [values, setValues] = useState<RuleFormValues>(EMPTY_RULE_FORM);
  const [errors, setErrors] = useState<RuleFormErrors>({});
  const [keywordDraft, setKeywordDraft] = useState("");
  const [posts, setPosts] = useState<PostOption[]>([]);
  const [postsFailed, setPostsFailed] = useState(false);
  const [media, setMedia] = useState<MediaOption[]>([]);

  const connectedCounts = useMemo(() => connectedCountByPlatform(accounts), [accounts]);

  // The row being edited, or null in create mode.
  //
  // The effect below depends on this rather than on `rules`, and the difference is not cosmetic:
  // `useCommentWorkflowRules` defaults `data` to a fresh `[]` while the query is in flight, so an
  // effect keyed on the array re-ran on every render and reset the form under whatever the user
  // had just done. `find` returns the same object across renders once the query is cached, and
  // `null` is stable, so hydration now happens when the rule actually arrives.
  const rule = ruleId ? rules.find((candidate) => candidate.id === ruleId) ?? null : null;

  // Edit mode hydrates from the row. is_active comes along so saving a paused workflow does not
  // quietly restart it.
  useEffect(() => {
    if (!rule) {
      setValues(EMPTY_RULE_FORM);
      return;
    }
    setValues({
      socialAccountId: rule.social_account_id,
      platform: rule.platform,
      name: rule.name,
      scope: rule.target_post_id ? "post" : "all",
      targetPostId: rule.target_post_id ?? "",
      matchType: rule.match_type,
      keywords: rule.keywords ?? [],
      publicReplies: rule.public_replies.length > 0 ? rule.public_replies : [""],
      dmMessage: rule.dm_message ?? "",
      mediaFileId: rule.media_file_id,
      sendOncePerUser: rule.send_once_per_user,
      isActive: rule.is_active,
    });
  }, [rule]);

  const accountOptions = useMemo(
    () => connectedAccountsFor(accounts, values.platform, values.socialAccountId),
    [accounts, values.platform, values.socialAccountId],
  );
  const hiddenForReconnect = useMemo(
    () => reconnectNeededCount(accounts, values.platform, values.socialAccountId),
    [accounts, values.platform, values.socialAccountId],
  );

  const account = accountOptions.find((candidate) => candidate.id === values.socialAccountId);
  const canDm = supportsPrivateReply(values.platform);

  // The three primitives the post lookup needs, pulled out of `account` before the effect.
  // `account` is a fresh object on every render, so depending on it would refetch the post
  // list on each keystroke; depending on the values it actually reads refetches only when one
  // of them changes.
  const accountId = account?.id ?? null;
  const accountPlatform = (account?.platform ?? null) as CommentWorkflowPlatform | null;
  const accountPlatformUserId = account?.platform_user_id ?? "";
  const wantsPostList = values.scope === "post";

  useEffect(() => {
    if (!accountId || !accountPlatform || accountPlatform === "threads" || !wantsPostList) {
      setPosts([]);
      setPostsFailed(false);
      return;
    }
    let cancelled = false;
    setPostsFailed(false);
    fetchRecentPosts(accountPlatform, accountId, accountPlatformUserId)
      .then((rows) => {
        if (!cancelled) setPosts(rows);
      })
      .catch(() => {
        // An empty picker and a failed one look identical, and only one of them means "this
        // account has no posts". Say which, and leave the id field usable.
        if (cancelled) return;
        setPosts([]);
        setPostsFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, accountPlatform, accountPlatformUserId, wantsPostList]);

  useEffect(() => {
    if (!canDm) {
      setMedia([]);
      return;
    }
    let cancelled = false;
    fetchAttachableMedia()
      .then((rows) => {
        if (!cancelled) setMedia(rows);
      })
      .catch((error: Error) => {
        if (!cancelled) toast.error(`Your media library could not be loaded: ${error.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [canDm]);

  const set = <K extends keyof RuleFormValues>(key: K, value: RuleFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const addKeyword = () => {
    const keyword = keywordDraft.trim();
    if (keyword && !values.keywords.includes(keyword)) {
      set("keywords", [...values.keywords, keyword]);
    }
    setKeywordDraft("");
  };

  // The platform decides which accounts exist and whether a private message exists at all, so
  // both the account and the post picked under the previous platform have to go.
  const choosePlatform = (platform: CommentWorkflowPlatform) =>
    setValues((current) =>
      current.platform === platform
        ? current
        : { ...current, platform, socialAccountId: "", targetPostId: "" },
    );

  // The post list is per account, so a post picked for the previous account cannot stay
  // selected. The platform is already fixed by the tile above and is not re-derived here.
  const chooseAccount = (id: string) =>
    setValues((current) => ({ ...current, socialAccountId: id, targetPostId: "" }));

  const save = async () => {
    const result = validateRuleForm(values);
    if (result.status === "invalid") {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    try {
      if (ruleId) await update.mutateAsync({ id: ruleId, ...result.input });
      else await create.mutateAsync(result.input);
      onDone();
    } catch {
      // The mutation already reported it; staying on the form keeps the user's work.
    }
  };

  return (
    <form
      className="max-w-2xl space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Platform</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          {COMMENT_WORKFLOW_PLATFORMS.map((platform) => {
            const selected = values.platform === platform;
            const count = connectedCounts[platform];
            return (
              <button
                key={platform}
                type="button"
                aria-pressed={selected}
                // The tile for the platform a funnel is already on stays usable even at zero,
                // so editing a rule whose only account went stale is still possible.
                disabled={count === 0 && !selected}
                onClick={() => choosePlatform(platform)}
                className={cn(
                  "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                  selected ? "border-primary bg-primary/5" : "hover:bg-muted/50",
                  count === 0 && !selected && "cursor-not-allowed opacity-50",
                )}
              >
                <PlatformIcon platform={platform} size="lg" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">
                    {getPlatformName(platform)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {count === 0
                      ? "None connected"
                      : `${count} ${accountNoun(platform, count)} connected`}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {/* A failed account read also yields three empty tiles. Telling someone to connect an
            account they already have is worse than saying the read failed. */}
        {accountsFailed && (
          <p className="text-sm text-destructive">
            Your connected accounts could not be loaded. Reload the page and try again.
          </p>
        )}
        {errors.platform && <p className="text-sm text-destructive">{errors.platform}</p>}
      </fieldset>

      {values.platform && (
        <div className="space-y-2">
          <Label htmlFor="cw-account">
            {`${getPlatformName(values.platform)} ${accountNoun(values.platform, 1)}`}
          </Label>
          <Select value={values.socialAccountId} onValueChange={chooseAccount}>
            <SelectTrigger id="cw-account" aria-label="Account">
              <SelectValue placeholder={accountPlaceholder(values.platform)} />
            </SelectTrigger>
            <SelectContent>
              {accountOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  <span className="flex items-center gap-2">
                    <AccountAvatar
                      platform={option.platform}
                      avatarUrl={option.avatar_url}
                      name={option.platform_username}
                      size="sm"
                    />
                    <span className="truncate">{option.platform_username ?? option.platform}</span>
                    {!isAccountConnected(option) && (
                      <Badge variant="outline" className="text-xs">
                        needs reconnect
                      </Badge>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {accountOptions.length === 0 && !accountsFailed && (
            <p className="text-sm text-muted-foreground">
              Connect a {getPlatformName(values.platform)}{" "}
              {accountNoun(values.platform, 1)} on Profiles first.
            </p>
          )}
          {/* An account disappearing with no reason reads as data loss, and reconnecting it on
              Profiles is not guessable from a short list. */}
          {hiddenForReconnect > 0 && (
            <p className="text-sm text-muted-foreground">
              {hiddenForReconnect} more {accountNoun(values.platform, hiddenForReconnect)}{" "}
              {hiddenForReconnect === 1 ? "needs" : "need"} reconnecting on Profiles before a
              workflow can use {hiddenForReconnect === 1 ? "it" : "them"}.
            </p>
          )}
          {errors.socialAccountId && (
            <p className="text-sm text-destructive">{errors.socialAccountId}</p>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="cw-name">Name</Label>
        <Input id="cw-name" value={values.name} onChange={(event) => set("name", event.target.value)} />
        {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Which posts</legend>
        <RadioGroup
          value={values.scope}
          onValueChange={(next) => set("scope", next as RuleFormValues["scope"])}
          className="flex gap-6"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="all" id="cw-scope-all" />
            <Label htmlFor="cw-scope-all">All posts</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="post" id="cw-scope-post" />
            <Label htmlFor="cw-scope-post">One post</Label>
          </div>
        </RadioGroup>
        {values.scope === "post" &&
          (posts.length > 0 ? (
            <Select value={values.targetPostId} onValueChange={(next) => set("targetPostId", next)}>
              <SelectTrigger aria-label="Post">
                <SelectValue placeholder="Pick a recent post" />
              </SelectTrigger>
              <SelectContent>
                {posts.map((post) => (
                  <SelectItem key={post.id} value={post.id}>
                    {post.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <div className="space-y-1">
              <Input
                aria-label="Post id"
                placeholder="Post or media id"
                value={values.targetPostId}
                onChange={(event) => set("targetPostId", event.target.value)}
              />
              {postsFailed && (
                <p className="text-sm text-muted-foreground">
                  Your recent posts could not be loaded, so paste the post id instead.
                </p>
              )}
            </div>
          ))}
        {errors.targetPostId && <p className="text-sm text-destructive">{errors.targetPostId}</p>}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What triggers it</legend>
        <RadioGroup
          value={values.matchType}
          onValueChange={(next) => set("matchType", next as CommentWorkflowMatchType)}
          className="flex flex-wrap gap-6"
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value="exact" id="cw-match-exact" />
            <Label htmlFor="cw-match-exact">Exact keyword</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="contains" id="cw-match-contains" />
            <Label htmlFor="cw-match-contains">Contains keyword</Label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroupItem value="any" id="cw-match-any" />
            <Label htmlFor="cw-match-any">Any comment</Label>
          </div>
        </RadioGroup>
        {values.matchType !== "any" && (
          <div className="space-y-2">
            <Label htmlFor="cw-keywords">Keywords</Label>
            <Input
              id="cw-keywords"
              value={keywordDraft}
              placeholder="Type a keyword and press Enter"
              onChange={(event) => setKeywordDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addKeyword();
                }
              }}
              onBlur={addKeyword}
            />
            <div className="flex flex-wrap gap-2">
              {values.keywords.map((keyword, index) => (
                <Badge
                  key={`${keyword}-${index}`}
                  variant="secondary"
                  className="cursor-pointer"
                  onClick={() => set("keywords", values.keywords.filter((_, at) => at !== index))}
                >
                  {keyword} ×
                </Badge>
              ))}
            </div>
            {errors.keywords && <p className="text-sm text-destructive">{errors.keywords}</p>}
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Public replies</legend>
        <p className="text-sm text-muted-foreground">
          One is picked at random each time, so a busy post does not show the same line twenty
          times.
        </p>
        {values.publicReplies.map((reply, index) => (
          <div key={index} className="flex gap-2">
            <Input
              aria-label={`Public reply ${index + 1}`}
              value={reply}
              onChange={(event) =>
                set(
                  "publicReplies",
                  values.publicReplies.map((current, at) => (at === index ? event.target.value : current)),
                )
              }
            />
            {values.publicReplies.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => set("publicReplies", values.publicReplies.filter((_, at) => at !== index))}
              >
                Remove
              </Button>
            )}
          </div>
        ))}
        {values.publicReplies.length < MAX_PUBLIC_REPLIES && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => set("publicReplies", [...values.publicReplies, ""])}
          >
            Add variation
          </Button>
        )}
        {errors.publicReplies && <p className="text-sm text-destructive">{errors.publicReplies}</p>}
      </fieldset>

      {canDm ? (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Private message</legend>
          <Textarea
            id="cw-dm"
            aria-label="Private message"
            maxLength={dmCharacterBudget(!!values.mediaFileId)}
            value={values.dmMessage}
            onChange={(event) => set("dmMessage", event.target.value)}
            placeholder="Thanks for commenting! Here is what you asked for:"
          />
          <p className="text-xs text-muted-foreground">
            {values.dmMessage.length}/{dmCharacterBudget(!!values.mediaFileId)}
            {values.mediaFileId ? " (the download link needs the rest)" : ""}. The platform
            allows one private message per comment, within seven days of it. Attaching a file
            adds a download link that works for seven days, and anyone the message is forwarded
            to can use it.
          </p>
          <Select
            value={values.mediaFileId ?? NO_FILE}
            onValueChange={(next) => set("mediaFileId", next === NO_FILE ? null : next)}
          >
            <SelectTrigger aria-label="Attach file">
              <SelectValue placeholder="Attach a file from your media library" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_FILE}>No file</SelectItem>
              {media.map((file) => (
                <SelectItem key={file.id} value={file.id}>
                  {file.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {errors.dmMessage && <p className="text-sm text-destructive">{errors.dmMessage}</p>}
        </fieldset>
      ) : (
        values.platform === "threads" && (
          <p className="text-sm text-muted-foreground">
            Threads has no private messages — this workflow replies publicly only.
          </p>
        )
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Switch
            id="cw-once"
            checked={values.sendOncePerUser}
            onCheckedChange={(next) => set("sendOncePerUser", next)}
          />
          <Label htmlFor="cw-once">Answer each person once per post</Label>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending || update.isPending}>
            Save workflow
          </Button>
        </div>
      </div>
    </form>
  );
}
