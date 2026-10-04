import { AdminLayout } from "@/components/admin/AdminLayout";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CheckCircle2, Clock, Zap, Server, Monitor, Database, Globe } from "lucide-react";

type ItemStatus = "done" | "planned" | "in-progress";
type ItemCategory = "Frontend" | "Backend" | "Infrastructure" | "Database";

interface ScalingItem {
  feature: string;
  category: ItemCategory;
  status: ItemStatus;
  description: string;
  section: "strengths" | "optimizations" | "recommendations";
}

const scalingData: ScalingItem[] = [
  // Current Strengths
  { feature: "Lazy Loading (lazyWithRetry)", category: "Frontend", status: "done", description: "All pages are code-split and lazy-loaded with automatic retry on chunk failures", section: "strengths" },
  { feature: "Per-User Rate Limiting", category: "Backend", status: "done", description: "Each user has independent API rate limits preventing abuse without affecting others", section: "strengths" },
  { feature: "Supabase Pro Plan", category: "Infrastructure", status: "done", description: "Dedicated database with connection pooling, 8GB RAM, daily backups", section: "strengths" },
  { feature: "Cloudflare CDN (Free)", category: "Infrastructure", status: "done", description: "Global CDN for static assets, DDoS protection, SSL termination", section: "strengths" },
  { feature: "Row Level Security (RLS)", category: "Database", status: "done", description: "All tables protected with RLS policies — data isolation per user at DB level", section: "strengths" },
  { feature: "Edge Functions (Deno)", category: "Backend", status: "done", description: "Serverless functions auto-scale with demand, no server management needed", section: "strengths" },
  { feature: "Nginx Asset Caching", category: "Infrastructure", status: "done", description: "Static assets cached with 1-year expiry headers for instant repeat loads", section: "strengths" },
  { feature: "OAuth Token Refresh", category: "Backend", status: "done", description: "Automatic token refresh with retry logic prevents auth failures at scale", section: "strengths" },

  // Implemented Optimizations
  { feature: "React Query Cache Defaults", category: "Frontend", status: "done", description: "staleTime: 5min, gcTime: 10min — reduces redundant DB calls by ~80%", section: "optimizations" },
  { feature: "Database Performance Indexes", category: "Database", status: "done", description: "B-tree indexes on posts, api_logs, social_accounts — queries go from full scan to instant lookup", section: "optimizations" },
  { feature: "Vendor Bundle Splitting", category: "Frontend", status: "done", description: "framer-motion, date-fns, recharts split into separate chunks — faster initial load", section: "optimizations" },
  { feature: "Edge Function Cache Headers", category: "Backend", status: "done", description: "cacheableJsonResponse helper adds Cache-Control for CDN caching of semi-static data", section: "optimizations" },
  { feature: "YouTube JIT Token Refresh", category: "Backend", status: "done", description: "YouTube removed from automatic cron — tokens only refresh before publishing or on user request, conserving Google's 100-use limit", section: "optimizations" },

  // Future Recommendations
  { feature: "Supabase Read Replicas", category: "Database", status: "planned", description: "Route read-heavy queries to replicas — needed at 50K+ users to reduce primary DB load", section: "recommendations" },
  { feature: "Redis for Rate Limiting", category: "Backend", status: "planned", description: "Move rate limit counters from PostgreSQL to Redis for sub-ms lookups at high throughput", section: "recommendations" },
  { feature: "Background Job Queue", category: "Backend", status: "planned", description: "Queue system (pg_boss or BullMQ) for post publishing — prevents edge function timeouts at scale", section: "recommendations" },
  { feature: "Table Partitioning (api_logs)", category: "Database", status: "planned", description: "Partition api_logs by month — keeps query performance stable as table grows to millions of rows", section: "recommendations" },
  { feature: "Image CDN (Cloudinary Transform)", category: "Infrastructure", status: "planned", description: "On-the-fly image resizing and format conversion — reduce bandwidth 60-70%", section: "recommendations" },
  { feature: "WebSocket for Real-time Updates", category: "Frontend", status: "planned", description: "Supabase Realtime for post status updates instead of polling — lower latency, fewer requests", section: "recommendations" },
  { feature: "Horizontal Edge Function Scaling", category: "Infrastructure", status: "planned", description: "Deploy edge functions to multiple regions for lower latency globally", section: "recommendations" },
  { feature: "Database Connection Pooling (PgBouncer)", category: "Database", status: "planned", description: "Already available on Supabase Pro — enable transaction mode for 10x more concurrent connections", section: "recommendations" },
  { feature: "Google App Verification", category: "Backend", status: "planned", description: "Submit Google Cloud app for verification to remove 100 refresh token limit — enables unlimited YouTube token refreshes", section: "recommendations" },
];

const statusConfig: Record<ItemStatus, { label: string; className: string }> = {
  "done": { label: "Done", className: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/20" },
  "in-progress": { label: "In Progress", className: "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/20" },
  "planned": { label: "Planned", className: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/20" },
};

const categoryIcons: Record<ItemCategory, React.ReactNode> = {
  "Frontend": <Monitor className="w-4 h-4" />,
  "Backend": <Server className="w-4 h-4" />,
  "Infrastructure": <Globe className="w-4 h-4" />,
  "Database": <Database className="w-4 h-4" />,
};

const sections = [
  { key: "strengths" as const, title: "Current Strengths", description: "Existing architecture advantages already in place", icon: CheckCircle2 },
  { key: "optimizations" as const, title: "Implemented Optimizations", description: "Performance improvements applied to the codebase", icon: Zap },
  { key: "recommendations" as const, title: "Future Recommendations", description: "Planned improvements for scaling to 100K+ users", icon: Clock },
];

function ScalingTable({ items }: { items: ScalingItem[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[250px]">Feature</TableHead>
          <TableHead className="w-[140px]">Category</TableHead>
          <TableHead className="w-[110px]">Status</TableHead>
          <TableHead>Description</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => (
          <TableRow key={item.feature}>
            <TableCell className="font-medium">{item.feature}</TableCell>
            <TableCell>
              <span className="flex items-center gap-1.5 text-muted-foreground text-sm">
                {categoryIcons[item.category]}
                {item.category}
              </span>
            </TableCell>
            <TableCell>
              <Badge className={statusConfig[item.status].className}>
                {statusConfig[item.status].label}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground text-sm max-md:whitespace-normal max-md:min-w-[14rem]">{item.description}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function AdminScaling() {
  const doneCount = scalingData.filter(i => i.status === "done").length;
  const plannedCount = scalingData.filter(i => i.status === "planned").length;
  const totalCount = scalingData.length;

  return (
    <AdminLayout>
      <div className="space-y-6">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-3 md:gap-4">
          <Card>
            <CardContent className="p-4 sm:p-6 sm:pt-6">
              <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{doneCount}</div>
              <p className="text-sm text-muted-foreground">Implemented</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 sm:p-6 sm:pt-6">
              <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">{plannedCount}</div>
              <p className="text-sm text-muted-foreground">Planned</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 sm:p-6 sm:pt-6">
              <div className="text-2xl font-bold">{totalCount}</div>
              <p className="text-sm text-muted-foreground">Total Features</p>
            </CardContent>
          </Card>
        </div>

        {/* Sections */}
        {sections.map((section) => {
          const items = scalingData.filter(i => i.section === section.key);
          const SectionIcon = section.icon;
          return (
            <Card key={section.key}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <SectionIcon className="w-5 h-5" />
                  {section.title}
                </CardTitle>
                <CardDescription>{section.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <ScalingTable items={items} />
              </CardContent>
            </Card>
          );
        })}
      </div>
    </AdminLayout>
  );
}
