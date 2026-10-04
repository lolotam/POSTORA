import { CodeBlock } from "@/components/docs";
import { Terminal } from "lucide-react";
import { Icon3D, GradientHeading, GradientRingCard, Reveal } from "@/components/fx";

const API_BASE = "https://api.postora.cloud/functions/v1/n8n-api";

const uploadExample = `curl -X POST \\
  "${API_BASE}/api/v1/upload-media" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -F "file=@/path/to/video.mp4"

# Response:
# {
#   "success": true,
#   "media_file": {
#     "id": "abc123-uuid-here",
#     "public_url": "https://...supabase.co/storage/v1/object/public/media/..."
#   }
# }`;

const postExample = `curl -X POST \\
  "${API_BASE}/api/v1/post" \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "caption": "Exciting news! 🎉 Check out our latest video #viral #trending",
    "platforms": ["instagram", "facebook", "tiktok", "youtube", "pinterest"],
    "account_ids": ["your-account-uuid-1", "your-account-uuid-2"],
    "media_file_ids": ["abc123-uuid-here"],
    
    "youtube_privacy": "public",
    "youtube_title": "Our Latest Video",
    "youtube_description": "Full description with links and info",
    "youtube_tags": ["tutorial", "howto", "tips"],
    
    "tiktok_post_mode": "DIRECT_POST",
    "tiktok_allow_comments": true,
    
    "instagram_share_to_feed": true,
    
    "pinterest_board_id": "your-board-id",
    "pinterest_title": "Check This Out"
  }'

# ⚠️ Field name must be "account_ids" or "ACCOUNT_IDS" only.
# Any other variant (account_id, id, etc.) returns 400 error.
# Always send large numeric IDs as strings to avoid precision loss.`;

export function CompleteExampleSection() {
  return (
    <section className="container mx-auto px-6 py-20 border-t border-border/40">
      <Reveal className="text-center mb-12">
        <div className="flex flex-col items-center gap-4">
          <Icon3D icon={Terminal} variant="emerald" size="md" />
          <GradientHeading as="h2" preset="emerald-cyan-sky" size="lg">Complete Example</GradientHeading>
          <p className="text-muted-foreground max-w-2xl">
            Full workflow with media upload and multi-platform posting.
          </p>
        </div>
      </Reveal>

      <div className="max-w-4xl mx-auto space-y-6">
        <Reveal>
          <GradientRingCard variant="emerald" ringIntensity="subtle" hoverLift={false}>
            <h3 className="font-semibold mb-4 flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl text-white flex items-center justify-center text-sm font-bold shadow-md bg-emerald-400">1</span>
              Upload Media (cURL)
            </h3>
            <CodeBlock id="example-upload" language="bash" code={uploadExample} />
          </GradientRingCard>
        </Reveal>

        <Reveal delay={120}>
          <GradientRingCard variant="emerald" ringIntensity="subtle" hoverLift={false}>
            <h3 className="font-semibold mb-4 flex items-center gap-3">
              <span className="w-9 h-9 rounded-xl text-white flex items-center justify-center text-sm font-bold shadow-md bg-emerald-400">2</span>
              Create Post (cURL)
            </h3>
            <CodeBlock id="example-post" language="bash" code={postExample} />
          </GradientRingCard>
        </Reveal>
      </div>
    </section>
  );
}
