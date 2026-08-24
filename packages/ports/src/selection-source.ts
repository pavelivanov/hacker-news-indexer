import type {
  IngestionRange,
  SelectionOccurrenceInput,
} from "@hn-knowledge/domain";

export interface SelectionSource {
  readRange(request: IngestionRange): AsyncIterable<SelectionOccurrenceInput>;
}
