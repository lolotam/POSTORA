import { FacebookInsightsProvider } from "../facebook-page-insights/provider.ts";
import type { MetricDefinition } from "../_shared/analyticsContract.ts";
import type { AnalyticsCapture } from "./store.ts";
import { captureCell, collectionPage, collectionPost, requiredReply, type CollectionCells, type CollectionProvider } from "./collectionProvider.ts";

export function facebookCollection(provider: FacebookInsightsProvider, pageId: string): CollectionProvider {
  return {
    page: async (cursor) => {
      const reply = requiredReply(await provider.posts(pageId, cursor));
      return collectionPage(reply.data.map((post) => post.id), reply.paging);
    },
    post: async (id) => {
      const post = requiredReply(await provider.post(id));
      return collectionPost({ published_at: post.created_time, text: post.message ?? "", permalink: post.permalink_url ?? null });
    },
    metrics: async (capture: AnalyticsCapture, definitions: MetricDefinition[]) => {
      const cells: CollectionCells = {};
      for (const definition of definitions) {
        const reply = capture.kind === "account_day"
          ? await provider.metric({ pageId, metric: definition.providerMetric!, since: capture.since!, until: capture.until! })
          : await provider.postMetric(capture.subject_id, definition.providerMetric!);
        cells[definition.key] = captureCell(reply, definition, capture);
      }
      return cells;
    },
  };
}
