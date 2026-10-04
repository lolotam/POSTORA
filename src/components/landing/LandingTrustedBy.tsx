import { motion } from "framer-motion";

const trustedCompanies = [
  "TechFlow", "StartupHub", "CreativeStudio", "Digital Pulse", "BrandCraft",
  "SocialFirst", "InnovateTech", "MediaWave", "GrowthLab", "ContentPro",
  "MarketingHub", "ViralReach", "EngageMax", "SocialSphere", "BuzzFactory"
];

export default function LandingTrustedBy() {
  const firstHalf = trustedCompanies.slice(0, Math.ceil(trustedCompanies.length / 2));
  const secondHalf = trustedCompanies.slice(Math.ceil(trustedCompanies.length / 2));
  const row1 = [...firstHalf, ...firstHalf, ...firstHalf];
  const row2 = [...secondHalf, ...secondHalf, ...secondHalf];

  return (
    <section className="relative z-10 pb-20 overflow-hidden">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5 }}
        className="text-center mb-10 container mx-auto px-6"
      >
        <p className="text-sm text-muted-foreground uppercase tracking-widest mb-2">Trusted By</p>
        <h2 className="text-2xl md:text-3xl font-bold">Leading Companies Worldwide</h2>
      </motion.div>

      <div className="relative space-y-6">
        <div className="absolute start-0 top-0 bottom-0 w-32 bg-gradient-to-r from-background to-transparent z-10 pointer-events-none" />
        <div className="absolute end-0 top-0 bottom-0 w-32 bg-gradient-to-l from-background to-transparent z-10 pointer-events-none" />

        {/* Row 1 - CSS scroll */}
        <div className="overflow-hidden">
          <div className="flex gap-16 py-4 animate-scroll-left w-max">
            {row1.map((company, index) => (
              <div
                key={`row1-${company}-${index}`}
                className="flex-shrink-0 flex items-center justify-center w-48 h-20"
              >
                <div className="w-full h-full px-6 py-3 rounded-xl bg-card border border-border/50 hover:bg-card hover:border-primary/20 transition-all duration-300 flex items-center justify-center relative group/logo">
                  <img
                    src={`/brands/${company.toLowerCase().replace(/[^a-z0-9]/g, '')}.png`}
                    alt={`${company} logo`}
                    width={120}
                    height={40}
                    loading="lazy"
                    decoding="async"
                    className="max-w-full max-h-full object-contain transition-transform duration-300 group-hover/logo:scale-110"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                      if (e.currentTarget.parentElement) {
                        e.currentTarget.parentElement.innerText = company;
                      }
                    }}
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-background opacity-0 group-hover/logo:opacity-100 transition-opacity duration-300 rounded-xl">
                    <span className="font-bold text-sm text-foreground">{company}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Row 2 - CSS scroll opposite */}
        <div className="overflow-hidden">
          <div className="flex gap-16 py-4 animate-scroll-right w-max">
            {row2.map((company, index) => (
              <div
                key={`row2-${company}-${index}`}
                className="flex-shrink-0 flex items-center justify-center w-48 h-20"
              >
                <div className="w-full h-full px-6 py-3 rounded-xl bg-card border border-border/50 hover:bg-card hover:border-primary/20 transition-all duration-300 flex items-center justify-center relative group/logo">
                  <img
                    src={`/brands/${company.toLowerCase().replace(/[^a-z0-9]/g, '')}.png`}
                    alt={`${company} logo`}
                    width={120}
                    height={40}
                    loading="lazy"
                    decoding="async"
                    className="max-w-full max-h-full object-contain transition-transform duration-300 group-hover/logo:scale-110"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                      if (e.currentTarget.parentElement) {
                        e.currentTarget.parentElement.innerText = company;
                      }
                    }}
                  />
                  <div className="absolute inset-0 flex items-center justify-center bg-background opacity-0 group-hover/logo:opacity-100 transition-opacity duration-300 rounded-xl">
                    <span className="font-bold text-sm text-foreground">{company}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
