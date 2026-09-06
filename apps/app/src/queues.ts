import {
  ANALYTICS_QUEUE,
  analyticsBatch,
  analyticsDeadLetterBatch,
  liveAnalyticsDeps,
} from "./analytics.ts";
import { deadLetterBatch, ingestBatch, liveIngestDeps } from "./ingest.ts";

/**
 * The single queue entry point, attached to the default export in
 * `src/server.ts` per ADR-010.
 *
 * One Worker consumes every queue in the account, so the batch's own queue name
 * is what separates them. This lived in `ingest.ts` while ingest was the only
 * consumer; it moved here when analytics arrived, so neither consumer owns the
 * dispatch for the other.
 */

/** Must match the queue names in `wrangler.jsonc`. */
export const INGEST_QUEUE = "cf-chat-ingest";
export const INGEST_DLQ = "cf-chat-ingest-dlq";
export const ANALYTICS_DLQ = "cf-chat-analytics-dlq";

/**
 * The four consumers, injected so the routing can be tested without bindings.
 * Each is a thunk rather than a value: resolving the live dependencies touches
 * Hyperdrive and AI Search, and only the queue that actually arrived should pay
 * for that.
 */
export interface QueueHandlers {
  readonly ingest: (batch: MessageBatch<unknown>) => Promise<void>;
  readonly ingestDeadLetter: (batch: MessageBatch<unknown>) => Promise<void>;
  readonly analytics: (batch: MessageBatch<unknown>) => Promise<void>;
  readonly analyticsDeadLetter: (batch: MessageBatch<unknown>) => Promise<void>;
}

export async function dispatchBatch(
  batch: MessageBatch<unknown>,
  handlers: QueueHandlers,
): Promise<void> {
  switch (batch.queue) {
    case INGEST_QUEUE:
      return handlers.ingest(batch);
    case INGEST_DLQ:
      return handlers.ingestDeadLetter(batch);
    case ANALYTICS_QUEUE:
      return handlers.analytics(batch);
    case ANALYTICS_DLQ:
      return handlers.analyticsDeadLetter(batch);
    default:
      // Acked rather than thrown: a throw retries a batch that nobody is going
      // to handle any better on the second attempt.
      console.error("Batch from an unknown queue", batch.queue);
      batch.ackAll();
      return;
  }
}

/**
 * The production wiring.
 *
 * Deliberately not a defaulted parameter on `dispatchBatch`: the runtime calls
 * queue(batch, env, ctx), so a defaulted second argument would be silently
 * replaced by the env object at runtime while still typechecking.
 */
export async function handleQueueBatch(batch: MessageBatch<unknown>): Promise<void> {
  return dispatchBatch(batch, {
    ingest: (received) => ingestBatch(received, liveIngestDeps()),
    ingestDeadLetter: (received) => deadLetterBatch(received, liveIngestDeps()),
    analytics: (received) => analyticsBatch(received, liveAnalyticsDeps()),
    analyticsDeadLetter: (received) => analyticsDeadLetterBatch(received),
  });
}
