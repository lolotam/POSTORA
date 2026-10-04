import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PlatformIcon, getPlatformName, ExtendedPlatform } from "@/components/PlatformIcon";
import { useAuth } from "@/hooks/useAuth";
import { BookOpen, ArrowLeft } from "lucide-react";

const platforms: ExtendedPlatform[] = ["facebook", "instagram", "linkedin", "tiktok", "pinterest", "twitter", "youtube"];

interface CharacterLimit {
  property: string;
  description: string;
}

const platformLimits: Record<string, CharacterLimit[]> = {
  facebook: [
    { property: "post", description: "63,206 characters maximum" },
    { property: "title", description: "Reels title – 255 characters maximum" },
  ],
  instagram: [
    { property: "post", description: "2,200 characters maximum" },
    { property: "altText", description: "1,000 characters maximum per image" },
    { property: "comment", description: "2,196 characters maximum" },
  ],
  linkedin: [
    { property: "post", description: "3,000 characters maximum" },
    { property: "title", description: "400 characters maximum" },
    { property: "comment", description: "1,250 characters maximum" },
  ],
  tiktok: [
    { property: "post", description: "2,200 characters maximum" },
  ],
  pinterest: [
    { property: "post", description: "500 characters maximum" },
    { property: "title", description: "100 characters maximum" },
    { property: "link", description: "2,048 characters maximum" },
    { property: "altText", description: "500 characters maximum" },
  ],
  twitter: [
    { property: "post", description: "280 characters maximum" },
    { property: "post (Premium)", description: "25,000 characters maximum for Premium and Premium Plus accounts" },
    { property: "altText", description: "1,000 characters maximum per image" },
    { property: "subTitleName", description: "150 characters maximum" },
  ],
  youtube: [
    { property: "post", description: "5,000 characters maximum" },
    { property: "title", description: "100 characters maximum" },
    { property: "tags", description: "500 characters total, 2+ characters each" },
    { property: "subTitleName", description: "150 characters maximum" },
  ],
};

const bannedHashtags = {
  A: ["anorexia", "alone", "a$$", "antivax", "abdl", "addmysc", "adulting", "always", "armparty", "asiagirl"],
  B: ["beautyblogger", "bikinibody", "boho", "blogladrona", "brain", "besties", "bikinibod"],
  C: ["costumes", "curvygirls", "cancer"],
  D: ["date", "dating", "desk", "dm"],
  E: ["elevator", "edm", "endme"],
  F: ["followtrain", "followtrains"],
  G: ["graffitiigers", "girlsonly", "gloves"],
  H: ["hardworkpaysoff", "happythanksgiving", "humpday", "hustler", "hotgirls"],
  I: ["iphonegraphy", "italiano", "ifb"],
  K: ["kansas", "killingit", "kissing", "kill", "killme", "killyourself", "kys"],
  M: ["master", "models", "mustfollow", "milf", "midget"],
  N: ["nasty", "newyearsday"],
  P: ["petite", "petitegirls", "pushups", "payme"],
  S: ["saltwater", "shit", "shower", "single", "singlelife", "skype", "snap", "snapchat", "snapchatme", "snowstorm", "sopretty", "stranger", "streetphoto", "sunbathing", "swole", "suicide", "suicideawareness"],
  T: ["tag4like", "tanlines", "teens", "teen", "thought", "todayimwearing"],
  U: ["undies", "unbalanced"],
  V: ["valentinesday"],
  W: ["workflow"],
  Y: ["youngmodel", "yolo"],
};

export default function CharacterLimits() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-border bg-background">
        <div className="container mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/"><Logo /></Link>
          <div className="flex items-center gap-4">
            {user ? (
              <Link to="/dashboard"><Button variant="gradient">Go to Dashboard</Button></Link>
            ) : (
              <>
                <Link to="/auth"><Button variant="ghost">Sign In</Button></Link>
                <Link to="/auth?mode=signup"><Button variant="gradient">Get Started</Button></Link>
              </>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-border bg-accent">
        <div className="container mx-auto px-6 py-12">
          <Link to="/docs" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6">
            <ArrowLeft className="w-4 h-4" />
            Back to Documentation
          </Link>
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-border bg-secondary/50 mb-6">
            <BookOpen className="w-4 h-4 text-primary" />
            <span className="text-sm">Documentation</span>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold mb-4">Character Limits</h1>
          <p className="text-xl text-muted-foreground max-w-2xl">
            This guide summarizes the most relevant text limits for each social network supported by Postora. Keep these constraints in mind when building payloads so posts are accepted without truncation.
          </p>
        </div>
      </section>

      {/* Main Content */}
      <div className="container mx-auto px-6 py-12">
        <div className="max-w-4xl mx-auto space-y-12">
          {/* Platform-Specific Character Limits */}
          <section>
            <h2 className="text-2xl font-bold mb-6">Platform-Specific Character Limits</h2>
            
            <div className="space-y-8">
              {platforms.map((platform) => (
                <Card key={platform} className="p-6 bg-card/50">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center">
                      <PlatformIcon platform={platform} size="md" />
                    </div>
                    <h3 className="text-lg font-semibold">{getPlatformName(platform)} Character Limits</h3>
                  </div>
                  
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm border border-border rounded-lg overflow-hidden">
                      <thead className="bg-secondary/50">
                        <tr>
                          <th className="text-start py-3 px-4 font-medium">Property</th>
                          <th className="text-start py-3 px-4 font-medium">Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        {platformLimits[platform]?.map((limit, i) => (
                          <tr key={i} className="border-t border-border">
                            <td className="py-3 px-4 font-mono text-primary text-xs">{limit.property}</td>
                            <td className="py-3 px-4 text-muted-foreground">{limit.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              ))}
            </div>
          </section>

          {/* Content Restrictions */}
          <section>
            <h2 className="text-2xl font-bold mb-6">Content Restrictions</h2>
            
            <Card className="p-6 bg-card/50">
              <h3 className="text-lg font-semibold mb-4">Banned Hashtags</h3>
              <p className="text-muted-foreground mb-4">
                Postora validates content against a list of prohibited hashtags before posting to Instagram. Posts containing any of these hashtags will be rejected with a validation error. The complete list of banned hashtags includes:
              </p>
              
              <div className="space-y-3">
                {Object.entries(bannedHashtags).map(([letter, tags]) => (
                  <div key={letter} className="flex gap-2">
                    <span className="font-bold text-primary w-6">{letter}:</span>
                    <span className="text-sm text-muted-foreground">{tags.join(", ")}</span>
                  </div>
                ))}
              </div>
              
              <p className="text-sm text-muted-foreground mt-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
                If your content includes any of these hashtags, remove them before submitting your request to avoid validation errors.
              </p>
            </Card>
          </section>

          {/* API Considerations */}
          <section>
            <h2 className="text-2xl font-bold mb-6">API Considerations</h2>
            
            <Card className="p-6 bg-card/50">
              <ul className="space-y-3 text-muted-foreground list-disc list-inside">
                <li>Postora validates payload sizes before sending them to social networks whenever limits are known. Requests that exceed the documented limits return a validation error.</li>
                <li>Some platforms might truncate overlong text instead of rejecting it (Meta products and YouTube occasionally do this). Inspect the per-platform response inside <code className="px-1.5 py-0.5 rounded bg-secondary text-sm">results</code> to confirm the final content.</li>
                <li>For channels with strict limits such as X, consider shortening URLs in your application prior to calling the Postora API.</li>
              </ul>
            </Card>
          </section>

          {/* Updates and Changes */}
          <section>
            <h2 className="text-2xl font-bold mb-6">Updates and Changes</h2>
            
            <Card className="p-6 bg-card/50">
              <p className="text-muted-foreground mb-4">
                Social networks regularly adjust their limits. We keep this page aligned with the latest behavior we observe in production, but you should also:
              </p>
              <ul className="space-y-2 text-muted-foreground list-disc list-inside">
                <li>Check Postora API responses for detailed error messages about rejected posts.</li>
                <li>Subscribe to our release notes for platform updates.</li>
                <li>Revisit this reference periodically, especially before large content campaigns.</li>
              </ul>
            </Card>
          </section>

          {/* Back to Docs Link */}
          <div className="pt-8 border-t">
            <Link to="/docs">
              <Button variant="outline" className="gap-2">
                <ArrowLeft className="w-4 h-4" />
                Back to Documentation
              </Button>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}