import {
  HN_ITEM_TYPES,
  hnItemId,
  type HnFetchResult,
  type HnItem,
  type HnItemId,
  type HnItemType,
} from "@hn-knowledge/domain";
import type {
  Clock,
  Hasher,
  HnItems,
  RandomSource,
  Sleeper,
} from "@hn-knowledge/ports";

const HN_ITEM_BASE_URL = "https://hacker-news.firebaseio.com/v0/item";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_NULL_CONFIRMATION_DELAY_MS = 250;

export type HttpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface HackerNewsApiItemsOptions {
  readonly fetch?: HttpFetch;
  readonly clock: Clock;
  readonly hasher: Hasher;
  readonly sleeper?: Sleeper;
  readonly random?: RandomSource;
  readonly timeoutMs?: number;
  readonly retryCount?: number;
  readonly retryBaseMs?: number;
  readonly nullConfirmationDelayMs?: number;
}

export class HnHttpError extends Error {
  readonly code = "HN_HTTP_ERROR";

  constructor(readonly status: number) {
    super(`HN API returned HTTP ${status}`);
    this.name = "HnHttpError";
  }
}

export class HnProtocolError extends Error {
  readonly code = "HN_PROTOCOL_ERROR";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HnProtocolError";
  }
}

export class HnRetryExhaustedError extends Error {
  readonly code = "HN_RETRY_EXHAUSTED";

  constructor(options?: ErrorOptions) {
    super("HN API request retries exhausted", options);
    this.name = "HnRetryExhaustedError";
  }
}

class HnRequestTimeoutError extends Error {
  constructor(options?: ErrorOptions) {
    super("HN API request timed out", options);
    this.name = "HnRequestTimeoutError";
  }
}

const defaultSleeper: Sleeper = {
  sleep: async (milliseconds) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
};
const defaultRandom: RandomSource = { fraction: () => Math.random() };

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nullableString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const optionalId = (value: unknown): HnItemId | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? hnItemId(value)
    : null;

const itemType = (value: unknown): HnItemType | null =>
  typeof value === "string" && HN_ITEM_TYPES.includes(value as HnItemType)
    ? (value as HnItemType)
    : null;

const parseItem = (
  raw: string,
  requestedId: HnItemId,
  fetchedAt: Date,
  responseHash: string,
): HnItem => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new HnProtocolError("HN API returned malformed JSON", {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new HnProtocolError("HN API item must be an object");
  }
  const id = optionalId(value["id"]);
  const type = itemType(value["type"]);
  if (id === null || id !== requestedId || type === null) {
    throw new HnProtocolError("HN API item identity or type is invalid");
  }

  const timestamp = value["time"];
  const time =
    typeof timestamp === "number" &&
    Number.isSafeInteger(timestamp) &&
    timestamp >= 0
      ? new Date(timestamp * 1_000)
      : null;
  const availability =
    value["deleted"] === true
      ? "DELETED"
      : value["dead"] === true
        ? "DEAD"
        : "AVAILABLE";

  return {
    id,
    type,
    parentId: optionalId(value["parent"]),
    author: nullableString(value["by"]),
    time,
    title: nullableString(value["title"]),
    textHtml: nullableString(value["text"]),
    url: nullableString(value["url"]),
    availability,
    fetchedAt,
    responseHash,
  };
};

export class HackerNewsApiItems implements HnItems {
  private readonly fetcher: HttpFetch;
  private readonly sleeper: Sleeper;
  private readonly random: RandomSource;
  private readonly timeoutMs: number;
  private readonly retryCount: number;
  private readonly retryBaseMs: number;
  private readonly nullConfirmationDelayMs: number;

  constructor(private readonly options: HackerNewsApiItemsOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.sleeper = options.sleeper ?? defaultSleeper;
    this.random = options.random ?? defaultRandom;
    this.timeoutMs = boundedInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      1,
      120_000,
      "timeoutMs",
    );
    this.retryCount = boundedInteger(
      options.retryCount ?? DEFAULT_RETRY_COUNT,
      0,
      10,
      "retryCount",
    );
    this.retryBaseMs = boundedInteger(
      options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      0,
      60_000,
      "retryBaseMs",
    );
    this.nullConfirmationDelayMs = boundedInteger(
      options.nullConfirmationDelayMs ?? DEFAULT_NULL_CONFIRMATION_DELAY_MS,
      0,
      60_000,
      "nullConfirmationDelayMs",
    );
  }

  private async request(id: HnItemId): Promise<string> {
    const url = `${HN_ITEM_BASE_URL}/${id}.json`;
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      timeout.unref();
      try {
        const response = await this.fetcher(url, { signal: controller.signal });
        if (response.ok) {
          return await response.text();
        }
        const error = new HnHttpError(response.status);
        if (
          attempt >= this.retryCount ||
          (response.status !== 429 && response.status < 500)
        ) {
          if (response.status !== 429 && response.status < 500) {
            throw error;
          }
          throw new HnRetryExhaustedError({ cause: error });
        }
      } catch (error) {
        const timedOut = controller.signal.aborted;
        if (
          error instanceof HnHttpError ||
          error instanceof HnRetryExhaustedError
        ) {
          throw error;
        }
        if (attempt >= this.retryCount) {
          throw new HnRetryExhaustedError({
            cause: timedOut
              ? new HnRequestTimeoutError({ cause: error })
              : error,
          });
        }
      } finally {
        clearTimeout(timeout);
      }

      const backoff =
        this.retryBaseMs * 2 ** attempt * (0.5 + this.random.fraction());
      await this.sleeper.sleep(Math.round(backoff));
    }
  }

  async get(id: HnItemId): Promise<HnFetchResult> {
    let raw = await this.request(id);
    if (raw.trim() === "null") {
      await this.sleeper.sleep(this.nullConfirmationDelayMs);
      raw = await this.request(id);
    }
    const fetchedAt = this.options.clock.now();
    const responseHash = this.options.hasher.sha256(raw);
    if (raw.trim() === "null") {
      return { kind: "MISSING", id, fetchedAt, responseHash };
    }
    return {
      kind: "ITEM",
      item: parseItem(raw, id, fetchedAt, responseHash),
    };
  }
}
