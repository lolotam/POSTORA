import { Logo } from "@/components/Logo";

export function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-6">
        {/* Logo with pulsing glow */}
        <div className="relative animate-scale-in">
          {/* Pulsing glow behind logo */}
          {/* Actual Logo component */}
          <div className="relative">
            <Logo size="lg" showText={true} animate={false} />
          </div>
        </div>

        {/* Loading dots animation */}
        <div className="flex items-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="w-2 h-2 rounded-full bg-primary animate-bounce-dot"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </div>

        {/* Loading text with fade */}
        <p className="text-sm text-muted-foreground animate-pulse">
          Loading...
        </p>
      </div>
    </div>
  );
}
