import {
  IAllExecuteFunctions,
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
        options: [
          { name: "None", value: "none" },
          { name: "URL", value: "url" },
          { name: "Binary Data", value: "binary" },
        ],
        default: "none",
        displayOptions: { show: { resource: ["post"], operation: ["create"] } },
        description: "How to attach media to the post",
      },
      {
        displayName: "Media URLs",
        name: "mediaUrls",
        type: "string",
        default: "",
        displayOptions: { show: { resource: ["post"], operation: ["create"], mediaSource: ["url"] } },
        description:
          "Comma-separated media URLs (images or videos). The API will download and attach them to the post.",
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
        displayName: "Binary Property",
        name: "binaryPropertyName",
        type: "string",
        default: "data",
        required: true,
        displayOptions: { show: { resource: ["media"], operation: ["upload"] } },
        description: "Name of the binary property containing the file to upload. For multiple files, use comma-separated names (e.g. 'IMAGE, VIDEO_')",
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
          const platform = this.getNodeParameter("platform", i) as string;

          if (["twitter", "tiktok", "reddit"].includes(platform)) {
            throw new Error(
              `The selected platform (${platform}) is coming soon and is not yet available for publishing.`,
            );
          }

          const caption = this.getNodeParameter("caption", i) as string;
          const socialAccounts = this.getNodeParameter(`socialAccounts_${platform}`, i) as string[];
          // Normalize mediaSource — handle n8n expression mode returning raw strings
          let mediaSource = this.getNodeParameter("mediaSource", i, "none") as string;
          const rawMediaSource = mediaSource; // Keep original before normalization
          mediaSource = mediaSource?.toLowerCase?.().trim() || "none";

          // Smart detection: if expression mode returned an actual URL instead of "url"/"binary"/"none",
          // treat it as a direct media URL
          let expressionModeUrls: string[] = [];
          if (!["url", "binary", "none"].includes(mediaSource)) {
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
          const scheduledAt = this.getNodeParameter("scheduledAt", i, "") as string;
          const additionalOptions = this.getNodeParameter("additionalOptions", i, {}) as Record<string, any>;

          const body: Record<string, any> = {
            caption,
            platforms: [platform],
          };

          if (socialAccounts.length) body.account_ids = socialAccounts;
          if (mediaUrls.length) body.media_urls = mediaUrls;

          // Binary data → base64 (supports multiple comma-separated property names)
          if (mediaSource === "binary") {
            const binaryProp = this.getNodeParameter("mediaBinaryProperty", i, "data") as string;
            const binaryProps = binaryProp
              .split(",")
              .map((p) => p.trim())
              .filter(Boolean);
            const base64Files: string[] = [];
            for (const prop of binaryProps) {
              const bd = this.helpers.assertBinaryData(i, prop);
              const buf = await this.helpers.getBinaryDataBuffer(i, prop);
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
          const binaryPropertyName = this.getNodeParameter("binaryPropertyName", i) as string;
          const propertyNames = binaryPropertyName.split(',').map((name: string) => name.trim()).filter((name: string) => name.length > 0);

          const uploadResults: any[] = [];
          const uploadErrors: any[] = [];

          for (const prop of propertyNames) {
            try {
              const binaryData = this.helpers.assertBinaryData(i, prop);
              const buffer = await this.helpers.getBinaryDataBuffer(i, prop);

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

          responseData = {
            total: propertyNames.length,
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
