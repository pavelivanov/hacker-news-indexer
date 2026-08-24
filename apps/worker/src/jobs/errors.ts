export class WorkerJobError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly retryAfterMs: number | null = null,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "WorkerJobError";
  }
}

export const jobError = (error: unknown): WorkerJobError => {
  if (error instanceof WorkerJobError) {
    return error;
  }
  const record =
    error !== null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : {};
  const code =
    typeof record["code"] === "string"
      ? record["code"]
      : error instanceof Error
        ? error.name.toUpperCase()
        : "UNKNOWN_ERROR";
  const retryable =
    code === "HN_RETRY_EXHAUSTED" ||
    code === "TELEGRAM_RETRY_EXHAUSTED" ||
    code === "TELEGRAM_FLOOD_WAIT_DEFERRED";
  const wait = record["waitMilliseconds"];
  return new WorkerJobError(
    code,
    retryable,
    typeof wait === "number" ? wait : null,
    { cause: error },
  );
};
