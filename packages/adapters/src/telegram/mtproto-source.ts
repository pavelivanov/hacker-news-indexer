import type {
  HnReferenceInput,
  HnReferenceRole,
  IngestionRange,
  SelectionOccurrenceInput,
  TelegramEntityKind,
  TelegramMessageEntity,
} from "@hn-knowledge/domain";
import { hnItemId, telegramMessageId } from "@hn-knowledge/domain";
import type {
  Hasher,
  RandomSource,
  SelectionSource,
  Sleeper,
} from "@hn-knowledge/ports";
import { TelegramClient, type Message } from "@mtcute/node";

const DEFAULT_CHUNK_SIZE = 100;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_FLOOD_WAIT_MS = 30_000;
const MAX_MULTIPART_TOTAL = 20;

export interface TelegramMessageEntityRecord {
  readonly kind: string;
  readonly offset: number;
  readonly length: number;
  readonly url?: string;
}

export interface TelegramMessageRecord {
  readonly id: number;
  readonly date: Date;
  readonly editDate: Date | null;
  readonly text: string;
  readonly entities: readonly TelegramMessageEntityRecord[];
  readonly deleted?: boolean;
}

export interface TelegramMessagesClient {
  getMessages(
    sourceKey: string,
    ids: readonly number[],
  ): Promise<readonly (TelegramMessageRecord | null)[]>;
}

export interface TelegramMtprotoSourceOptions {
  readonly hasher: Hasher;
  readonly sleeper?: Sleeper;
  readonly random?: RandomSource;
  readonly chunkSize?: number;
  readonly requestTimeoutMs?: number;
  readonly retryCount?: number;
  readonly retryBaseMs?: number;
  readonly maxFloodWaitMs?: number;
}

export interface MtcuteTelegramSourceOptions extends TelegramMtprotoSourceOptions {
  readonly apiId: number;
  readonly apiHash: string;
  readonly sessionPath: string;
}

export interface MtcuteTelegramSource {
  readonly source: SelectionSource;
  close(): Promise<void>;
}

export class TelegramDeferredError extends Error {
  readonly code = "TELEGRAM_FLOOD_WAIT_DEFERRED";

  constructor(
    readonly waitMilliseconds: number,
    options?: ErrorOptions,
  ) {
    super("Telegram flood wait exceeds the configured ceiling", options);
    this.name = "TelegramDeferredError";
  }
}

export class TelegramRetryExhaustedError extends Error {
  readonly code = "TELEGRAM_RETRY_EXHAUSTED";

  constructor(options?: ErrorOptions) {
    super("Telegram request retries exhausted", options);
    this.name = "TelegramRetryExhaustedError";
  }
}

class TelegramRequestTimeoutError extends Error {
  constructor() {
    super("Telegram request timed out");
    this.name = "TelegramRequestTimeoutError";
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

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new TelegramRequestTimeoutError()),
      timeoutMs,
    );
    timeout.unref();
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

const errorRecord = (error: unknown): Record<string, unknown> =>
  error !== null && typeof error === "object"
    ? (error as Record<string, unknown>)
    : {};

const floodWaitMilliseconds = (error: unknown): number | null => {
  const record = errorRecord(error);
  for (const field of ["seconds", "wait", "retryAfter"] as const) {
    const seconds = record[field];
    if (
      typeof seconds === "number" &&
      Number.isFinite(seconds) &&
      seconds >= 0
    ) {
      return Math.ceil(seconds * 1_000);
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const match = /FLOOD_WAIT_?(\d+)/iu.exec(message);
  return match === null ? null : Number(match[1]) * 1_000;
};

const isRetryable = (error: unknown): boolean => {
  if (error instanceof TelegramRequestTimeoutError) {
    return true;
  }
  const record = errorRecord(error);
  const status = record["status"] ?? record["statusCode"] ?? record["code"];
  if (
    typeof status === "number" &&
    (status === 429 || (status >= 500 && status <= 599))
  ) {
    return true;
  }
  const message =
    error instanceof Error ? `${error.name} ${error.message}` : "";
  return /timeout|timed out|ECONNRESET|ETIMEDOUT|server error/iu.test(message);
};

const entityKind = (kind: string): TelegramEntityKind => {
  switch (kind) {
    case "url":
    case "text_link":
    case "bold":
    case "italic":
    case "underline":
    case "strikethrough":
    case "code":
    case "pre":
    case "blockquote":
      return kind;
    default:
      return "unknown";
  }
};

const normalizeEntities = (
  text: string,
  entities: readonly TelegramMessageEntityRecord[],
): readonly TelegramMessageEntity[] =>
  entities.map((entity) => {
    const offset = boundedInteger(
      entity.offset,
      0,
      text.length,
      "entity offset",
    );
    const length = boundedInteger(
      entity.length,
      0,
      text.length - offset,
      "entity length",
    );
    const url =
      entity.url ??
      (entity.kind === "url" ? text.slice(offset, offset + length) : undefined);
    return {
      kind: entityKind(entity.kind),
      offset,
      length,
      ...(url === undefined ? {} : { url }),
    };
  });

const hnIdFromUrl = (rawUrl: string | undefined): number | null => {
  if (rawUrl === undefined) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    if (
      !["news.ycombinator.com", "www.news.ycombinator.com"].includes(
        url.hostname.toLowerCase(),
      ) ||
      url.pathname !== "/item"
    ) {
      return null;
    }
    const id = Number(url.searchParams.get("id"));
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
};

const roleAt = (index: number, total: number): HnReferenceRole => {
  if (index === total - 1) {
    return "SELECTED_COMMENT";
  }
  if (index === 0 && total > 1) {
    return "DISPLAYED_STORY_REFERENCE";
  }
  return "INLINE_HN_REFERENCE";
};

const hnReferences = (
  entities: readonly TelegramMessageEntity[],
): readonly HnReferenceInput[] => {
  const candidates = entities
    .map((entity) => ({ entity, id: hnIdFromUrl(entity.url) }))
    .filter(
      (candidate): candidate is { entity: TelegramMessageEntity; id: number } =>
        candidate.id !== null,
    )
    .sort((left, right) => left.entity.offset - right.entity.offset);

  return candidates.map(({ entity, id }, index) => ({
    itemId: hnItemId(id),
    role: roleAt(index, candidates.length),
    entityOffset: entity.offset,
    entityLength: entity.length,
    parseConfidence: index === candidates.length - 1 ? 0.9 : 1,
  }));
};

const multipartMarker = (
  text: string,
): SelectionOccurrenceInput["multipart"] => {
  const match =
    /\[(\d{1,2})\s*\/\s*(\d{1,2})\]\s*$/u.exec(text) ??
    /\bpart\s*(\d{1,2})\s*\/\s*(\d{1,2})\b/iu.exec(text);
  if (match === null) {
    return null;
  }
  const part = Number(match[1]);
  const total = Number(match[2]);
  if (part < 1 || total < part || total > MAX_MULTIPART_TOTAL) {
    return null;
  }
  return { part, total };
};

const missingOccurrence = (
  range: IngestionRange,
  id: number,
): SelectionOccurrenceInput => ({
  source: range.source,
  sourceKey: range.sourceKey,
  externalId: telegramMessageId(id),
  occurredAt: null,
  editedAt: null,
  text: null,
  contentHash: null,
  entities: [],
  references: [],
  multipart: null,
  status: "MISSING",
});

const occurrence = (
  range: IngestionRange,
  message: TelegramMessageRecord,
  hasher: Hasher,
): SelectionOccurrenceInput => {
  if (message.deleted === true) {
    return {
      ...missingOccurrence(range, message.id),
      occurredAt: message.date,
      editedAt: message.editDate,
      status: "DELETED",
    };
  }
  const entities = normalizeEntities(message.text, message.entities);
  return {
    source: range.source,
    sourceKey: range.sourceKey,
    externalId: telegramMessageId(message.id),
    occurredAt: message.date,
    editedAt: message.editDate,
    text: message.text,
    contentHash: hasher.sha256(message.text),
    entities,
    references: hnReferences(entities),
    multipart: multipartMarker(message.text),
    status: "OBSERVED",
  };
};

const mtcuteMessageRecord = (message: Message): TelegramMessageRecord => ({
  id: message.id,
  date: message.date,
  editDate: message.editDate,
  text: message.text,
  entities: message.entities.map((entity) => ({
    kind: entity.kind,
    offset: entity.offset,
    length: entity.length,
    ...(entity.is("text_link") ? { url: entity.params.url } : {}),
  })),
});

export class MtcuteTelegramMessagesClient implements TelegramMessagesClient {
  constructor(private readonly client: TelegramClient) {}

  async getMessages(
    sourceKey: string,
    ids: readonly number[],
  ): Promise<readonly (TelegramMessageRecord | null)[]> {
    const messages = await this.client.getMessages(sourceKey, [...ids]);
    return messages.map((message) =>
      message === null ? null : mtcuteMessageRecord(message),
    );
  }
}

export class TelegramMtprotoSource implements SelectionSource {
  private readonly sleeper: Sleeper;
  private readonly random: RandomSource;
  private readonly chunkSize: number;
  private readonly requestTimeoutMs: number;
  private readonly retryCount: number;
  private readonly retryBaseMs: number;
  private readonly maxFloodWaitMs: number;

  constructor(
    private readonly client: TelegramMessagesClient,
    private readonly options: TelegramMtprotoSourceOptions,
  ) {
    this.sleeper = options.sleeper ?? defaultSleeper;
    this.random = options.random ?? defaultRandom;
    this.chunkSize = boundedInteger(
      options.chunkSize ?? DEFAULT_CHUNK_SIZE,
      1,
      DEFAULT_CHUNK_SIZE,
      "chunkSize",
    );
    this.requestTimeoutMs = boundedInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      1,
      120_000,
      "requestTimeoutMs",
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
    this.maxFloodWaitMs = boundedInteger(
      options.maxFloodWaitMs ?? DEFAULT_MAX_FLOOD_WAIT_MS,
      0,
      3_600_000,
      "maxFloodWaitMs",
    );
  }

  private async exactMessages(
    sourceKey: string,
    ids: readonly number[],
  ): Promise<readonly (TelegramMessageRecord | null)[]> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withTimeout(
          this.client.getMessages(sourceKey, ids),
          this.requestTimeoutMs,
        );
      } catch (error) {
        const floodWaitMs = floodWaitMilliseconds(error);
        if (floodWaitMs !== null && floodWaitMs > this.maxFloodWaitMs) {
          throw new TelegramDeferredError(floodWaitMs, { cause: error });
        }
        if (
          attempt >= this.retryCount ||
          (floodWaitMs === null && !isRetryable(error))
        ) {
          if (floodWaitMs === null && !isRetryable(error)) {
            throw error;
          }
          throw new TelegramRetryExhaustedError({ cause: error });
        }

        const backoff =
          this.retryBaseMs * 2 ** attempt * (0.5 + this.random.fraction());
        await this.sleeper.sleep(floodWaitMs ?? Math.round(backoff));
      }
    }
  }

  async *readRange(
    range: IngestionRange,
  ): AsyncIterable<SelectionOccurrenceInput> {
    if (range.source !== "TELEGRAM") {
      throw new TypeError("Telegram source only accepts TELEGRAM ranges");
    }
    const minId = Number(range.minId);
    const maxId = Number(range.maxId);
    if (maxId < minId) {
      throw new TypeError("Telegram range maxId must be at least minId");
    }

    for (let start = minId; start <= maxId; start += this.chunkSize) {
      const end = Math.min(maxId, start + this.chunkSize - 1);
      const ids = Array.from(
        { length: end - start + 1 },
        (_, index) => start + index,
      );
      const response = await this.exactMessages(range.sourceKey, ids);
      const records = new Map<number, TelegramMessageRecord>();
      for (const message of response) {
        if (message !== null && ids.includes(message.id)) {
          records.set(message.id, message);
        }
      }

      for (const id of ids) {
        const message = records.get(id);
        yield message === undefined
          ? missingOccurrence(range, id)
          : occurrence(range, message, this.options.hasher);
      }
    }
  }
}

export const createMtcuteTelegramSource = (
  options: MtcuteTelegramSourceOptions,
): MtcuteTelegramSource => {
  const client = new TelegramClient({
    apiId: options.apiId,
    apiHash: options.apiHash,
    storage: options.sessionPath,
    disableUpdates: true,
  });
  return {
    source: new TelegramMtprotoSource(
      new MtcuteTelegramMessagesClient(client),
      options,
    ),
    async close(): Promise<void> {
      await client.destroy();
    },
  };
};
