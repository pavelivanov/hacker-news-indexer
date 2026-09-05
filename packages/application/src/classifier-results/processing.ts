import { parseFeedControlV1, parseFeedRetryV1 } from "@hn-knowledge/contracts";
import type { FeedProcessingRepository } from "@hn-knowledge/ports";

export const createFeedProcessingService = (
  repository: FeedProcessingRepository,
) => ({
  status: () => repository.status(),
  async control(body: unknown) {
    await repository.control(parseFeedControlV1(body).action);
    return { accepted: true };
  },
  retry(kind: "job" | "result", id: string, body: unknown) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new TypeError("Invalid processing ID");
    return repository.retry(kind, id, parseFeedRetryV1(body).command_key);
  },
});
export type FeedProcessingService = ReturnType<
  typeof createFeedProcessingService
>;
