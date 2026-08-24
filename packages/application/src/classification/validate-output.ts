import {
  validateClassificationV1,
  type ClassificationV1,
  type ClassificationV1ValidationErrorCode,
} from "@hn-knowledge/contracts";
import type { Hasher } from "@hn-knowledge/ports";

import type {
  BoundedClassifierInput,
  ClassifierInputSpan,
} from "./build-input.js";

export type ClassifierOutputValidationErrorCode =
  | "JSON_INVALID"
  | ClassificationV1ValidationErrorCode
  | "URL_CANDIDATE_UNKNOWN"
  | "EVIDENCE_SPAN_UNKNOWN"
  | "EVIDENCE_ORIGIN_MISMATCH"
  | "SUBJECT_NAME_UNSUPPORTED"
  | "ROOT_RELEVANCE_FAILED"
  | "MODEL_URL_STRING";

export interface ValidatedEvidenceSpan {
  readonly id: string;
  readonly documentId: string;
  readonly origin: "COMMENT" | "ROOT_STORY";
  readonly start: number;
  readonly end: number;
  readonly textHash: string;
}

export type ClassifierOutputValidationResult =
  | {
      readonly ok: true;
      readonly output: ClassificationV1;
      readonly evidenceSpans: readonly ValidatedEvidenceSpan[];
    }
  | { readonly ok: false; readonly code: ClassifierOutputValidationErrorCode };

const RAW_URL = /https?:\/\//iu;

const outputContainsRawUrl = (output: ClassificationV1): boolean =>
  RAW_URL.test(output.comment_relevance.reason) ||
  output.discoveries.some(
    (discovery) =>
      RAW_URL.test(discovery.name) ||
      RAW_URL.test(discovery.description_claim) ||
      discovery.aliases.some((alias) => RAW_URL.test(alias)),
  ) ||
  (output.expert_note !== null &&
    (RAW_URL.test(output.expert_note.title) ||
      RAW_URL.test(output.expert_note.summary) ||
      output.expert_note.related_subject_names.some((name) =>
        RAW_URL.test(name),
      ) ||
      output.expert_note.qualifiers.some((qualifier) =>
        RAW_URL.test(qualifier),
      )));

const referencedSpanIds = (output: ClassificationV1): readonly string[] => [
  ...output.comment_relevance.evidence_span_ids,
  ...output.discoveries.flatMap((discovery) => discovery.evidence_span_ids),
  ...(output.expert_note?.evidence_span_ids ?? []),
];

const originFor = (
  spanIds: readonly string[],
  spans: ReadonlyMap<string, ClassifierInputSpan>,
): "COMMENT" | "ROOT_STORY" | "BOTH" | null => {
  const origins = new Set(
    spanIds.map((id) => spans.get(id)?.origin).filter((value) => value != null),
  );
  if (origins.size === 0) {
    return null;
  }
  if (origins.size === 2) {
    return "BOTH";
  }
  return origins.has("COMMENT") ? "COMMENT" : "ROOT_STORY";
};

const supportsName = (
  discovery: ClassificationV1["discoveries"][number],
  spans: ReadonlyMap<string, ClassifierInputSpan>,
): boolean => {
  const names = [discovery.name, ...discovery.aliases].map((name) =>
    name.toLocaleLowerCase(),
  );
  return discovery.evidence_span_ids.some((id) => {
    const evidence = spans.get(id)?.text.toLocaleLowerCase() ?? "";
    return names.some((name) => evidence.includes(name));
  });
};

export const validateClassifierOutput = (
  rawOutput: string,
  input: BoundedClassifierInput,
  hasher: Hasher,
): ClassifierOutputValidationResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput) as unknown;
  } catch {
    return { ok: false, code: "JSON_INVALID" };
  }
  const contract = validateClassificationV1(parsed);
  if (!contract.ok) {
    return contract;
  }
  const output = contract.value;
  if (outputContainsRawUrl(output)) {
    return { ok: false, code: "MODEL_URL_STRING" };
  }
  const candidates = new Set(
    input.urlCandidates.map((candidate) => candidate.id),
  );
  if (
    output.discoveries.some((discovery) =>
      discovery.url_candidate_ids.some((id) => !candidates.has(id)),
    )
  ) {
    return { ok: false, code: "URL_CANDIDATE_UNKNOWN" };
  }
  const spans = new Map(
    input.documents.flatMap((document) =>
      document.spans.map((span) => [span.id, span] as const),
    ),
  );
  const referencedIds = [...new Set(referencedSpanIds(output))];
  if (referencedIds.some((id) => !spans.has(id))) {
    return { ok: false, code: "EVIDENCE_SPAN_UNKNOWN" };
  }
  if (
    output.discoveries.some(
      (discovery) =>
        originFor(discovery.evidence_span_ids, spans) !==
        discovery.evidence_origin,
    ) ||
    (output.expert_note !== null &&
      originFor(output.expert_note.evidence_span_ids, spans) !==
        output.expert_note.evidence_origin)
  ) {
    return { ok: false, code: "EVIDENCE_ORIGIN_MISMATCH" };
  }
  if (output.discoveries.some((discovery) => !supportsName(discovery, spans))) {
    return { ok: false, code: "SUBJECT_NAME_UNSUPPORTED" };
  }
  if (
    !output.comment_relevance.is_materially_technical &&
    output.discoveries.some(
      (discovery) => discovery.evidence_origin !== "COMMENT",
    )
  ) {
    return { ok: false, code: "ROOT_RELEVANCE_FAILED" };
  }

  return {
    ok: true,
    output,
    evidenceSpans: referencedIds.map((id) => {
      const span = spans.get(id);
      if (span === undefined) {
        throw new TypeError("Validated evidence span disappeared");
      }
      return {
        id,
        documentId: span.documentId,
        origin: span.origin,
        start: span.sourceStart,
        end: span.sourceEnd,
        textHash: hasher.sha256(span.text),
      };
    }),
  };
};
