import { ThreadsInsightsProvider } from "../threads-insights/provider.ts";
import type { AnalyticsDayBucket } from "../_shared/analyticsCalendar.ts";
import { captureCell, captureRefusal, collectionPage, collectionPost, requiredReply, type CollectionCells, type CollectionProvider } from "./collectionProvider.ts";

export function threadsCollection(provider: ThreadsInsightsProvider, userId: string, latestDay: AnalyticsDayBucket): CollectionProvider {
  return {
    page: async (cursor) => {
      const reply = requiredReply(await provider.recentPosts(userId, { after: cursor, limit: 25 }));
      return collectionPage(reply.data.map((post) => post.id), reply.paging);
    },
    post: async (id) => {
      const post = requiredReply(await provider.post(id));
      return collectionPost({ published_at: post.timestamp, text: post.text ?? "", permalink: post.permalink ?? null });
    },
    metrics: async (capture, definitions) => {
      const reply = capture.kind === "post" ? await provider.postInsights(capture.subject_id)
        : await provider.profile({ userId, metrics: definitions.map((entry) => entry.providerMetric!),
          since: Date.parse(capture.since ?? latestDay.since) / 1000,
          until: Date.parse(capture.until ?? latestDay.until) / 1000,
          ...(capture.kind === "account_day" ? { metricType: "time_series" as const } : {}) });
      const cells: CollectionCells = {};
      for (const definition of definitions) cells[definition.key] = captureCell(reply, definition, capture);
      return { cells, refusal: captureRefusal(reply) };
    },
  };
}
