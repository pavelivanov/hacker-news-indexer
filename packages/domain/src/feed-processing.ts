export class FeedProcessingError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "STATE_CONFLICT" | "IDEMPOTENCY_CONFLICT",
  ) {
    super(code);
    this.name = "FeedProcessingError";
  }
}
