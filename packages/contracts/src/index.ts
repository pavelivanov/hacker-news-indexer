export interface HealthResponse {
  readonly status: "ok";
}

export interface ErrorResponse {
  readonly error: "internal_error" | "not_found" | "not_ready";
  readonly requestId: string;
}

export * from "./classification-v1.js";
export * from "./export-v1.js";
export * from "./reader-v1.js";

export * from "./manual-review-v1.js";
export * from "./classifier-feedback-v1.js";
export * from "./feed-processing-v1.js";
