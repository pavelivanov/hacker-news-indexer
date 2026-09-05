import {
  ClassifierProviderError,
  type ClassifierPort,
  type ClassifierRequest,
  type ClassifierResponse,
} from "@hn-knowledge/ports";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

export const OPENAI_REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type OpenAiReasoningEffort = (typeof OPENAI_REASONING_EFFORTS)[number];

export type OpenAiFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAiClassifierOptions {
  readonly apiToken: string;
  readonly modelId: string;
  readonly reasoningEffort?: OpenAiReasoningEffort;
  readonly maxOutputTokens?: number;
  readonly fetch?: OpenAiFetch;
}

const boundedInteger = (
  value: number,
  minimum: number,
  maximum: number,
  field: string,
): number => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const nonEmpty = (value: string, field: string): string => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
  return trimmed;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseRetryAfterMs = (value: string | null): number | null => {
  if (value === null) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : Math.max(0, timestamp - Date.now());
};

const providerSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(providerSchema);
  }
  if (!isRecord(value)) {
    return value;
  }
  const transformed: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "$id" ||
      key === "minLength" ||
      key === "maxLength" ||
      key === "uniqueItems"
    ) {
      continue;
    }
    if (key === "const") {
      transformed["enum"] = [providerSchema(child)];
      continue;
    }
    transformed[key] = providerSchema(child);
  }
  return transformed;
};

export const toOpenAiStructuredOutputSchema = (
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  providerSchema(schema) as Readonly<Record<string, unknown>>;

const responseOutputText = (response: Record<string, unknown>): string => {
  if (typeof response["output_text"] === "string") {
    return response["output_text"];
  }
  const output = response["output"];
  if (!Array.isArray(output)) {
    throw new ClassifierProviderError("CLASSIFIER_INVALID_RESPONSE", false);
  }
  const text: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item["type"] !== "message") {
      continue;
    }
    const content = item["content"];
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!isRecord(part)) {
        continue;
      }
      if (part["type"] === "refusal") {
        throw new ClassifierProviderError("CLASSIFIER_INVALID_RESPONSE", false);
      }
      if (part["type"] === "output_text" && typeof part["text"] === "string") {
        text.push(part["text"]);
      }
    }
  }
  if (text.length === 0) {
    throw new ClassifierProviderError("CLASSIFIER_INVALID_RESPONSE", false);
  }
  return text.join("");
};

const usageValue = (
  response: Record<string, unknown>,
  field: "input_tokens" | "output_tokens",
): number | null => {
  const usage = response["usage"];
  if (!isRecord(usage)) {
    return null;
  }
  const value = usage[field];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
};

const inputTokenDetailValue = (
  response: Record<string, unknown>,
  field: "cached_tokens" | "cache_write_tokens",
): number | null => {
  const usage = response["usage"];
  if (!isRecord(usage)) {
    return null;
  }
  const details = usage["input_tokens_details"];
  if (!isRecord(details)) {
    return null;
  }
  const value = details[field];
  if (value === undefined) {
    return 0;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
};

const httpError = (response: Response): ClassifierProviderError => {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (response.status === 401 || response.status === 403) {
    return new ClassifierProviderError("CLASSIFIER_AUTH", false);
  }
  if (response.status === 408) {
    return new ClassifierProviderError(
      "CLASSIFIER_TIMEOUT",
      true,
      retryAfterMs,
    );
  }
  if (response.status === 429) {
    return new ClassifierProviderError(
      "CLASSIFIER_RATE_LIMIT",
      true,
      retryAfterMs,
    );
  }
  if (response.status >= 500) {
    return new ClassifierProviderError(
      "CLASSIFIER_PROVIDER_5XX",
      true,
      retryAfterMs,
    );
  }
  return new ClassifierProviderError("CLASSIFIER_CONFIG", false);
};

export class OpenAiClassifier implements ClassifierPort {
  readonly provider = "openai";
  readonly modelId: string;
  readonly modelConfigId: string;
  readonly reasoningEffort: OpenAiReasoningEffort;
  readonly maxOutputTokens: number;
  private readonly apiToken: string;
  private readonly fetcher: OpenAiFetch;

  constructor(options: OpenAiClassifierOptions) {
    this.apiToken = nonEmpty(options.apiToken, "apiToken");
    this.modelId = nonEmpty(options.modelId, "modelId");
    this.reasoningEffort = options.reasoningEffort ?? "low";
    this.maxOutputTokens = boundedInteger(
      options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      1,
      128_000,
      "maxOutputTokens",
    );
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.modelConfigId = [
      "openai-responses",
      this.modelId,
      `reasoning-${this.reasoningEffort}`,
      `max-output-${this.maxOutputTokens}`,
      "strict-json-schema",
      "store-false",
      "v1",
    ].join(":");
  }

  async classify(request: ClassifierRequest): Promise<ClassifierResponse> {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    timeout.unref();
    let payload: unknown;
    try {
      const response = await this.fetcher(OPENAI_RESPONSES_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.modelId,
          instructions: request.prompt,
          input: JSON.stringify(request.input),
          reasoning: { effort: this.reasoningEffort },
          text: {
            format: {
              type: "json_schema",
              name: "classification_v1",
              strict: true,
              schema: toOpenAiStructuredOutputSchema(request.outputSchema),
            },
            verbosity: "low",
          },
          tools: [],
          parallel_tool_calls: false,
          max_output_tokens: this.maxOutputTokens,
          store: false,
        }),
        signal: request.signal
          ? AbortSignal.any([controller.signal, request.signal])
          : controller.signal,
      });
      if (!response.ok) throw httpError(response);
      try {
        payload = await response.json();
      } catch (error) {
        throw new ClassifierProviderError(
          "CLASSIFIER_INVALID_RESPONSE",
          false,
          null,
          { cause: error },
        );
      }
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ClassifierProviderError("CLASSIFIER_TIMEOUT", true, null, {
          cause: error,
        });
      }
      if (error instanceof ClassifierProviderError) throw error;
      throw new ClassifierProviderError("CLASSIFIER_PROVIDER_5XX", true, null, {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!isRecord(payload) || payload["status"] !== "completed") {
      throw new ClassifierProviderError("CLASSIFIER_INVALID_RESPONSE", false);
    }
    const inputTokens = usageValue(payload, "input_tokens");
    const cachedInputTokens = inputTokenDetailValue(payload, "cached_tokens");
    const cacheWriteInputTokens = inputTokenDetailValue(
      payload,
      "cache_write_tokens",
    );
    if (
      inputTokens !== null &&
      cachedInputTokens !== null &&
      cacheWriteInputTokens !== null &&
      cachedInputTokens + cacheWriteInputTokens > inputTokens
    ) {
      throw new ClassifierProviderError("CLASSIFIER_INVALID_RESPONSE", false);
    }
    return {
      rawOutput: responseOutputText(payload),
      provider: this.provider,
      modelId: this.modelId,
      modelConfigId: this.modelConfigId,
      latencyMs: Math.round(performance.now() - startedAt),
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      outputTokens: usageValue(payload, "output_tokens"),
    };
  }
}
