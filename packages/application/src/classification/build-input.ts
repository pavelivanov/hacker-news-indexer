import { URL } from "node:url";

import type { CanonicalContentBlock, HnItemId } from "@hn-knowledge/domain";
import type {
  BoundedClassifierInput,
  ClassifierInputSource,
  ClassifierInputSpan,
  ClassifierTruncationEntry,
} from "@hn-knowledge/ports";

export type {
  BoundedClassifierInput,
  ClassifierInputDocument,
  ClassifierInputSource,
  ClassifierInputSpan,
  ClassifierInputUrlCandidate,
  ClassifierTruncationEntry,
} from "@hn-knowledge/ports";

export const CLASSIFIER_INPUT_VERSION = "classification-input.v1";
export const COMMENT_INPUT_LIMIT_BYTES = 24 * 1024;
export const ROOT_TITLE_LIMIT_CHARACTERS = 512;
export const ROOT_TEXT_LIMIT_BYTES = 16 * 1024;
export const TOTAL_INPUT_LIMIT_BYTES = 32 * 1024;
export const URL_CANDIDATE_LIMIT = 50;

const MAX_SPAN_CHARACTERS = 2_048;
const MIN_BOUNDARY_SEARCH_CHARACTERS = 1_024;

interface SourceDocument {
  readonly id: string;
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly text: string;
  readonly defaultKind: "TEXT" | "TITLE";
  readonly codeRanges: readonly {
    readonly start: number;
    readonly end: number;
  }[];
  readonly byteLimit: number;
  readonly characterLimit: number | null;
}

interface MutableInput {
  readonly schemaVersion: typeof CLASSIFIER_INPUT_VERSION;
  readonly selectedCommentId: HnItemId;
  readonly rootId: HnItemId;
  readonly documents: {
    readonly id: string;
    readonly origin: "COMMENT" | "ROOT_STORY";
    spans: ClassifierInputSpan[];
  }[];
  urlCandidates: {
    readonly id: string;
    readonly url: string;
    readonly sourceDocument: string;
    readonly originField: string;
  }[];
  truncation: ClassifierTruncationEntry[];
}

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const safeEnd = (value: string, start: number, proposedEnd: number): number => {
  let end = Math.min(proposedEnd, value.length);
  if (
    end < value.length &&
    end > start &&
    /[\uD800-\uDBFF]/u.test(value.charAt(end - 1))
  ) {
    end -= 1;
  }
  return Math.max(start + 1, end);
};

const boundaryEnd = (value: string, start: number): number => {
  const maximum = safeEnd(value, start, start + MAX_SPAN_CHARACTERS);
  if (maximum >= value.length) {
    return value.length;
  }
  const minimum = Math.min(maximum, start + MIN_BOUNDARY_SEARCH_CHARACTERS);
  const window = value.slice(minimum, maximum);
  for (const boundary of ["\n\n", "\n", ". ", " "] as const) {
    const index = window.lastIndexOf(boundary);
    if (index >= 0) {
      return safeEnd(value, start, minimum + index + boundary.length);
    }
  }
  return maximum;
};

const rangesForBlocks = (
  text: string,
  blocks: readonly CanonicalContentBlock[],
): readonly { readonly start: number; readonly end: number }[] => {
  const ranges: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.kind !== "CODE" || block.text.length === 0) {
      continue;
    }
    const start = text.indexOf(block.text, cursor);
    if (start < 0) {
      continue;
    }
    const end = start + block.text.length;
    ranges.push({ start, end });
    cursor = end;
  }
  return ranges;
};

const kindAt = (
  document: SourceDocument,
  start: number,
  end: number,
): "TEXT" | "CODE" | "TITLE" =>
  document.defaultKind === "TITLE"
    ? "TITLE"
    : document.codeRanges.some(
          (range) => start < range.end && end > range.start,
        )
      ? "CODE"
      : "TEXT";

const createSpans = (
  document: SourceDocument,
  firstSpanIndex: number,
): ClassifierInputSpan[] => {
  const spans: ClassifierInputSpan[] = [];
  let cursor = 0;
  let consumedBytes = 0;
  const maximumCharacters =
    document.characterLimit === null
      ? document.text.length
      : Math.min(document.text.length, document.characterLimit);
  while (cursor < maximumCharacters) {
    let end = Math.min(boundaryEnd(document.text, cursor), maximumCharacters);
    let chunk = document.text.slice(cursor, end);
    while (
      chunk.length > 1 &&
      consumedBytes + utf8Bytes(chunk) > document.byteLimit
    ) {
      end = safeEnd(
        document.text,
        cursor,
        cursor + Math.floor((end - cursor) / 2),
      );
      chunk = document.text.slice(cursor, end);
    }
    if (consumedBytes + utf8Bytes(chunk) > document.byteLimit) {
      break;
    }
    spans.push({
      id: `span:${firstSpanIndex + spans.length}`,
      documentId: document.id,
      origin: document.origin,
      kind: kindAt(document, cursor, end),
      sourceStart: cursor,
      sourceEnd: end,
      text: chunk,
    });
    consumedBytes += utf8Bytes(chunk);
    cursor = end;
  }
  return spans;
};

const complementRanges = (
  length: number,
  includedRanges: readonly {
    readonly sourceStart: number;
    readonly sourceEnd: number;
  }[],
): { sourceStart: number; sourceEnd: number }[] => {
  const omitted: { sourceStart: number; sourceEnd: number }[] = [];
  let cursor = 0;
  for (const range of includedRanges) {
    if (range.sourceStart > cursor) {
      omitted.push({ sourceStart: cursor, sourceEnd: range.sourceStart });
    }
    cursor = Math.max(cursor, range.sourceEnd);
  }
  if (cursor < length) {
    omitted.push({ sourceStart: cursor, sourceEnd: length });
  }
  return omitted;
};

const truncationFor = (
  source: SourceDocument,
  spans: readonly ClassifierInputSpan[],
): ClassifierTruncationEntry => {
  const includedRanges = spans.map((span) => ({
    sourceStart: span.sourceStart,
    sourceEnd: span.sourceEnd,
  }));
  return {
    documentId: source.id,
    originalLength: source.text.length,
    includedRanges,
    omittedRanges: complementRanges(source.text.length, includedRanges),
  };
};

const normalizedHttpUrl = (value: string | null): string | null => {
  if (value === null || value.length > 2_048) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.href
      : null;
  } catch {
    return null;
  }
};

const serializedBytes = (value: MutableInput): number =>
  utf8Bytes(JSON.stringify(value));

const updateTruncation = (
  input: MutableInput,
  sources: readonly SourceDocument[],
): void => {
  input.truncation = sources.map((source) => {
    const document = input.documents.find((value) => value.id === source.id);
    return truncationFor(source, document?.spans ?? []);
  });
};

const removeLastSpan = (input: MutableInput, documentId: string): boolean => {
  const document = input.documents.find((value) => value.id === documentId);
  if (document === undefined || document.spans.length === 0) {
    return false;
  }
  document.spans.pop();
  return true;
};

export const buildClassifierInput = (
  source: ClassifierInputSource,
): BoundedClassifierInput => {
  const commentDocumentId = `comment:${source.selectedCommentId}`;
  const rootTitleDocumentId = `root-title:${source.rootId}`;
  const rootTextDocumentId = `root-text:${source.rootId}`;
  const sources: SourceDocument[] = [
    {
      id: commentDocumentId,
      origin: "COMMENT",
      text: source.commentText,
      defaultKind: "TEXT",
      codeRanges: rangesForBlocks(source.commentText, source.commentBlocks),
      byteLimit: COMMENT_INPUT_LIMIT_BYTES,
      characterLimit: null,
    },
    {
      id: rootTitleDocumentId,
      origin: "ROOT_STORY",
      text: source.rootTitle,
      defaultKind: "TITLE",
      codeRanges: [],
      byteLimit: Number.MAX_SAFE_INTEGER,
      characterLimit: ROOT_TITLE_LIMIT_CHARACTERS,
    },
    {
      id: rootTextDocumentId,
      origin: "ROOT_STORY",
      text: source.rootText,
      defaultKind: "TEXT",
      codeRanges: rangesForBlocks(source.rootText, source.rootBlocks),
      byteLimit: ROOT_TEXT_LIMIT_BYTES,
      characterLimit: null,
    },
  ];
  let spanIndex = 0;
  const documents = sources.map((document) => {
    const spans = createSpans(document, spanIndex);
    spanIndex += spans.length;
    return { id: document.id, origin: document.origin, spans };
  });
  const urlCandidates = source.urlCandidates
    .flatMap((candidate) => {
      const url = normalizedHttpUrl(candidate.canonicalUrl);
      return url === null || candidate.validationState === "REJECTED"
        ? []
        : [
            {
              url,
              sourceDocument: candidate.sourceDocument,
              originField: candidate.originField,
            },
          ];
    })
    .slice(0, URL_CANDIDATE_LIMIT)
    .map((candidate, index) => ({ id: `url:${index}`, ...candidate }));
  const input: MutableInput = {
    schemaVersion: CLASSIFIER_INPUT_VERSION,
    selectedCommentId: source.selectedCommentId,
    rootId: source.rootId,
    documents,
    urlCandidates,
    truncation: [],
  };
  updateTruncation(input, sources);

  while (serializedBytes(input) > TOTAL_INPUT_LIMIT_BYTES) {
    const changed =
      removeLastSpan(input, rootTextDocumentId) ||
      removeLastSpan(input, commentDocumentId) ||
      input.urlCandidates.pop() !== undefined ||
      removeLastSpan(input, rootTitleDocumentId);
    if (!changed) {
      throw new RangeError("Classifier input metadata exceeds total cap");
    }
    updateTruncation(input, sources);
  }

  return input;
};
