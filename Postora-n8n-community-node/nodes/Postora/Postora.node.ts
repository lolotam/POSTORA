import {
  IAllExecuteFunctions,
  IBinaryData,
  IExecuteFunctions,
  ILoadOptionsFunctions,
  INodeExecutionData,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  INodeProperties,
  NodeConnectionTypes,
  NodeApiError,
  JsonObject,
} from "n8n-workflow";

// n8n's own binary storage (mode: "database"/"filesystem") can lose track of a
// referenced blob — most commonly when a node's output was "pinned" in the editor
// and the underlying file was later cleaned up by n8n's own retention/pruning.
// The resulting error ("Could not find any entity of type BinaryDataFile...") comes
// straight out of n8n-core before any Postora code runs, so we can't prevent it —
// only recognize it and explain what's actually wrong.
function describeBinaryError(error: any, propertyName: string): string {
  const message = error?.message || String(error);
  if (/BinaryDataFile/i.test(message) || /could not find any entity/i.test(message)) {
    return (
      `The binary data for property "${propertyName}" is no longer available in n8n's storage. ` +
      `This usually happens when the upstream node's output was "pinned" (📌) in the editor and the ` +
      `underlying file was since cleaned up. Unpin the upstream node and re-run the workflow with a ` +
      `fresh execution, then try again.`
    );
  }
  if (/no binary data/i.test(message)) {
    return (
      `No binary data was found on property "${propertyName}" for this item. Check that the ` +
      `upstream node actually outputs a binary property with this exact name.`
    );
  }
  return message;
}

// Accepts both "id-1,id-2,id-3" and "[id-1, id-2, id-3]" — the brackets are just
// stripped before splitting, so users can paste either style without a validation error.
function parseCommaSeparatedList(raw: string): string[] {
  const withoutBrackets = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  return withoutBrackets
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Accepts a comma-separated string OR an array (the latter typically comes from an
// n8n expression like ={{ $json.urls }}). Always returns a clean string[].
function normalizeList(input: string | string[] | undefined | null): string[] {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input.map((x) => String(x).trim()).filter((x) => x.length > 0);
  }
  return parseCommaSeparatedList(String(input));
}

// Throws a clear, field-named error for a visible required parameter that came
// back empty — so users see "Required parameter 'X' is empty" instead of n8n's
// generic "Could not get parameter" when a field is hidden/blank.
function requireParam(value: any, label: string): any {
  const isEmpty =
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0);
  if (isEmpty) {
    throw new Error(
      `Required parameter '${label}' is missing or empty. Open the node and fill in the '${label}' field, then run again.`,
    );
  }
  return value;
}

// Validates that a string is a UUID (v1–v5). Used to reject obviously-bad media file
// IDs before we hit the network.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUuid(value: string): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

const mediaSourceOptions = [
  { name: "None (text-only post)", value: "none" },
  { name: "URL (paste https:// links)", value: "url" },
  { name: "Binary Data (from n8n node)", value: "binary" },
  { name: "Media File ID (UUIDs from Upload)", value: "mediafileid" },
];

const storyMediaSourceOptions = mediaSourceOptions.filter((option) => option.value !== "none");

const mediaSourceDescription =
  "How to attach media to the post:\n" +
  "• URL — paste direct links (https://…)\n" +
  "• Binary Property — use binary data from a previous n8n node\n" +
  "• Media File ID — use UUIDs returned by a previous Media → Upload step";

async function readBinaryOrThrow(
  ctx: IExecuteFunctions,
  itemIndex: number,
  propertyName: string,
): Promise<{ binaryData: IBinaryData; buffer: Buffer }> {
  try {
    const binaryData = ctx.helpers.assertBinaryData(itemIndex, propertyName);
    const buffer = await ctx.helpers.getBinaryDataBuffer(itemIndex, propertyName);
    return { binaryData, buffer };
  } catch (error: any) {
    throw new Error(describeBinaryError(error, propertyName));
  }
}

// Single source of truth for "is this host off-limits to fetch from" — applied to
// the original URL AND to every redirect hop, since a hostname's safety can only be
// judged once we know the concrete host being connected to.
function isPrivateOrReservedHost(hostname: string): boolean {
  // URL.hostname keeps the brackets on IPv6 literals (e.g. "[fd00::1]"), which
  // would otherwise defeat every string check below.
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");

  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost")
  ) {
    return true;
  }

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const oct = ipv4Match.slice(1, 5).map((n) => parseInt(n, 10));
    if (oct.some((o) => o > 255)) return true; // malformed IP literal — reject fail-safe
    const [a, b] = oct;
    const isLoopback = a === 127;
    const isLinkLocal = a === 169 && b === 254; // 169.254.0.0/16 only — not all of 169.0.0.0/8
    const isPrivate =
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0 ||
      a >= 224; // 224+ = multicast/reserved
    return isLoopback || isLinkLocal || isPrivate;
  }

  // ::1 (loopback), fc00::/7 (unique local), fe80::/10 (link-local)
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
}

const MAX_REDIRECTS = 5;

// Follows redirects one hop at a time, validating the scheme and host of EVERY hop
// before making that request — unlike `redirect: "follow"`, which would already have
// contacted a private/internal target before any check on the final URL could run.
async function fetchFollowingSafeRedirects(startUrl: string, timeoutMs: number): Promise<Response> {
  let currentUrl = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new Error(`'${currentUrl}' is not a valid URL.`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`'${currentUrl}' uses an unsupported scheme. Only http and https are allowed.`);
    }
    if (isPrivateOrReservedHost(parsed.hostname)) {
      throw new Error(`URL host '${parsed.hostname}' is not allowed (private/loopback/reserved).`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Postora-n8n-node/1.1.10" },
      });
    } catch (err: any) {
      throw new Error(`Failed to download '${currentUrl}': ${err?.message || String(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get("location");
    if (isRedirect && location) {
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return res;
  }

  throw new Error(`'${startUrl}' redirected more than ${MAX_REDIRECTS} times.`);
}

// SSRF-safe download of a single media URL. Returns the raw buffer plus an inferred
// filename and mime type. Rejects private/loopback hosts, non-http(s) schemes,
// oversized or wrong-content-type responses. Every redirect hop is validated before
// it's followed, so a private/internal target is never actually contacted.
async function safeFetchAndStage(
  url: string,
): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`'${url}' is not a valid URL.`);
  }

  const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
  const res = await fetchFollowingSafeRedirects(url, 30_000);

  if (!res.ok) {
    throw new Error(`Download of '${url}' failed with HTTP ${res.status}.`);
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/") && !contentType.startsWith("video/")) {
    throw new Error(
      `'${url}' returned Content-Type '${contentType || "(none)"}'. Only image/* and video/* are accepted.`,
    );
  }

  const contentLength = parseInt(res.headers.get("content-length") || "0", 10);
  if (contentLength && contentLength > MAX_BYTES) {
    throw new Error(`'${url}' is too large (${contentLength} bytes > ${MAX_BYTES} byte limit).`);
  }

  const arrayBuf = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuf);
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`'${url}' exceeded the ${MAX_BYTES}-byte download limit during transfer.`);
  }

  // Filename: Content-Disposition → URL basename → fallback by mime
  let fileName = "upload";
  const cd = res.headers.get("content-disposition") || "";
  const cdMatch = cd.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)/i);
  if (cdMatch && cdMatch[1]) {
    fileName = decodeURIComponent(cdMatch[1].trim());
  } else {
    const base = parsed.pathname.split("/").filter(Boolean).pop();
    if (base) fileName = decodeURIComponent(base);
  }
  if (fileName === "upload") {
    const ext = contentType.startsWith("image/") ? "img" : "video";
    fileName = `upload.${ext}`;
  }

  return { buffer, fileName, mimeType: contentType.split(";")[0].trim() };
}

const platformOptions = [
  { name: "1. Facebook", value: "facebook" },
  { name: "2. Instagram", value: "instagram" },
  { name: "3. Threads", value: "threads" },
  { name: "4. YouTube (Beta)", value: "youtube" },
  { name: "5. Pinterest", value: "pinterest" },
  { name: "6. LinkedIn (Personal Only)", value: "linkedin" },
  { name: "7. Bluesky", value: "bluesky" },
  // { name: '8. X / Twitter (Coming Soon)', value: 'twitter' },
  // { name: '9. TikTok (Coming Soon)', value: 'tiktok' },
  // { name: '10. Reddit (Coming Soon)', value: 'reddit' },
];

export class Postora implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Postora",
    name: "postora",
    icon: "file:postora.png",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: "Publish content to social media platforms via Postora",
    defaults: {
      name: "Postora",
    },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: "postoraApi",
        required: true,
      },
    ],
    properties: [
      // ── Resource ──
      {
        displayName: "Resource",
        name: "resource",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "Account", value: "account" },
          { name: "Media", value: "media" },
          { name: "Post", value: "post" },
        ],
        default: "post",
      },

      // ── Post Operations ──
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        displayOptions: { show: { resource: ["post"] } },
        options: [
          { name: "Create", value: "create", description: "Create and publish a post", action: "Create a post" },
          {
            name: "Get Status",
            value: "getStatus",
            description: "Get post status and results",
            action: "Get post status",
          },
          { name: "List", value: "list", description: "List recent posts", action: "List posts" },
        ],
        default: "create",
      },

      // ── Media Operations ──
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        displayOptions: { show: { resource: ["media"] } },
        options: [{ name: "Upload", value: "upload", description: "Upload a media file", action: "Upload media" }],
        default: "upload",
      },

      // ── Account Operations ──
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        displayOptions: { show: { resource: ["account"] } },
        options: [{ name: "List", value: "list", description: "List connected accounts", action: "List accounts" }],
        default: "list",
      },

      // ═══════════════════════════════════
      // Post → Create fields (reordered: Platform first)
      // ═══════════════════════════════════
      {
        displayName: "Platform",
        name: "platform",
        type: "options",
        noDataExpression: true,
        options: platformOptions,
        default: "facebook",
        required: true,
        displayOptions: { show: { resource: ["post"], operation: ["create"] } },
        description: "Target platform for the post",
      },
      ...platformOptions.map(
        (p) =>
          ({
            displayName: "Social Accounts",
            name: `socialAccounts_${p.value}`,
            type: "multiOptions",
            noDataExpression: true,
            typeOptions: {
              loadOptionsMethod: "getAccounts",
            },
            default: [],
            required: true,
            displayOptions: { show: { resource: ["post"], operation: ["create"], platform: [p.value] } },
            description: `Select ${p.name.replace(/^\d+\.\s*/, "")} accounts to post to`,
          }) as INodeProperties,
      ),
      {
        displayName: "Post Type",
        name: "postType",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "Feed", value: "feed", description: "Regular feed post" },
          {
            name: "Story",
            value: "story",
            description:
              "📸 Stories only support media (photos & videos). When Story is selected, captions, locations, first comments, and all other text fields are ignored by the API — only the media file is published.",
          },
          { name: "Reel", value: "reel", description: "Short-form video (Reels)" },
        ],
        default: "feed",
        displayOptions: { show: { resource: ["post"], operation: ["create"], platform: ["facebook", "instagram"] } },
        description:
          "Where to publish. Story only supports a single photo or video — all other fields (caption, location, first comment, etc.) are ignored for stories.",
      },
      // Caption for FB/IG — hidden when Story is selected
      {
        displayName: "Caption",
        name: "caption",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
        displayOptions: {
          show: { resource: ["post"], operation: ["create"], platform: ["facebook", "instagram"] },
          hide: { postType: ["story"] },
        },
        description: "The post caption / text content",
      },
      // Caption for all other platforms (no postType field exists for them)
      {
        displayName: "Caption",
        name: "caption",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
        displayOptions: {
          show: { resource: ["post"], operation: ["create"] },
          hide: { platform: ["facebook", "instagram"] },
        },
        description: "The post caption / text content",
      },
      {
        displayName: "Media Source",
        name: "mediaSource",
        type: "options",
        noDataExpression: true,
        options: storyMediaSourceOptions,
        default: "url",
        displayOptions: {
          show: {
            resource: ["post"],
            operation: ["create"],
            platform: ["facebook", "instagram"],
            postType: ["story"],
          },
        },
        description: mediaSourceDescription,
      },
      {
        displayName: "Media Source",
        name: "mediaSource",
        type: "options",
        noDataExpression: true,
        options: mediaSourceOptions,
        default: "none",
        displayOptions: {
          show: { resource: ["post"], operation: ["create"], platform: ["facebook", "instagram"] },
          hide: { postType: ["story"] },
        },
        description: mediaSourceDescription,
      },
      {
        displayName: "Media Source",
        name: "mediaSource",
        type: "options",
        noDataExpression: true,
        options: mediaSourceOptions,
        default: "none",
        displayOptions: {
          show: { resource: ["post"], operation: ["create"] },
          hide: { platform: ["facebook", "instagram"] },
        },
        description: mediaSourceDescription,
      },
      {
        displayName: "Media URLs",
        name: "mediaUrls",
        type: "string",
        default: "",
        displayOptions: { show: { resource: ["post"], operation: ["create"], mediaSource: ["url"] } },
        description:
          "🔗 Comma-separated direct media URLs (https://…). The API will download each file and attach it to the post. " +
          "Only use this option when you have public links to image/video files.",
      },
      {
        displayName: "Binary Property",
        name: "mediaBinaryProperty",
        type: "string",
        default: "data",
        displayOptions: { show: { resource: ["post"], operation: ["create"], mediaSource: ["binary"] } },
        description:
          "Name of the binary property containing the media file(s). For multiple files, use comma-separated names (e.g., data,data1,data2).",
      },
      {
        displayName: "Media File ID(s)",
        name: "mediaFileIds",
        type: "string",
        default: "",
        displayOptions: { show: { resource: ["post"], operation: ["create"], mediaSource: ["mediafileid"] } },
        description:
          "🆔 UUIDs returned by a previous Media → Upload step (e.g. 7ee95777-b5fa-41a3-b314-5d67a027e569). " +
          "Comma-separated for multiple. ⚠️ Do NOT paste URLs here — use the 'URL' source instead.\n" +
          "Tip: in an expression, reference the 'id' field (UUID), NOT 'file_path' (which is a Cloudinary URL).",
      },
      {
        displayName: "Schedule At",
        name: "scheduledAt",
        type: "dateTime",
        default: "",
        displayOptions: { show: { resource: ["post"], operation: ["create"] } },
        description: "Schedule post for a future time (ISO 8601). Leave empty to post immediately.",
      },
      // ── Facebook Additional Options (hidden for Story) ──
      {
        displayName: "Additional Options",
        name: "additionalOptions",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: {
          show: { resource: ["post"], operation: ["create"], platform: ["facebook"] },
          hide: { postType: ["story"] },
        },
        options: [
          {
            displayName: "First Comment",
            name: "firstComment",
            type: "string",
            typeOptions: { rows: 3 },
            default: "",
            description: "📝 Auto-post a first comment after publishing.",
          },
        ],
      },
      // ── Instagram Additional Options (hidden for Story) ──
      {
        displayName: "Additional Options",
        name: "additionalOptions",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: {
          show: { resource: ["post"], operation: ["create"], platform: ["instagram"] },
          hide: { postType: ["story"] },
        },
        options: [
          {
            displayName: "First Comment",
            name: "firstComment",
            type: "string",
            typeOptions: { rows: 3 },
            default: "",
            description: "📝 Auto-post a first comment after publishing.",
          },
        ],
      },
      // ── YouTube Additional Options ──
      {
        displayName: "Additional Options",
        name: "additionalOptions",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: {
          show: { resource: ["post"], operation: ["create"], platform: ["youtube"] },
        },
        options: [
          {
            displayName: "YouTube Title",
            name: "youtubeTitle",
            type: "string",
            default: "",
            description: "🎬 Title for YouTube videos.",
          },
          {
            displayName: "YouTube Visibility",
            name: "youtubeVisibility",
            type: "options",
            options: [
              { name: "Public", value: "public" },
              { name: "Unlisted", value: "unlisted" },
              { name: "Private", value: "private" },
            ],
            default: "public",
            description: "🔒 YouTube video visibility setting.",
          },
          {
            displayName: "YouTube Category",
            name: "youtubeCategory",
            type: "string",
            default: "22",
            description: "📂 YouTube category ID (default: 22 — People & Blogs).",
          },
          {
            displayName: "First Comment",
            name: "firstComment",
            type: "string",
            typeOptions: { rows: 3 },
            default: "",
            description: "📝 Auto-post a first comment after publishing.",
          },
        ],
      },
      // ── TikTok Additional Options ──
      {
        displayName: "Additional Options",
        name: "additionalOptions",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: {
          show: { resource: ["post"], operation: ["create"], platform: ["tiktok"] },
        },
        options: [
          {
            displayName: "TikTok Privacy",
            name: "tiktokPrivacy",
            type: "options",
            options: [
              { name: "Public", value: "PUBLIC_TO_EVERYONE" },
              { name: "Friends", value: "MUTUAL_FOLLOW_FRIENDS" },
              { name: "Followers", value: "FOLLOWER_OF_CREATOR" },
              { name: "Only Me", value: "SELF_ONLY" },
            ],
            default: "PUBLIC_TO_EVERYONE",
            description: "🔒 TikTok video privacy level.",
          },
          {
            displayName: "TikTok Allow Comments",
            name: "tiktokAllowComments",
            type: "boolean",
            default: false,
            description: "💬 Allow comments on TikTok video.",
          },
          {
            displayName: "TikTok Allow Duet",
            name: "tiktokAllowDuet",
            type: "boolean",
            default: false,
            description: "🎭 Allow duets on TikTok video.",
          },
          {
            displayName: "TikTok Allow Stitch",
            name: "tiktokAllowStitch",
            type: "boolean",
            default: false,
            description: "✂️ Allow stitches on TikTok video.",
          },
        ],
      },
      // ── LinkedIn Additional Options ──
      {
        displayName: "Additional Options",
        name: "additionalOptions",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: {
          show: { resource: ["post"], operation: ["create"], platform: ["linkedin"] },
        },
        options: [
          {
            displayName: "First Comment",
            name: "firstComment",
            type: "string",
            typeOptions: { rows: 3 },
            default: "",
            description: "📝 Auto-post a first comment after publishing.",
          },
        ],
      },
      // ── Pinterest Additional Options ──
      {
        displayName: "Additional Options",
        name: "additionalOptions",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: {
          show: { resource: ["post"], operation: ["create"], platform: ["pinterest"] },
        },
        options: [
          {
            displayName: "Pinterest Board ID",
            name: "pinterestBoardId",
            type: "string",
            default: "",
            description: "📌 Pinterest board to pin to.",
          },
          {
            displayName: "Pinterest Title",
            name: "pinterestTitle",
            type: "string",
            default: "",
            description: "📌 Title for the Pinterest pin.",
          },
        ],
      },
      // ── Threads Additional Options ──
      {
        displayName: "Additional Options",
        name: "additionalOptions",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: {
          show: { resource: ["post"], operation: ["create"], platform: ["threads"] },
        },
        options: [
          {
            displayName: "First Comment",
            name: "firstComment",
            type: "string",
            typeOptions: { rows: 3 },
            default: "",
            description: "📝 Auto-post a first comment after publishing.",
          },
        ],
      },
      // ── Reddit Additional Options ──
      {
        displayName: "Additional Options",
        name: "additionalOptions",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: {
          show: { resource: ["post"], operation: ["create"], platform: ["reddit"] },
        },
        options: [
          {
            displayName: "Reddit Subreddit",
            name: "redditSubreddit",
            type: "string",
            default: "",
            description: "📋 Subreddit name (without r/).",
          },
          {
            displayName: "Reddit Title",
            name: "redditTitle",
            type: "string",
            default: "",
            description: "📋 Title for the Reddit post.",
          },
        ],
      },

      // ═══════════════════════════════════
      // Post → Get Status fields
      // ═══════════════════════════════════
      {
        displayName: "Post ID",
        name: "postId",
        type: "string",
        default: "",
        required: true,
        displayOptions: { show: { resource: ["post"], operation: ["getStatus"] } },
        description: "The ID of the post to check",
      },

      // ═══════════════════════════════════
      // Post → List fields
      // ═══════════════════════════════════
      {
        displayName: "Status Filter",
        name: "statusFilter",
        type: "options",
        displayOptions: { show: { resource: ["post"], operation: ["list"] } },
        options: [
          { name: "All", value: "" },
          { name: "Pending", value: "pending" },
          { name: "Processing", value: "processing" },
          { name: "Completed", value: "completed" },
          { name: "Failed", value: "failed" },
        ],
        default: "",
      },
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        typeOptions: { minValue: 1, maxValue: 100 },
        default: 20,
        displayOptions: { show: { resource: ["post"], operation: ["list"] } },
      },
      {
        displayName: "Platform Filter",
        name: "platformFilter",
        type: "options",
        options: [
          { name: "All", value: "" },
          { name: "Facebook", value: "facebook" },
          { name: "Instagram", value: "instagram" },
          { name: "TikTok", value: "tiktok" },
          { name: "YouTube", value: "youtube" },
          { name: "LinkedIn", value: "linkedin" },
          { name: "X (Twitter)", value: "twitter" },
          { name: "Pinterest", value: "pinterest" },
          { name: "Threads", value: "threads" },
          { name: "Bluesky", value: "bluesky" },
          { name: "Reddit", value: "reddit" },
        ],
        default: "",
        displayOptions: { show: { resource: ["post"], operation: ["list"] } },
        description: "Filter posts by platform",
      },
      {
        displayName: "Account Filter",
        name: "accountFilter",
        type: "options",
        typeOptions: { loadOptionsMethod: "getAccountsForListFilter", loadOptionsDependsOn: ["platformFilter"] },
        default: "",
        displayOptions: { show: { resource: ["post"], operation: ["list"] } },
        description: "Filter posts by a specific social account",
      },
      {
        displayName: "Date From",
        name: "dateFrom",
        type: "dateTime",
        default: "",
        displayOptions: { show: { resource: ["post"], operation: ["list"] } },
        description: "Filter posts created on or after this date",
      },
      {
        displayName: "Date To",
        name: "dateTo",
        type: "dateTime",
        default: "",
        displayOptions: { show: { resource: ["post"], operation: ["list"] } },
        description: "Filter posts created on or before this date",
      },

      // ═══════════════════════════════════
      // Media → Upload fields
      // ═══════════════════════════════════
      {
        displayName: "Media Source",
        name: "uploadMediaSource",
        type: "options",
        options: [
          { name: "Binary Property (from n8n node)", value: "binary" },
          { name: "URL (download from https://)", value: "url" },
          { name: "Media File ID (UUID lookup, no re-upload)", value: "mediafileid" },
        ],
        default: "binary",
        displayOptions: { show: { resource: ["media"], operation: ["upload"] } },
        description:
          "Where the media should come from. Binary = an n8n binary property (file from a previous node). " +
          "URL = download the file(s) from a public web address. Media File ID = look up files you already " +
          "uploaded to Postora and re-attach them to this item (no re-upload).",
      },
      {
        displayName: "Binary Property",
        name: "uploadBinaryProperty",
        type: "string",
        default: "data",
        displayOptions: { show: { resource: ["media"], operation: ["upload"], uploadMediaSource: ["binary"] } },
        description:
          "Name of the binary property containing the file to upload. For multiple files, use comma-separated names (e.g. 'IMAGE, VIDEO_')",
      },
      {
        displayName: "Media URLs",
        name: "uploadMediaUrls",
        type: "string",
        default: "",
        typeOptions: { multipleValues: false },
        displayOptions: { show: { resource: ["media"], operation: ["upload"], uploadMediaSource: ["url"] } },
        description:
          "🔗 One or more public URLs (http/https only) to download media from. Comma-separated, or use an expression returning an array (e.g. ={{ $json.urls }}).",
      },
      {
        displayName: "Media File ID(s)",
        name: "uploadMediaFileIds",
        type: "string",
        default: "",
        displayOptions: { show: { resource: ["media"], operation: ["upload"], uploadMediaSource: ["mediafileid"] } },
        description:
          "🆔 Postora media file UUID(s) to look up and re-attach. Comma-separated, or use an expression returning an array (e.g. ={{ $json.file_ids }}). " +
          "⚠️ Do NOT paste URLs here — use the 'URL' source instead. Invalid or not-owned IDs are reported as failures but never crash the node.",
      },
    ],
  };

  methods = {
    loadOptions: {
      async getAccounts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials("postoraApi");
        const baseUrl = credentials.baseUrl as string;
        const platform = this.getCurrentNodeParameter("platform") as string;

        let url = `${baseUrl}/api/v1/accounts`;
        if (platform) {
          url += `?platform=${encodeURIComponent(platform)}`;
        }

        const response = await this.helpers.httpRequestWithAuthentication.call(
          this as unknown as IAllExecuteFunctions,
          "postoraApi",
          {
            method: "GET",
            url,
            json: true,
          },
        );

        if (!response?.accounts || !Array.isArray(response.accounts)) {
          return [];
        }

        return response.accounts.map((account: any, index: number) => {
          const displayName = account.name || account.platform_username || "Unknown";
          return {
            name: `${index + 1}. ${displayName}`,
            value: account.id,
          };
        });
      },

      async getAccountsForListFilter(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials("postoraApi");
        const baseUrl = credentials.baseUrl as string;
        const platformFilter = this.getCurrentNodeParameter("platformFilter") as string;

        let url = `${baseUrl}/api/v1/accounts`;
        if (platformFilter) {
          url += `?platform=${encodeURIComponent(platformFilter)}`;
        }

        const response = await this.helpers.httpRequestWithAuthentication.call(
          this as unknown as IAllExecuteFunctions,
          "postoraApi",
          {
            method: "GET",
            url,
            json: true,
          },
        );

        const options: INodePropertyOptions[] = [{ name: "All", value: "" }];

        if (response?.accounts && Array.isArray(response.accounts)) {
          for (const account of response.accounts) {
            const displayName = account.name || account.platform_username || "Unknown";
            options.push({
              name: `${displayName} (${account.platform})`,
              value: account.id,
            });
          }
        }

        return options;
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const resource = this.getNodeParameter("resource", 0) as string;
    const operation = this.getNodeParameter("operation", 0) as string;
    const credentials = await this.getCredentials("postoraApi");
    const baseUrl = credentials.baseUrl as string;

    for (let i = 0; i < items.length; i++) {
      try {
        let responseData: any;

        // ── Account → List ──
        if (resource === "account" && operation === "list") {
          responseData = await this.helpers.httpRequestWithAuthentication.call(
            this as unknown as IAllExecuteFunctions,
            "postoraApi",
            {
              method: "GET",
              url: `${baseUrl}/api/v1/accounts`,
              json: true,
            },
          );
        }

        // ── Post → Create ──
        else if (resource === "post" && operation === "create") {
          const platform = requireParam(
            this.getNodeParameter("platform", i, "") as string,
            "Platform",
          );

          if (["twitter", "tiktok", "reddit"].includes(platform)) {
            throw new Error(
              `The selected platform (${platform}) is coming soon and is not yet available for publishing.`,
            );
          }

          // Caption is hidden for Instagram/Facebook "story" posts (see displayOptions),
          // so it must be read with a fallback — otherwise n8n throws the generic
          // "Could not get parameter" error that masks the real cause.
          const caption = this.getNodeParameter("caption", i, "") as string;
          const socialAccounts = requireParam(
            this.getNodeParameter(`socialAccounts_${platform}`, i, []) as string[],
            `Social Accounts (${platform})`,
          );
          // Normalize mediaSource — handle n8n expression mode returning raw strings
          let mediaSource = this.getNodeParameter("mediaSource", i, "none") as string;
          const rawMediaSource = mediaSource; // Keep original before normalization
          mediaSource = mediaSource?.toLowerCase?.().trim() || "none";

          // Smart detection: if expression mode returned an actual URL instead of "url"/"binary"/"none",
          // treat it as a direct media URL
          let expressionModeUrls: string[] = [];
          if (!["url", "binary", "none", "mediafileid"].includes(mediaSource)) {
            const possibleUrls = rawMediaSource.split(",").map(s => s.trim()).filter(s => {
              try { new URL(s); return true; } catch { return false; }
            });
            if (possibleUrls.length > 0) {
              mediaSource = "url";
              expressionModeUrls = possibleUrls;
            } else {
              mediaSource = "none";
            }
          }

          const mediaUrls =
            expressionModeUrls.length > 0
              ? expressionModeUrls
              : mediaSource === "url"
                ? (this.getNodeParameter("mediaUrls", i, "") as string)
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => {
                      if (!s) return false;
                      try { new URL(s); return true; } catch { return false; }
                    })
                : [];

          if (mediaSource === "url" && mediaUrls.length === 0) {
            throw new Error(
              "Media source is set to URL but no valid URLs were provided. " +
              "Ensure URLs are direct links to media files (e.g. https://example.com/image.jpg). " +
              "If the Media Source field shows as a text input instead of a dropdown, click the gear icon and select 'Fixed'."
            );
          }

          const mediaFileIds =
            mediaSource === "mediafileid"
              ? parseCommaSeparatedList(this.getNodeParameter("mediaFileIds", i, "") as string)
              : [];

          if (mediaSource === "mediafileid" && mediaFileIds.length === 0) {
            throw new Error(
              "Media source is set to Media File ID but no IDs were provided. " +
              "Enter one or more IDs returned by a previous Media → Upload step, comma-separated (e.g. id-1,id-2,id-3)."
            );
          }

          if (mediaSource === "mediafileid" && mediaFileIds.length > 0) {
            const invalid = mediaFileIds.filter((id) => !isValidUuid(id));
            if (invalid.length > 0) {
              const sample = invalid[0];
              const isUrl = /^https?:\/\//i.test(sample);
              throw new Error(
                `Invalid Media File ID: "${String(sample).slice(0, 80)}" is not a valid UUID.` +
                (isUrl
                  ? " It looks like a URL — switch Media Source to \"URL\", or use the Media → Upload node first and reference the returned 'id' (a UUID like 7ee95777-...) instead of 'file_path' (the Cloudinary URL)."
                  : " Media File IDs are UUIDs returned by the Media → Upload node (e.g. 7ee95777-b5fa-41a3-b314-5d67a027e569)."),
              );
            }
          }
          const scheduledAt = this.getNodeParameter("scheduledAt", i, "") as string;
          const additionalOptions = this.getNodeParameter("additionalOptions", i, {}) as Record<string, any>;

          const body: Record<string, any> = {
            caption,
            platforms: [platform],
          };

          if (socialAccounts.length) body.account_ids = socialAccounts;
          if (mediaUrls.length) body.media_urls = mediaUrls;
          if (mediaFileIds.length) body.media_file_ids = mediaFileIds;

          // Binary data → base64 (supports multiple comma-separated property names)
          if (mediaSource === "binary") {
            const binaryProp = this.getNodeParameter("mediaBinaryProperty", i, "data") as string;
            const binaryProps = binaryProp
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
            const base64Files: string[] = [];
            for (const prop of binaryProps) {
              const { binaryData: bd, buffer: buf } = await readBinaryOrThrow(this, i, prop);
              base64Files.push(`data:${bd.mimeType};base64,${buf.toString("base64")}`);
            }
            body.media_base64 = base64Files;
          }

          if (scheduledAt) body.scheduled_at = scheduledAt;

          // Post type (Facebook & Instagram only)
          if (platform === "facebook" || platform === "instagram") {
            const postType = this.getNodeParameter("postType", i, "feed") as string;
            if (platform === "facebook") {
              body.facebook_post_type = postType;
            } else {
              body.instagram_post_type = postType;
              if (postType === "story") {
                body.instagram_media_type = "stories";
              }
            }
          }

          // Platform-specific metadata
          if (platform === "youtube") {
            body.youtube_visibility = additionalOptions.youtubeVisibility || "public";
          }
          if (additionalOptions.youtubeTitle) body.youtube_title = additionalOptions.youtubeTitle;
          if (additionalOptions.youtubeCategory) body.youtube_category = additionalOptions.youtubeCategory;
          if (additionalOptions.tiktokPrivacy) body.tiktok_privacy = additionalOptions.tiktokPrivacy;
          if (additionalOptions.tiktokAllowComments !== undefined)
            body.tiktok_allow_comments = additionalOptions.tiktokAllowComments;
          if (additionalOptions.tiktokAllowDuet !== undefined)
            body.tiktok_allow_duet = additionalOptions.tiktokAllowDuet;
          if (additionalOptions.tiktokAllowStitch !== undefined)
            body.tiktok_allow_stitch = additionalOptions.tiktokAllowStitch;
          if (additionalOptions.pinterestBoardId) body.pinterest_board_id = additionalOptions.pinterestBoardId;
          if (additionalOptions.pinterestTitle) body.pinterest_title = additionalOptions.pinterestTitle;
          if (additionalOptions.redditSubreddit) body.reddit_subreddit = additionalOptions.redditSubreddit;
          if (additionalOptions.redditTitle) body.reddit_title = additionalOptions.redditTitle;
          if (additionalOptions.firstComment) body.first_comment = additionalOptions.firstComment;

          responseData = await this.helpers.httpRequestWithAuthentication.call(
            this as unknown as IAllExecuteFunctions,
            "postoraApi",
            {
              method: "POST",
              url: `${baseUrl}/api/v1/post`,
              headers: {
                "Content-Type": "application/json",
              },
              body,
              json: true,
            },
          );
        }

        // ── Post → Get Status ──
        else if (resource === "post" && operation === "getStatus") {
          const postId = this.getNodeParameter("postId", i) as string;
          responseData = await this.helpers.httpRequestWithAuthentication.call(
            this as unknown as IAllExecuteFunctions,
            "postoraApi",
            {
              method: "GET",
              url: `${baseUrl}/api/v1/post/${postId}`,
              json: true,
            },
          );
        }

        // ── Post → List ──
        else if (resource === "post" && operation === "list") {
          const statusFilter = this.getNodeParameter("statusFilter", i, "") as string;
          const limit = this.getNodeParameter("limit", i, 20) as number;
          const platformFilter = this.getNodeParameter("platformFilter", i, "") as string;
          const accountFilter = this.getNodeParameter("accountFilter", i, "") as string;
          const dateFrom = this.getNodeParameter("dateFrom", i, "") as string;
          const dateTo = this.getNodeParameter("dateTo", i, "") as string;

          let url = `${baseUrl}/api/v1/posts?limit=${limit}`;
          if (statusFilter) url += `&status=${statusFilter}`;
          if (platformFilter) url += `&platform=${encodeURIComponent(platformFilter)}`;
          if (accountFilter) url += `&account_id=${encodeURIComponent(accountFilter)}`;
          if (dateFrom) url += `&date_from=${encodeURIComponent(dateFrom)}`;
          if (dateTo) url += `&date_to=${encodeURIComponent(dateTo)}`;

          responseData = await this.helpers.httpRequestWithAuthentication.call(
            this as unknown as IAllExecuteFunctions,
            "postoraApi",
            {
              method: "GET",
              url,
              json: true,
            },
          );
        }

        // ── Media → Upload ──
        else if (resource === "media" && operation === "upload") {
          // Backward-compat: workflows saved before v1.1.7 set `binaryPropertyName`
          // and have no `uploadMediaSource`. Detect that and fall back to binary mode.
          const legacyBinary = this.getNodeParameter("binaryPropertyName", i, "") as string;
          let uploadSource = (this.getNodeParameter("uploadMediaSource", i, "") as string).toLowerCase().trim();
          if (!uploadSource) {
            uploadSource = "binary";
          }

          const uploadResults: any[] = [];
          const uploadErrors: any[] = [];

          // ── Binary source ──
          if (uploadSource === "binary") {
            const binaryPropRaw =
              (this.getNodeParameter("uploadBinaryProperty", i, "") as string) ||
              legacyBinary ||
              "data";
            const propertyNames = binaryPropRaw
              .split(",")
              .map((name: string) => name.trim())
              .filter((name: string) => name.length > 0);

            for (const prop of propertyNames) {
              try {
                const { binaryData, buffer } = await readBinaryOrThrow(this, i, prop);

                const boundary = "----n8nFormBoundary" + Math.random().toString(36).substring(2);
                const fileName = binaryData.fileName || "upload";
                const mimeType = binaryData.mimeType || "application/octet-stream";

                const header = Buffer.from(
                  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
                );
                const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
                const multipartBody = Buffer.concat([header, buffer, footer]);

                let result = await this.helpers.httpRequestWithAuthentication.call(
                  this as unknown as IAllExecuteFunctions,
                  "postoraApi",
                  {
                    method: "POST",
                    url: `${baseUrl}/api/v1/upload-media`,
                    headers: {
                      "Content-Type": `multipart/form-data; boundary=${boundary}`,
                    },
                    body: multipartBody,
                  },
                );

                if (typeof result === "string") {
                  try { result = JSON.parse(result); } catch (_) { /* keep as-is */ }
                }

                uploadResults.push({ field: prop, success: true, ...(result as object) });
              } catch (err: any) {
                uploadErrors.push({ field: prop, success: false, error: err.message });
              }
            }
          }

          // ── URL source (SSRF-safe download, then upload as binary) ──
          else if (uploadSource === "url") {
            const urls = normalizeList(
              this.getNodeParameter("uploadMediaUrls", i, "") as string | string[],
            );
            if (urls.length === 0) {
              throw new Error(
                "Media Source is set to URL but no URLs were provided. Enter one or more public http(s) URLs (comma-separated or an array expression).",
              );
            }

            for (const url of urls) {
              try {
                const fetched = await safeFetchAndStage(url);

                const boundary = "----n8nFormBoundary" + Math.random().toString(36).substring(2);
                const header = Buffer.from(
                  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fetched.fileName}"\r\nContent-Type: ${fetched.mimeType}\r\n\r\n`,
                );
                const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
                const multipartBody = Buffer.concat([header, fetched.buffer, footer]);

                let result = await this.helpers.httpRequestWithAuthentication.call(
                  this as unknown as IAllExecuteFunctions,
                  "postoraApi",
                  {
                    method: "POST",
                    url: `${baseUrl}/api/v1/upload-media`,
                    headers: {
                      "Content-Type": `multipart/form-data; boundary=${boundary}`,
                    },
                    body: multipartBody,
                  },
                );

                if (typeof result === "string") {
                  try { result = JSON.parse(result); } catch (_) { /* keep as-is */ }
                }

                uploadResults.push({ url, success: true, ...(result as object) });
              } catch (err: any) {
                uploadErrors.push({ url, success: false, error: err.message });
              }
            }
          }

          // ── Media File ID source (look up & re-attach, never re-upload) ──
          else if (uploadSource === "mediafileid") {
            const rawIds = normalizeList(
              this.getNodeParameter("uploadMediaFileIds", i, "") as string | string[],
            );
            if (rawIds.length === 0) {
              throw new Error(
                "Media Source is set to Media File ID but no IDs were provided. Enter one or more Postora media file UUIDs (comma-separated or an array expression).",
              );
            }

            // Trim → drop empties → dedupe (case-insensitive)
            const seen = new Set<string>();
            const fileIds: string[] = [];
            for (const id of rawIds) {
              const lower = id.toLowerCase();
              if (seen.has(lower)) continue;
              seen.add(lower);
              fileIds.push(id.trim());
            }

            for (const id of fileIds) {
              if (!isValidUuid(id)) {
                uploadErrors.push({
                  file_id: id,
                  success: false,
                  error: `'${id}' is not a valid UUID. Media File IDs must be UUIDs returned by a previous Media → Upload step.`,
                });
                continue;
              }
              try {
                let result = await this.helpers.httpRequestWithAuthentication.call(
                  this as unknown as IAllExecuteFunctions,
                  "postoraApi",
                  {
                    method: "GET",
                    url: `${baseUrl}/api/v1/media/${id}`,
                    json: true,
                  },
                );

                // The backend returns { success: true, media: {...} }.
                const media = (result && (result as any).media) || null;
                uploadResults.push({
                  file_id: id,
                  success: true,
                  attached: true,
                  resolved: true,
                  media,
                });
              } catch (err: any) {
                const msg = err?.message || String(err);
                // 401 → fail the whole node (auth is broken everywhere)
                if (/401|unauthor/i.test(msg)) {
                  throw err;
                }
                // 404 (missing or not owned) → per-item failure, never crash
                uploadErrors.push({
                  file_id: id,
                  success: false,
                  error: "Not found or not owned by the authenticated user.",
                });
              }
            }
          } else {
            throw new Error(
              `Unknown Media Source '${uploadSource}'. Choose Binary, URL, or Media File ID.`,
            );
          }

          const total = uploadResults.length + uploadErrors.length;
          responseData = {
            total,
            uploaded: uploadResults.length,
            failed: uploadErrors.length,
            results: [...uploadResults, ...uploadErrors],
          };
        }

        if (Array.isArray(responseData)) {
          returnData.push(...responseData.map((item: any) => ({ json: item, pairedItem: { item: i } })));
        } else {
          returnData.push({ json: responseData ?? {}, pairedItem: { item: i } });
        }
      } catch (error: any) {
        if (this.continueOnFail()) {
          returnData.push({
            json: { error: error.message },
            pairedItem: { item: i },
          });
          continue;
        }
        throw new NodeApiError(this.getNode(), error as JsonObject);
      }
    }

    return [returnData];
  }
}
