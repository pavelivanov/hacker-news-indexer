import type {
  IngestionRange,
  IngestionRunId,
  HnItemId,
  SelectionOccurrenceInput,
} from "@hn-knowledge/domain";
import type {
  IngestionRunRepository,
  OccurrenceRepository,
  PipelineJobPublisher,
  SelectionSource,
} from "@hn-knowledge/ports";

export interface IngestSelectionRangeInput {
  readonly runId: IngestionRunId;
  readonly range: IngestionRange;
}

export interface IngestSelectionRangeResult {
  readonly occurrenceCount: number;
  readonly selectedCommentCount: number;
}

export type IngestSelectionRange = (
  input: IngestSelectionRangeInput,
) => Promise<IngestSelectionRangeResult>;

const assertWithinRange = (
  range: IngestionRange,
  occurrence: SelectionOccurrenceInput,
): void => {
  if (
    occurrence.source !== range.source ||
    occurrence.sourceKey !== range.sourceKey ||
    occurrence.externalId < range.minId ||
    occurrence.externalId > range.maxId
  ) {
    throw new TypeError(
      "Selection source returned an occurrence outside its range",
    );
  }
};

export const createIngestSelectionRange =
  (
    source: SelectionSource,
    runs: IngestionRunRepository,
    occurrences: OccurrenceRepository,
    jobs: PipelineJobPublisher,
  ): IngestSelectionRange =>
  async (input): Promise<IngestSelectionRangeResult> => {
    await runs.markRunning(input.runId);
    let occurrenceCount = 0;
    const selectedCommentIds = new Map<number, HnItemId>();

    for await (const occurrenceInput of source.readRange(input.range)) {
      assertWithinRange(input.range, occurrenceInput);
      const occurrence = await occurrences.upsert(input.runId, occurrenceInput);
      occurrenceCount += 1;
      const selectedReferences = occurrence.references.filter(
        (reference) => reference.role === "SELECTED_COMMENT",
      );
      if (selectedReferences.length > 1) {
        throw new TypeError(
          "Occurrence has multiple selected-comment references",
        );
      }
      const selected = selectedReferences[0];
      if (selected === undefined) {
        continue;
      }
      selectedCommentIds.set(Number(selected.itemId), selected.itemId);
    }

    for (const selectedCommentId of selectedCommentIds.values()) {
      await jobs.enqueue({
        type: "RESOLVE_HN_COMMENT",
        ingestionRunId: input.runId,
        idempotencyKey: `resolve-hn:${input.runId}:${selectedCommentId}`,
        payload: {
          runId: input.runId,
          selectedCommentId,
        },
      });
    }

    return {
      occurrenceCount,
      selectedCommentCount: selectedCommentIds.size,
    };
  };
