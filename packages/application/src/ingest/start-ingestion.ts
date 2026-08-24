import type {
  IngestionRange,
  SelectionSourceKind,
  TelegramMessageId,
} from "@hn-knowledge/domain";
import type {
  Hasher,
  IngestionRunRepository,
  StartIngestionResult,
} from "@hn-knowledge/ports";

export interface StartIngestionInput {
  readonly source: SelectionSourceKind;
  readonly sourceKey: string;
  readonly minId: TelegramMessageId;
  readonly maxId: TelegramMessageId;
}

export type StartIngestion = (
  input: StartIngestionInput,
) => Promise<StartIngestionResult>;

export const createStartIngestion =
  (repository: IngestionRunRepository, hasher: Hasher): StartIngestion =>
  async (input): Promise<StartIngestionResult> => {
    const range: IngestionRange = {
      source: input.source,
      sourceKey: input.sourceKey,
      minId: input.minId,
      maxId: input.maxId,
    };
    const requestKey = hasher.sha256(
      [
        "ingestion-range-v1",
        range.source,
        range.sourceKey,
        String(range.minId),
        String(range.maxId),
      ].join("\u0000"),
    );

    return repository.startOrGet(range, requestKey);
  };
