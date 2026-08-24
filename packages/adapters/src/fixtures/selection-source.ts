import type {
  IngestionRange,
  SelectionOccurrenceInput,
} from "@hn-knowledge/domain";
import type { Hasher, SelectionSource } from "@hn-knowledge/ports";

import {
  TelegramMtprotoSource,
  type TelegramMessageRecord,
  type TelegramMessagesClient,
} from "../telegram/mtproto-source.js";

export interface SelectionFixture {
  readonly sourceKey: string;
  readonly messages: readonly TelegramMessageRecord[];
}

export class FixtureSelectionSource implements SelectionSource {
  private readonly source: TelegramMtprotoSource;

  constructor(
    private readonly fixture: SelectionFixture,
    hasher: Hasher,
  ) {
    const messages = new Map(
      fixture.messages.map((message) => [message.id, message]),
    );
    const client: TelegramMessagesClient = {
      getMessages: (_sourceKey, ids) =>
        Promise.resolve(ids.map((id) => messages.get(id) ?? null)),
    };
    this.source = new TelegramMtprotoSource(client, { hasher });
  }

  async *readRange(
    range: IngestionRange,
  ): AsyncIterable<SelectionOccurrenceInput> {
    if (range.source !== "FIXTURE") {
      throw new TypeError("Fixture source only accepts FIXTURE ranges");
    }
    if (range.sourceKey !== this.fixture.sourceKey) {
      throw new TypeError(
        "Fixture source key does not match the requested range",
      );
    }
    const telegramRange: IngestionRange = { ...range, source: "TELEGRAM" };
    for await (const occurrence of this.source.readRange(telegramRange)) {
      yield { ...occurrence, source: "FIXTURE" };
    }
  }
}
