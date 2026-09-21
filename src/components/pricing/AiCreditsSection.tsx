import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sparkles, Hash, ImagePlus, Zap } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";

const creditPacks = [
  { credits: 50, price: 4.99, popular: false, perCredit: 0.10 },
  { credits: 150, price: 12.99, popular: true, perCredit: 0.087, savings: 13 },
  { credits: 350, price: 24.99, popular: false, perCredit: 0.071, savings: 29 },
  { credits: 1000, price: 59.99, popular: false, perCredit: 0.060, savings: 40 },
];

const creditUses = [
  { icon: Sparkles, label: "AI Captions", cost: "1 credit each" },
  { icon: Hash, label: "AI Hashtags", cost: "1 credit each" },
  { icon: ImagePlus, label: "AI Images", cost: "5 credits each" },
  { icon: Zap, label: "Best Times", cost: "1 credit each" },
];

export function AiCreditsSection() {
  const { user } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="space-y-8">
      <div className="text-center space-y-4">
        <Badge variant="secondary" className="mb-4">
          <Sparkles className="w-3 h-3 me-1" />
          AI Credits
        </Badge>
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight">Power Up Your Content</h2>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Need more AI power? Purchase additional credits to generate captions, hashtags, and images beyond your plan limits.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {creditPacks.map((pack) => (
          <div
            key={pack.credits}
            className={`relative rounded-xl border p-5 flex flex-col ${
              pack.popular
                ? "border-primary bg-primary/5 shadow-lg shadow-primary/10"
                : "border-border bg-card hover:border-primary/50 transition-colors"
            }`}
          >
            {pack.popular && (
              <Badge className="absolute -top-2.5 start-1/2 -translate-x-1/2 bg-primary text-primary-foreground text-xs">
                Best Value
              </Badge>
            )}
            <div className="flex items-center justify-center gap-2 mb-3">
              <Sparkles className={`w-5 h-5 ${pack.popular ? "text-primary" : "text-muted-foreground"}`} />
              <span className="text-3xl font-bold">{pack.credits}</span>
              <span className="text-muted-foreground">credits</span>
            </div>
            <div className="text-center mb-4">
              <div className="text-2xl font-bold">${pack.price}</div>
              <div className="text-xs text-muted-foreground">${pack.perCredit.toFixed(3)} per credit</div>
              {pack.savings && (
                <Badge variant="secondary" className="mt-2 bg-green-500/10 text-green-600 border-green-500/30">
                  Save {pack.savings}%
                </Badge>
              )}
            </div>
            <Button
              variant={pack.popular ? "default" : "outline"}
              className="w-full mt-auto"
              onClick={() => { if (!user) { navigate("/auth"); return; } navigate("/credits"); }}
            >
              Buy Credits
            </Button>
          </div>
        ))}
      </div>

      <div className="bg-muted/30 rounded-xl p-6 border">
        <h3 className="font-semibold mb-4 text-center">What You Can Do With AI Credits</h3>
        <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
          {creditUses.map((item) => (
            <div key={item.label} className="flex items-center gap-3 p-3 bg-background rounded-lg border">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                <item.icon className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="font-medium text-sm">{item.label}</p>
                <p className="text-xs text-muted-foreground">{item.cost}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
