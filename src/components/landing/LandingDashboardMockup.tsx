import { motion } from "framer-motion";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { Shield } from "lucide-react";

export default function LandingDashboardMockup() {
  return (
    <section className="relative z-10 container mx-auto px-6 pb-32">
      <motion.div
        initial={{ opacity: 0, y: 40 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.8 }}
        className="relative max-w-6xl mx-auto"
      >
        <div className="rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-muted/50">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-red-500/80" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <div className="w-3 h-3 rounded-full bg-green-500/80" />
            </div>
            <div className="flex-1 flex justify-center">
              <div className="px-4 py-1 rounded-lg bg-background/50 text-xs text-muted-foreground flex items-center gap-2">
                <Shield className="w-3 h-3" />
                postora.cloud/dashboard
              </div>
            </div>
          </div>

          <div className="p-6 bg-background">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
              {[
                { label: "Total Posts", value: "1,234", change: "+12%" },
                { label: "Engagement", value: "45.2K", change: "+8%" },
                { label: "Followers", value: "12.8K", change: "+24%" },
                { label: "Reach", value: "89.5K", change: "+15%" },
              ].map((stat, i) => (
                <motion.div
                  key={stat.label}
                  initial={{ opacity: 0, scale: 0.9 }}
                  whileInView={{ opacity: 1, scale: 1 }}
                  viewport={{ once: true }}
                  transition={{ delay: 0.2 + i * 0.1 }}
                  className="p-4 rounded-xl bg-card border border-border"
                >
                  <p className="text-xs text-muted-foreground mb-1">{stat.label}</p>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold">{stat.value}</span>
                    <span className="text-xs text-green-500">{stat.change}</span>
                  </div>
                </motion.div>
              ))}
            </div>

            <div className="grid md:grid-cols-3 gap-4">
              <motion.div
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ delay: 0.4 }}
                className="md:col-span-2 p-4 rounded-xl bg-card border border-border h-48"
              >
                <p className="text-sm font-medium mb-4">Engagement Overview</p>
                <div className="flex items-end gap-2 h-28">
                  {[40, 65, 45, 80, 55, 90, 70, 85, 60, 95, 75, 88].map((height, i) => (
                    <motion.div
                      key={i}
                      initial={{ height: 0 }}
                      whileInView={{ height: `${height}%` }}
                      viewport={{ once: true }}
                      transition={{ delay: 0.5 + i * 0.05, duration: 0.5 }}
                      className="flex-1 rounded-t-sm bg-primary"
                    />
                  ))}
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ delay: 0.5 }}
                className="p-4 rounded-xl bg-card border border-border"
              >
                <p className="text-sm font-medium mb-3">Recent Posts</p>
                <div className="space-y-3">
                  {[
                    { platform: "instagram" as Platform, status: "Published" },
                    { platform: "twitter" as Platform, status: "Scheduled" },
                    { platform: "linkedin" as Platform, status: "Draft" },
                  ].map((post, i) => (
                    <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-secondary/50">
                      <PlatformIcon platform={post.platform} size="sm" />
                      <span className="text-xs flex-1 truncate">New post content...</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${post.status === "Published" ? "bg-green-500/20 text-green-500" :
                        post.status === "Scheduled" ? "bg-blue-500/20 text-blue-500" :
                          "bg-muted text-muted-foreground"
                        }`}>{post.status}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
