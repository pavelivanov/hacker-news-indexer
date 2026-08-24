export interface HealthResponse {
  readonly status: "ok";
}

export interface ErrorResponse {
  readonly error: "internal_error" | "not_found" | "not_ready";
  readonly requestId: string;
}
