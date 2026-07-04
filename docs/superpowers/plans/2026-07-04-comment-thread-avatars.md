# Comment/Thread Avatar Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Facebook conversation avatar bug, add commenter avatars to the Facebook and Instagram comment managers, and verify (fixing only if broken) the Threads mentions avatar pipeline — per the approved spec at `docs/superpowers/specs/2026-07-04-comment-thread-avatars-design.md`.

**Architecture:** Three self-hosted Deno edge functions (`messaging-api`, `comment-manager`, `threads-mentions`) plus their frontend consumers. No new services. Facebook conversation avatars get a one-line-cause bug fix (wrong Graph API field names). Facebook comment avatars are a new, permission-free field addition. Instagram comment avatars reuse the `messaging_cache` table already populated by the DM-avatar feature as a best-effort join — no new Meta API calls. Threads mentions get a live verification pass with no code change unless the verification proves it's broken. Threads reply avatars get no code change at all (documented Meta API ceiling — no task exists for it, matching spec section E).

**Tech Stack:** Deno edge functions (Supabase self-hosted on Contabo), PostgreSQL, React + TypeScript + TanStack Query, shadcn/ui `Avatar`.

**Testing note:** `messaging-api` and `comment-manager` have no existing Deno test files (unlike `facebook-oauth`/`instagram-oauth`, which do). Per this repo's established verification pattern for this exact avatar feature (see the prior Instagram DM avatar session), these changes are verified with live smoke tests against the running production edge functions and direct Postgres checks, not new unit test files — introducing a new test-file pattern for functions that have never had one is out of scope for this fix. No test files are created or modified in this plan.

---

### Task 1: Add `participant_id` column to `messaging_cache`

**Files:**
- Create: `supabase/migrations/20260704000001_add_messaging_cache_participant_id.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Adds a participant_id column to messaging_cache so other features (Instagram
-- comment-manager avatars) can look up a person's already-cached DM avatar by
-- their Meta-scoped ID, without a new table. Additive and nullable: existing
-- rows are untouched, and messaging-api starts populating it going forward.
ALTER TABLE public.messaging_cache
  ADD COLUMN IF NOT EXISTS participant_id text;

CREATE INDEX IF NOT EXISTS idx_messaging_cache_user_participant
  ON public.messaging_cache (user_id, participant_id);
```

- [ ] **Step 2: Apply the migration to the production database**

This self-hosted stack has no confirmed automatic migration runner (per `docs/superpowers/specs/2026-07-04-comment-thread-avatars-design.md`, Deployment section) — apply directly via SSH/psql, the same way production data was inspected during this feature's investigation.

Run (replace nothing — this is the exact command):

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -c \"ALTER TABLE public.messaging_cache ADD COLUMN IF NOT EXISTS participant_id text; CREATE INDEX IF NOT EXISTS idx_messaging_cache_user_participant ON public.messaging_cache (user_id, participant_id);\""
```

Expected output: `ALTER TABLE` then `CREATE INDEX` (or `NOTICE: column ... already exists` on a re-run — harmless).

- [ ] **Step 3: Verify the column exists**

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -c '\d messaging_cache'"
```

Expected: `participant_id | text` appears in the column list, and `idx_messaging_cache_user_participant` appears in the Indexes list.

- [ ] **Step 4: Commit the migration file**

```bash
git add supabase/migrations/20260704000001_add_messaging_cache_participant_id.sql
git commit -m "feat(db): add participant_id column to messaging_cache for comment-avatar overlap lookup"
```

---

### Task 2: Fix the Facebook conversation avatar field bug

**Files:**
- Modify: `supabase/functions/messaging-api/index.ts:176-282`

- [ ] **Step 1: Replace `fetchParticipantProfile` with platform-correct fields**

Find this exact block (lines 176-200):

```ts
    // Helper: fetch a conversation participant's profile (name + avatar) from Meta.
    // Direct-login Instagram accounts must be queried via graph.instagram.com with the
    // IG user's own token; Facebook Pages and business-login IG go through graph.facebook.com
    // with the page token. Never throws: a missing/blocked profile just yields nulls.
    async function fetchParticipantProfile(
      participantId: string,
      account: any,
      pageToken: string,
      platform: string
    ): Promise<{ name: string | null; profilePic: string | null }> {
      const isDirect = platform === "INSTAGRAM" && isDirectInstagramAccount(account);
      const base = isDirect ? INSTAGRAM_GRAPH_API : GRAPH_API;
      const token = isDirect ? account.access_token : pageToken;
      try {
        const url = `${base}/${participantId}?fields=name,username,profile_pic&access_token=${encodeURIComponent(token)}`;
        const res = await fetch(url);
        if (!res.ok) return { name: null, profilePic: null };
        const data = await res.json();
        const name = data.name || (data.username ? `@${data.username}` : null);
        return { name, profilePic: data.profile_pic || null };
      } catch {
        // Silently fail - privacy restrictions, blocked user, or missing App Review feature
        return { name: null, profilePic: null };
      }
    }
```

Replace it with:

```ts
    // Helper: fetch a conversation participant's profile (name + avatar) from Meta.
    // Direct-login Instagram accounts must be queried via graph.instagram.com with the
    // IG user's own token; Facebook Pages and business-login IG go through graph.facebook.com
    // with the page token. Never throws: a missing/blocked profile just yields nulls.
    //
    // Field names are NOT interchangeable between platforms: Facebook's Messenger User
    // Profile API only recognizes first_name/last_name/profile_pic and fails the entire
    // request (error 100/33 "Object does not exist") if given Instagram-only fields like
    // name/username. Confirmed live against production: requesting the wrong fields for
    // Facebook silently zeroed out every Facebook avatar while Instagram kept working.
    async function fetchParticipantProfile(
      participantId: string,
      account: any,
      pageToken: string,
      platform: string
    ): Promise<{ name: string | null; profilePic: string | null }> {
      const isDirect = platform === "INSTAGRAM" && isDirectInstagramAccount(account);
      const base = isDirect ? INSTAGRAM_GRAPH_API : GRAPH_API;
      const token = isDirect ? account.access_token : pageToken;
      const isFacebookMessenger = platform !== "INSTAGRAM";
      const fields = isFacebookMessenger ? "first_name,last_name,profile_pic" : "name,username,profile_pic";
      try {
        const url = `${base}/${participantId}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
        const res = await fetch(url);
        if (!res.ok) return { name: null, profilePic: null };
        const data = await res.json();
        const name = isFacebookMessenger
          ? [data.first_name, data.last_name].filter(Boolean).join(" ") || null
          : data.name || (data.username ? `@${data.username}` : null);
        return { name, profilePic: data.profile_pic || null };
      } catch {
        // Silently fail - privacy restrictions, blocked user, or missing App Review feature
        return { name: null, profilePic: null };
      }
    }
```

- [ ] **Step 2: Add `participant_id` to the `messaging_cache` upsert**

Find this exact block (lines 246-263):

```ts
    async function cacheParticipantAvatar(req: ParticipantAvatarRequest, profilePic: string): Promise<string | null> {
      const cachedUrl = await cacheAvatarToCloudinary(profilePic, user.id, req.account.platform, req.participant.id);

      await adminClient.from("messaging_cache").upsert(
        {
          user_id: user.id,
          social_account_id: req.account.id,
          platform: req.account.platform,
          conversation_id: req.conversationId,
          participant_name: req.participantName,
          participant_avatar: cachedUrl,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,conversation_id" }
      );

      return cachedUrl;
    }
```

Replace it with:

```ts
    async function cacheParticipantAvatar(req: ParticipantAvatarRequest, profilePic: string): Promise<string | null> {
      const cachedUrl = await cacheAvatarToCloudinary(profilePic, user.id, req.account.platform, req.participant.id);

      await adminClient.from("messaging_cache").upsert(
        {
          user_id: user.id,
          social_account_id: req.account.id,
          platform: req.account.platform,
          conversation_id: req.conversationId,
          participant_id: req.participant.id,
          participant_name: req.participantName,
          participant_avatar: cachedUrl,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,conversation_id" }
      );

      return cachedUrl;
    }
```

- [ ] **Step 3: Sync the change to the vendored n8n node copy check (not applicable)**

Skip — `messaging-api` is not part of the n8n community node; the "apply changes twice" rule in `CLAUDE.md` only applies to `Postora-n8n-community-node/`.

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: no new errors introduced by this file (Deno edge functions are not part of the root `tsconfig` project in this repo, so this checks the frontend only — this is expected and matches how the prior Instagram avatar fix was validated).

- [ ] **Step 5: Run clean-code-guard on the diff**

Use the `clean-code-guard` skill against `supabase/functions/messaging-api/index.ts` before committing, per this repo's mandatory guard workflow.

- [ ] **Step 6: Commit**

```bash
git add supabase/functions/messaging-api/index.ts
git commit -m "fix(messaging-api): use platform-correct Graph API fields so Facebook avatars resolve"
```

---

### Task 3: Deploy `messaging-api` and verify the Facebook avatar fix live

**Files:** none (deployment + verification only)

- [ ] **Step 1: Back up the currently-deployed file**

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "cp /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/messaging-api/index.ts /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/messaging-api/index.ts.bak-$(date +%Y%m%d-%H%M%S)"
```

- [ ] **Step 2: Copy the updated file to the server and verify the hash**

```bash
scp -i ~/.ssh/contabo_key "F:/Postora_new/supabase/functions/messaging-api/index.ts" root@86.48.2.205:/tmp/messaging-api-index.ts
sha256sum "F:/Postora_new/supabase/functions/messaging-api/index.ts"
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "sha256sum /tmp/messaging-api-index.ts"
```

Expected: both `sha256sum` outputs print the identical hash.

- [ ] **Step 3: Move the file into the functions volume and verify again**

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "cp /tmp/messaging-api-index.ts /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/messaging-api/index.ts && sha256sum /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/messaging-api/index.ts"
```

Expected: hash matches the one from Step 2.

- [ ] **Step 4: Restart the functions container**

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code && docker compose restart functions"
```

Use `restart`, not `up -d --no-deps` — the latter has been observed to not reliably reload changed files with no image/config diff.

- [ ] **Step 5: Smoke test**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS https://api.postora.cloud/functions/v1/messaging-api
curl -s -o /dev/null -w '%{http_code}\n' https://api.postora.cloud/functions/v1/get-public-config
```

Expected: both print `200`.

- [ ] **Step 6: Verify live against a real Facebook conversation**

Open `https://postora.cloud/messaging/facebook` in a browser, select the "Xsellpoint" connected account (or any connected Facebook page with existing conversations), and confirm the conversation list shows real profile photos instead of initials.

Then confirm the database was actually updated:

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -c \"select platform, participant_id, participant_avatar, updated_at from messaging_cache where platform = 'facebook' order by updated_at desc limit 5;\""
```

Expected: at least one row with `platform = facebook`, a non-null `participant_id`, and a `participant_avatar` starting with `https://res.cloudinary.com/`.

- [ ] **Step 7: Clean up temp files**

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "rm -f /tmp/messaging-api-index.ts"
```

---

### Task 4: Add Facebook comment avatars — backend field expansion

**Files:**
- Modify: `supabase/functions/comment-manager/index.ts:117`

- [ ] **Step 1: Add `picture` to the Facebook comments field expansion**

Find this exact line:

```ts
        const url = `${GRAPH_API_BASE}/${page_id}/feed?fields=id,message,created_time,comments{id,from,message,created_time,is_hidden,comment_count,parent}&limit=25&access_token=${accessToken}`;
```

Replace it with:

```ts
        const url = `${GRAPH_API_BASE}/${page_id}/feed?fields=id,message,created_time,comments{id,from{id,name,picture},message,created_time,is_hidden,comment_count,parent}&limit=25&access_token=${accessToken}`;
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/comment-manager/index.ts
git commit -m "feat(comment-manager): request commenter picture on Facebook feed comments"
```

---

### Task 5: Add Facebook comment avatars — frontend parsing and type

**Files:**
- Modify: `src/hooks/useCommentInbox.ts:6-52`

- [ ] **Step 1: Add `author_avatar` to the `Comment` interface**

Find this exact block (lines 6-20):

```ts
export interface Comment {
  id: string;
  author_name: string;
  author_id?: string;
  message: string;
  created_time: string;
  is_hidden?: boolean;
  is_reply?: boolean;
  parent_id?: string;
  post_id?: string;
  post_message?: string;
  like_count?: number;
  platform: "facebook" | "instagram";
  replies?: Comment[];
}
```

Replace it with:

```ts
export interface Comment {
  id: string;
  author_name: string;
  author_id?: string;
  author_avatar?: string | null;
  message: string;
  created_time: string;
  is_hidden?: boolean;
  is_reply?: boolean;
  parent_id?: string;
  post_id?: string;
  post_message?: string;
  like_count?: number;
  platform: "facebook" | "instagram";
  replies?: Comment[];
}
```

- [ ] **Step 2: Map the Graph API `picture` field in `parsePageComments`**

Find this exact block (lines 30-52):

```ts
function parsePageComments(data: any): Comment[] {
  const comments: Comment[] = [];
  if (!data?.data) return comments;

  for (const post of data.data) {
    if (!post.comments?.data) continue;
    for (const c of post.comments.data) {
      comments.push({
        id: c.id,
        author_name: c.from?.name || "Unknown",
        author_id: c.from?.id,
        message: c.message || "",
        created_time: c.created_time,
        is_hidden: c.is_hidden || false,
        is_reply: false,
        post_id: post.id,
        post_message: post.message || "",
        platform: "facebook",
      });
    }
  }
  return comments.sort((a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime());
}
```

Replace it with:

```ts
function parsePageComments(data: any): Comment[] {
  const comments: Comment[] = [];
  if (!data?.data) return comments;

  for (const post of data.data) {
    if (!post.comments?.data) continue;
    for (const c of post.comments.data) {
      // Facebook's picture field returns { data: { url, is_silhouette } }. A
      // silhouette is Meta's placeholder for "no real photo available", not a
      // usable image, so treat it the same as no avatar.
      const picture = c.from?.picture?.data;
      comments.push({
        id: c.id,
        author_name: c.from?.name || "Unknown",
        author_id: c.from?.id,
        author_avatar: picture && !picture.is_silhouette ? picture.url : null,
        message: c.message || "",
        created_time: c.created_time,
        is_hidden: c.is_hidden || false,
        is_reply: false,
        post_id: post.id,
        post_message: post.message || "",
        platform: "facebook",
      });
    }
  }
  return comments.sort((a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime());
}
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useCommentInbox.ts
git commit -m "feat(comments): parse Facebook commenter avatar from Graph API picture field"
```

---

### Task 6: Add Instagram comment avatars — DM-overlap backend lookup

**Files:**
- Modify: `supabase/functions/comment-manager/index.ts:1,55-163`

- [ ] **Step 1: Import `createClient`'s type for the helper signatures**

The file already imports `createClient` at line 1 — no import changes needed, since the helper functions below will receive the already-constructed `supabase` client as a parameter (same pattern the rest of the file uses).

- [ ] **Step 2: Add three small helper functions above `Deno.serve`**

Find this exact line (currently line 53, right before `Deno.serve`):

```ts
Deno.serve(async (req) => {
```

Insert this block immediately above it:

```ts
// Best-effort commenter avatars for Instagram: Meta gives businesses no direct
// way to get a commenter's photo (IG comments carry no picture field, and the
// profile-lookup API only unlocks for users who have messaged the business, not
// merely commented — confirmed against Meta's docs). If a commenter has also
// DM'd this account, messaging-api will already have cached their avatar in
// messaging_cache, so we reuse it for free instead of guessing at a live call
// that would fail for almost everyone.
function collectCommenterIds(mediaList: any[]): string[] {
  const ids = new Set<string>();
  for (const media of mediaList) {
    for (const comment of media?.comments?.data || []) {
      if (comment?.from?.id) ids.add(comment.from.id);
      for (const reply of comment?.replies?.data || []) {
        if (reply?.from?.id) ids.add(reply.from.id);
      }
    }
  }
  return Array.from(ids);
}

async function fetchDmOverlapAvatars(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  commenterIds: string[]
): Promise<Map<string, string>> {
  const { data: cached } = await supabase
    .from("messaging_cache")
    .select("participant_id, participant_avatar")
    .eq("user_id", userId)
    .in("participant_id", commenterIds);

  return new Map(
    (cached || [])
      .filter((row: any) => row.participant_avatar)
      .map((row: any) => [row.participant_id as string, row.participant_avatar as string])
  );
}

function applyCommenterAvatars(mediaList: any[], avatarByParticipant: Map<string, string>): void {
  for (const media of mediaList) {
    for (const comment of media?.comments?.data || []) {
      comment.author_avatar = avatarByParticipant.get(comment?.from?.id) || null;
      for (const reply of comment?.replies?.data || []) {
        reply.author_avatar = avatarByParticipant.get(reply?.from?.id) || null;
      }
    }
  }
}

```

- [ ] **Step 3: Call the helpers from `get_ig_comments`**

Find this exact block (lines 152-162 in the original file):

```ts
        // Defensively normalize: never drop a media entry just because its
        // comments edge errored (Meta sometimes returns partial errors).
        if (Array.isArray(raw?.data)) {
          for (const media of raw.data) {
            if (media && media.comments && (media.comments as { error?: unknown }).error) {
              media.comments = { data: [] };
            }
          }
        }
        result = raw;
        break;
      }
```

Replace it with:

```ts
        // Defensively normalize: never drop a media entry just because its
        // comments edge errored (Meta sometimes returns partial errors).
        if (Array.isArray(raw?.data)) {
          for (const media of raw.data) {
            if (media && media.comments && (media.comments as { error?: unknown }).error) {
              media.comments = { data: [] };
            }
          }
          const commenterIds = collectCommenterIds(raw.data);
          if (commenterIds.length > 0) {
            const avatarByParticipant = await fetchDmOverlapAvatars(supabase, user.id, commenterIds);
            if (avatarByParticipant.size > 0) applyCommenterAvatars(raw.data, avatarByParticipant);
          }
        }
        result = raw;
        break;
      }
```

- [ ] **Step 4: Run clean-code-guard on the diff**

Use the `clean-code-guard` skill against `supabase/functions/comment-manager/index.ts` before committing.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/comment-manager/index.ts
git commit -m "feat(comment-manager): reuse cached DM avatars for Instagram commenters who have also messaged"
```

---

### Task 7: Add Instagram comment avatars — frontend parsing

**Files:**
- Modify: `src/hooks/useCommentInbox.ts:54-101`

- [ ] **Step 1: Map `author_avatar` through in `parseIgComments`**

Find this exact block (lines 54-101):

```ts
function parseIgComments(data: any): Comment[] {
  const comments: Comment[] = [];
  if (!data?.data) return comments;

  for (const media of data.data) {
    const engagement = media.like_count != null || media.comments_count != null
      ? `${media.like_count ?? 0} likes · ${media.comments_count ?? 0} comments`
      : "";
    const postLabel = media.caption
      ? `${media.caption}${engagement ? ` · ${engagement}` : ""}`
      : (engagement ? `[${media.media_type || "media"}] ${engagement}` : "");
    if (!media.comments?.data) continue;
    for (const c of media.comments.data) {
      comments.push({
        id: c.id,
        author_name: c.from?.username || c.username || "Unknown",
        author_id: c.from?.id,
        message: c.text || "",
        like_count: c.like_count,
        created_time: c.timestamp,
        is_hidden: c.hidden || false,
        is_reply: false,
        post_id: media.id,
        post_message: postLabel,
        platform: "instagram",
      });
      // Flatten replies so they show in the inbox as well.
      const replies = c.replies?.data || [];
      for (const r of replies) {
        comments.push({
          id: r.id,
          author_name: r.from?.username || r.username || "Unknown",
          author_id: r.from?.id,
          message: r.text || "",
          like_count: r.like_count,
          created_time: r.timestamp,
          is_hidden: r.hidden || false,
          is_reply: true,
          parent_id: c.id,
          post_id: media.id,
          post_message: postLabel,
          platform: "instagram",
        });
      }
    }
  }
  return comments.sort((a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime());
}
```

Replace it with:

```ts
function parseIgComments(data: any): Comment[] {
  const comments: Comment[] = [];
  if (!data?.data) return comments;

  for (const media of data.data) {
    const engagement = media.like_count != null || media.comments_count != null
      ? `${media.like_count ?? 0} likes · ${media.comments_count ?? 0} comments`
      : "";
    const postLabel = media.caption
      ? `${media.caption}${engagement ? ` · ${engagement}` : ""}`
      : (engagement ? `[${media.media_type || "media"}] ${engagement}` : "");
    if (!media.comments?.data) continue;
    for (const c of media.comments.data) {
      comments.push({
        id: c.id,
        author_name: c.from?.username || c.username || "Unknown",
        author_id: c.from?.id,
        author_avatar: c.author_avatar || null,
        message: c.text || "",
        like_count: c.like_count,
        created_time: c.timestamp,
        is_hidden: c.hidden || false,
        is_reply: false,
        post_id: media.id,
        post_message: postLabel,
        platform: "instagram",
      });
      // Flatten replies so they show in the inbox as well.
      const replies = c.replies?.data || [];
      for (const r of replies) {
        comments.push({
          id: r.id,
          author_name: r.from?.username || r.username || "Unknown",
          author_id: r.from?.id,
          author_avatar: r.author_avatar || null,
          message: r.text || "",
          like_count: r.like_count,
          created_time: r.timestamp,
          is_hidden: r.hidden || false,
          is_reply: true,
          parent_id: c.id,
          post_id: media.id,
          post_message: postLabel,
          platform: "instagram",
        });
      }
    }
  }
  return comments.sort((a, b) => new Date(b.created_time).getTime() - new Date(a.created_time).getTime());
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useCommentInbox.ts
git commit -m "feat(comments): parse Instagram DM-overlap commenter avatar"
```

---

### Task 8: Render commenter avatars in the comment list UI

**Files:**
- Modify: `src/components/comments/CommentList.tsx`

- [ ] **Step 1: Add the Avatar import**

Find this exact line (line 6):

```tsx
import { Reply, EyeOff, Eye, Trash2, Send, Loader2, Heart } from "lucide-react";
```

Add this import directly below it:

```tsx
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
```

- [ ] **Step 2: Wrap the comment row content with an avatar**

Find this exact block (lines 61-89, the opening of each comment `Card`):

```tsx
        <Card key={comment.id} className={comment.is_hidden ? "opacity-60 border-dashed" : ""}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-sm">{comment.author_name}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(comment.created_time), { addSuffix: true })}
                  </span>
                  {comment.is_hidden && (
                    <Badge variant="secondary" className="text-xs">Hidden</Badge>
                  )}
                  <Badge variant="outline" className="text-xs capitalize">
                    {comment.platform}
                  </Badge>
                  {comment.like_count != null && (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Heart className="h-3 w-3" />
                      {comment.like_count}
                    </span>
                  )}
                </div>
                <p className="text-sm">{comment.message}</p>
                {comment.post_message && (
                  <p className="text-xs text-muted-foreground mt-1 truncate">
                    On: {comment.post_message}
                  </p>
                )}
              </div>
```

Replace it with:

```tsx
        <Card key={comment.id} className={comment.is_hidden ? "opacity-60 border-dashed" : ""}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <Avatar className="h-9 w-9 shrink-0">
                  <AvatarImage src={comment.author_avatar || undefined} alt={comment.author_name} />
                  <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                    {comment.author_name?.charAt(0)?.toUpperCase() || "?"}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm">{comment.author_name}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(comment.created_time), { addSuffix: true })}
                    </span>
                    {comment.is_hidden && (
                      <Badge variant="secondary" className="text-xs">Hidden</Badge>
                    )}
                    <Badge variant="outline" className="text-xs capitalize">
                      {comment.platform}
                    </Badge>
                    {comment.like_count != null && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Heart className="h-3 w-3" />
                        {comment.like_count}
                      </span>
                    )}
                  </div>
                  <p className="text-sm">{comment.message}</p>
                  {comment.post_message && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">
                      On: {comment.post_message}
                    </p>
                  )}
                </div>
              </div>
```

Note: this adds one extra layer of nesting (`<div className="flex items-start gap-3 flex-1 min-w-0">` wrapping the avatar + text column) so the avatar sits beside the text block while the existing action-buttons `<div>` (unchanged, immediately following) stays a sibling at the same level — do not modify anything below the block shown above; the closing `</div>` for the outer `flex items-start justify-between gap-3` row and everything after it (action buttons, reply textarea) stays exactly as it is today.

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Start the dev server and verify visually**

```bash
npm run dev
```

Open the comment manager page (Facebook and Instagram tabs) in a browser. Confirm:
- Every comment row shows an `Avatar` circle to the left of the author name (photo if available, initials otherwise).
- No layout shift or overlap with the existing hide/reply/delete action buttons.
- The reply textarea (when "Reply" is clicked) still renders correctly below the comment, unaffected by the new wrapping div.

- [ ] **Step 5: Run clean-code-guard on the diff**

Use the `clean-code-guard` skill against `src/components/comments/CommentList.tsx` before committing.

- [ ] **Step 6: Commit**

```bash
git add src/components/comments/CommentList.tsx
git commit -m "feat(comments): render commenter avatar in comment list UI"
```

---

### Task 9: Deploy `comment-manager` and verify both platforms live

**Files:** none (deployment + verification only)

- [ ] **Step 1: Back up the currently-deployed file**

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "cp /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/comment-manager/index.ts /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/comment-manager/index.ts.bak-$(date +%Y%m%d-%H%M%S)"
```

- [ ] **Step 2: Copy the updated file to the server and verify the hash**

```bash
scp -i ~/.ssh/contabo_key "F:/Postora_new/supabase/functions/comment-manager/index.ts" root@86.48.2.205:/tmp/comment-manager-index.ts
sha256sum "F:/Postora_new/supabase/functions/comment-manager/index.ts"
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "sha256sum /tmp/comment-manager-index.ts"
```

Expected: both `sha256sum` outputs print the identical hash.

- [ ] **Step 3: Move the file into the functions volume and verify again**

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "cp /tmp/comment-manager-index.ts /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/comment-manager/index.ts && sha256sum /etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/comment-manager/index.ts"
```

Expected: hash matches the one from Step 2.

- [ ] **Step 4: Restart the functions container**

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code && docker compose restart functions"
```

- [ ] **Step 5: Smoke test**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS https://api.postora.cloud/functions/v1/comment-manager
```

Expected: `200`.

- [ ] **Step 6: Verify Facebook comment avatars live**

Open the Facebook comment manager tab in the browser for a connected page. If no page currently has comments (confirmed to be the case for every connected Facebook page as of this task's investigation), leave a real test comment on one of the connected pages' posts from a personal Facebook account, refresh the comment manager, and confirm the avatar renders. If Meta silently drops the `picture` field for any reason, confirm the UI falls back cleanly to initials with no error — this is the expected graceful-degradation behavior either way.

- [ ] **Step 7: Verify Instagram comment avatars live (best-effort)**

Open the Instagram comment manager tab for a connected IG account that has both existing DM conversations (with cached avatars from Task 3) and comment activity. If the same person appears in both, confirm their avatar now appears in the comment list too. If no such overlap exists in the current data, confirm there is no error and all commenters still show initials — this is the expected outcome for the common case where nobody has DM'd the business.

- [ ] **Step 8: Clean up temp files**

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "rm -f /tmp/comment-manager-index.ts"
```

---

### Task 10: Live-verify the Threads mentions avatar pipeline

**Files:** none (verification only — code change only if Step 3 proves it broken)

- [ ] **Step 1: Identify a Threads account to test with**

Use social account `d12f0ebb-6d1f-471f-aee1-374eb0477cf8` (platform_user_id `37174132225518391`) — this is the account with the 2 known stale legacy mention rows, so it's a real, already-connected account to test a fresh refresh against.

- [ ] **Step 2: Trigger a live refresh via the app**

Open `https://postora.cloud/messaging/thread` in a browser, select the Threads account from Step 1, and click the mentions refresh action (wired to `useRefreshThreadsMentions()`, which calls the `threads-mentions` edge function with `action: "refresh"`).

- [ ] **Step 3: Check whether a fresh mention row got a real avatar**

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -c \"select mention_id, mention_author_id, mention_author_username, mention_author_avatar_url, mentioned_at from threads_mentions where social_account_id = 'd12f0ebb-6d1f-471f-aee1-374eb0477cf8' order by mentioned_at desc limit 10;\""
```

**If this account has no new mentions since the last refresh** (the only 2 rows are still the same stale ones with `mention_author_id` null), this test is inconclusive for this specific account — repeat Steps 1-3 with a different connected Threads account that has more recent activity. List candidates:

```bash
ssh -i ~/.ssh/contabo_key root@86.48.2.205 "docker exec postorasupabase-supabase-j8axyh-supabase-db psql -U postgres -d postgres -c \"select id, platform_username, platform_user_id from social_accounts where platform = 'threads' and is_active = true;\""
```

- [ ] **Step 4: Decide — done, or fix**

**If any row now shows a non-null `mention_author_id` and a `mention_author_avatar_url` starting with `https://res.cloudinary.com/`:** the pipeline works correctly. No code change needed. Skip to Step 5.

**If every account tested still produces `mention_author_id = null` on a fresh mention:** the pipeline is genuinely broken. Do not guess a fix — this needs the same evidence-based method used to find the Facebook Messenger bug: read `supabase/functions/threads-mentions/index.ts`'s mention-normalization code around the `user{id,username}` field request (currently around line 241), and live-curl the exact same `graph.threads.net/v1.0/me/mentions?fields=...` URL with a real account's token to see what Meta actually returns for `user.id` on a fresh mention. Stop this task here, report the concrete finding, and treat the actual fix as a new, separately-scoped task — do not bundle an unverified guess into this plan.

- [ ] **Step 5: Document the outcome**

If the pipeline was confirmed working, no further action for this task — the 2 legacy rows in production remain harmlessly stale (they predate this code and will never resolve, but they're just 2 old rows, not a pattern).

---

### Task 11: Guard pass, final verification, and report

**Files:** none (process only)

- [ ] **Step 1: Run `clean-code-guard` across all changed production files**

Target files: `supabase/functions/messaging-api/index.ts`, `supabase/functions/comment-manager/index.ts`, `src/hooks/useCommentInbox.ts`, `src/components/comments/CommentList.tsx`.

- [ ] **Step 2: Confirm no test files were added or changed**

This plan intentionally adds no test files (see the Testing note in this plan's header). Confirm `git status` shows no new files under any `*.test.ts` pattern before proceeding — if any exist, `test-guard` must run against them first.

- [ ] **Step 3: Full type-check one more time**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Push the branch**

```bash
git push
```

- [ ] **Step 5: Save the fix history to mem0**

Use `mcp__mem0-mcp__add_memory` to record: the Facebook Messenger field-name bug and its fix, the Facebook/Instagram comment-avatar additions, the DM-overlap reuse strategy for Instagram comments, the confirmed Threads-reply-API ID limitation, and the Threads-mentions live-verification outcome from Task 10 — matching the level of detail saved for the original Instagram DM avatar fix in the same conversation history.

- [ ] **Step 6: Final report to the user**

Summarize: what was broken (Facebook conversation avatars — wrong Graph API fields), what was added (Facebook comment avatars, Instagram best-effort comment avatars via DM overlap), what was verified and found already-correct or fixed (Threads mentions), and what is a confirmed, permanent Meta API limitation with no code fix possible (Threads reply avatars for third parties). List every file changed and every deploy step completed.

---

## Self-review notes

- **Spec coverage:** Section A → Tasks 1-3. Section B → Tasks 4-5, 9. Section C → Tasks 6-7, 9. Section D → Task 10. Section E → intentionally no task (spec says no code change; Task 11's report states this explicitly to the user).
- **No placeholders:** every step has exact file paths, exact code, and exact commands. Task 10's "fix" branch is a decision point with a concrete stop-and-report instruction, not a deferred implementation — the actual fix (if needed) is out of this plan's scope by design, since guessing at an unverified fix would violate this project's "confirm root cause with evidence before writing any fix" rule.
- **Type consistency:** `Comment.author_avatar` (Task 5) is used identically in Task 7's `parseIgComments` and Task 8's `CommentList.tsx`. `messaging_cache.participant_id` (Task 1) is written in Task 2 and read in Task 6 with matching column name and type (`text`/`string`).
