import type { ClassificationV1 } from "@hn-knowledge/contracts";
import {
  createSubjectIdentity,
  normalizeSubjectName,
  normalizeSubjectUrl,
  reviewPolicyFromReasons,
  type ContentDecision,
  type ContentDecisionId,
  type SubjectId,
  type SubjectIdentity,
} from "@hn-knowledge/domain";
import type {
  BoundedClassifierInput,
  ClassificationRepository,
  Hasher,
  MaterializationUrlCandidate,
  MaterializedSubjectInput,
  SubjectMaterializationRepository,
} from "@hn-knowledge/ports";

import { loadClassifierInput } from "../classification/load-input.js";
import {
  validateClassifierOutput,
  type ValidatedEvidenceSpan,
} from "../classification/validate-output.js";

export const SUBJECT_EXTRACTION_VERSION = "subject-materialization.v1";

export class SubjectMaterializationError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "SubjectMaterializationError";
  }
}

export interface MaterializeDecisionResult {
  readonly decisionId: ContentDecisionId;
  readonly subjects: number;
  readonly mentions: number;
  readonly discoveries: number;
  readonly discoverySources: number;
  readonly expertNotes: number;
  readonly missingUrlDiscoveryOrdinals: readonly number[];
  readonly ambiguousUrlDiscoveryOrdinals: readonly number[];
  readonly invalidUrlDiscoveryOrdinals: readonly number[];
  readonly unresolvedRelatedSubjectNames: readonly string[];
}

export type MaterializeClassification = (
  decisionId: ContentDecisionId,
) => Promise<MaterializeDecisionResult>;

export interface SubjectMaterializationReviewQueue {
  readonly openActionReview: (input: {
    readonly commentId: ContentDecision["commentId"];
    readonly contentDecisionId: ContentDecisionId;
    readonly kind: "SUBJECT_MERGE" | "URL_RESOLUTION";
    readonly policy: ReturnType<typeof reviewPolicyFromReasons>;
  }) => Promise<unknown>;
}

interface PreparedSubject {
  readonly localKey: string;
  readonly input: MaterializedSubjectInput;
  readonly identity: SubjectIdentity;
}

const assertDecisionMatchesOutput = (
  decision: ContentDecision,
  output: ClassificationV1,
): void => {
  if (
    decision.primaryDecision !== output.primary_decision ||
    decision.decisionConfidence !== output.decision_confidence ||
    decision.materiallyTechnical !==
      output.comment_relevance.is_materially_technical
  ) {
    throw new SubjectMaterializationError("MATERIALIZATION_DECISION_DRIFT");
  }
};

const assertEvidenceMatches = (
  decision: ContentDecision,
  validated: readonly ValidatedEvidenceSpan[],
): void => {
  const stored = new Map(
    decision.evidenceSpans.map((span) => [span.spanId, span]),
  );
  if (stored.size !== validated.length) {
    throw new SubjectMaterializationError("MATERIALIZATION_EVIDENCE_DRIFT");
  }
  for (const span of validated) {
    const value = stored.get(span.id);
    if (
      value === undefined ||
      value.sourceDocument !== span.documentId ||
      value.origin !== span.origin ||
      value.start !== span.start ||
      value.end !== span.end ||
      value.textHash !== span.textHash
    ) {
      throw new SubjectMaterializationError("MATERIALIZATION_EVIDENCE_DRIFT");
    }
  }
};

const validateStoredOutput = (
  decision: ContentDecision,
  input: BoundedClassifierInput,
  hasher: Hasher,
): ClassificationV1 => {
  let serialized: string;
  try {
    serialized = JSON.stringify(decision.validatedOutput);
  } catch (error) {
    throw new SubjectMaterializationError(
      "MATERIALIZATION_OUTPUT_NOT_SERIALIZABLE",
      { cause: error },
    );
  }
  const validated = validateClassifierOutput(serialized, input, hasher);
  if (!validated.ok) {
    throw new SubjectMaterializationError(
      `MATERIALIZATION_OUTPUT_${validated.code}`,
    );
  }
  assertDecisionMatchesOutput(decision, validated.output);
  assertEvidenceMatches(decision, validated.evidenceSpans);
  return validated.output;
};

const materializationUrl = (
  id: string,
  input: BoundedClassifierInput,
  hasher: Hasher,
): MaterializationUrlCandidate | null => {
  const candidate = input.urlCandidates.find((value) => value.id === id);
  if (candidate === undefined) {
    throw new SubjectMaterializationError("MATERIALIZATION_URL_UNKNOWN");
  }
  const normalized = normalizeSubjectUrl(candidate.url);
  if (!normalized.ok) {
    return null;
  }
  const ordinal = Number.parseInt(id.slice("url:".length), 10);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new SubjectMaterializationError("MATERIALIZATION_URL_ID_INVALID");
  }
  return {
    classifierId: candidate.id,
    rawUrl: candidate.url,
    canonicalUrl: normalized.value.canonicalUrl,
    sourceDocument: candidate.sourceDocument,
    originField: candidate.originField,
    scheme: normalized.value.scheme,
    host: normalized.value.host,
    contentHash: hasher.sha256(candidate.url),
    sourceOrdinal: ordinal,
  };
};

const aliasesFor = (
  discovery: ClassificationV1["discoveries"][number],
  identity: SubjectIdentity,
): MaterializedSubjectInput["aliases"] => {
  const byNormalized = new Map<string, string>();
  for (const alias of discovery.aliases) {
    const normalized = normalizeSubjectName(alias);
    if (
      normalized !== identity.normalizedName &&
      !byNormalized.has(normalized)
    ) {
      byNormalized.set(normalized, alias.normalize("NFKC").trim());
    }
  }
  return identity.normalizedAliases.map((normalized) => ({
    value: byNormalized.get(normalized) ?? normalized,
    normalized,
  }));
};

const prepareSubjects = (
  output: ClassificationV1,
  input: BoundedClassifierInput,
  decision: ContentDecision,
  hasher: Hasher,
): {
  readonly subjects: readonly PreparedSubject[];
  readonly missing: readonly number[];
  readonly ambiguous: readonly number[];
  readonly invalid: readonly number[];
} => {
  const subjects: PreparedSubject[] = [];
  const missing: number[] = [];
  const ambiguous: number[] = [];
  const invalid: number[] = [];
  output.discoveries.forEach((discovery, sourceOrdinal) => {
    let candidate: MaterializationUrlCandidate | null = null;
    if (discovery.url_candidate_ids.length === 0) {
      missing.push(sourceOrdinal);
    } else if (discovery.url_candidate_ids.length > 1) {
      ambiguous.push(sourceOrdinal);
    } else {
      candidate = materializationUrl(
        discovery.url_candidate_ids[0] as string,
        input,
        hasher,
      );
      if (candidate === null) {
        invalid.push(sourceOrdinal);
      }
    }
    const localKey = `discovery:${sourceOrdinal}`;
    const identity = createSubjectIdentity(
      {
        name: discovery.name,
        aliases: discovery.aliases,
        subjectType: discovery.subject_type,
        canonicalUrl: candidate?.canonicalUrl ?? null,
        verifiedOfficialDomain: null,
        disambiguatingRootId: input.rootId,
        provenanceKey: `decision:${decision.id}:${localKey}`,
      },
      hasher,
    );
    subjects.push({
      localKey,
      identity,
      input: {
        localKey,
        identity,
        name: discovery.name.normalize("NFKC").trim(),
        aliases: aliasesFor(discovery, identity),
        canonicalUrlCandidate: candidate,
      },
    });
  });
  return { subjects, missing, ambiguous, invalid };
};

const includesNormalizedName = (
  subject: PreparedSubject,
  normalizedName: string,
): boolean =>
  subject.identity.normalizedName === normalizedName ||
  subject.identity.normalizedAliases.includes(normalizedName);

const resolveRelatedSubjects = async (
  output: ClassificationV1,
  preparedSubjects: readonly PreparedSubject[],
  contextKey: string,
  repository: SubjectMaterializationRepository,
): Promise<{
  readonly localKeys: readonly string[];
  readonly ids: readonly SubjectId[];
  readonly unresolved: readonly string[];
}> => {
  const note = output.expert_note;
  if (note === null || note.related_subject_names.length === 0) {
    return { localKeys: [], ids: [], unresolved: [] };
  }
  const normalized = note.related_subject_names.map(normalizeSubjectName);
  const matches = await repository.findNameMatches(normalized, contextKey);
  const localKeys = new Set<string>();
  const ids = new Set<SubjectId>();
  const unresolved: string[] = [];
  note.related_subject_names.forEach((name, index) => {
    const normalizedName = normalized[index];
    if (normalizedName === undefined) {
      throw new SubjectMaterializationError(
        "MATERIALIZATION_RELATED_NAME_DRIFT",
      );
    }
    const local = preparedSubjects.filter((subject) =>
      includesNormalizedName(subject, normalizedName),
    );
    const localDedupKeys = new Set(
      local.map((subject) => subject.identity.dedupKey),
    );
    if (localDedupKeys.size === 1 && local[0] !== undefined) {
      localKeys.add(local[0].localKey);
      return;
    }
    if (localDedupKeys.size > 1) {
      unresolved.push(name);
      return;
    }
    const existing = matches.filter(
      (subject) =>
        subject.normalizedName === normalizedName ||
        subject.normalizedAliases.includes(normalizedName),
    );
    const existingIds = [...new Set(existing.map((subject) => subject.id))];
    if (existingIds.length === 1 && existingIds[0] !== undefined) {
      ids.add(existingIds[0]);
    } else {
      unresolved.push(name);
    }
  });
  return {
    localKeys: [...localKeys],
    ids: [...ids],
    unresolved,
  };
};

const hasNameOnlyMergeSuggestion = async (
  preparedSubjects: readonly PreparedSubject[],
  repository: SubjectMaterializationRepository,
): Promise<boolean> => {
  const candidates = preparedSubjects.filter(
    (subject) => subject.identity.basis === "NAME_CONTEXT",
  );
  if (candidates.length === 0) {
    return false;
  }
  const names = [
    ...new Set(
      candidates.flatMap((subject) => [
        subject.identity.normalizedName,
        ...subject.identity.normalizedAliases,
      ]),
    ),
  ];
  const matches = await repository.findNameMatches(names, null);
  return candidates.some((candidate) => {
    const candidateNames = new Set([
      candidate.identity.normalizedName,
      ...candidate.identity.normalizedAliases,
    ]);
    return matches.some(
      (match) =>
        match.type === candidate.identity.subjectType &&
        match.dedupKey !== candidate.identity.dedupKey &&
        [match.normalizedName, ...match.normalizedAliases].some((name) =>
          candidateNames.has(name),
        ),
    );
  });
};

const discoveryIdentityKey = (
  decision: ContentDecision,
  subject: PreparedSubject,
  sourceOrdinal: number,
  rootStoryOnly: boolean,
  input: BoundedClassifierInput,
  hasher: Hasher,
): string => {
  const identity = rootStoryOnly
    ? `${input.rootId}\u0000${subject.identity.dedupKey}\u0000${SUBJECT_EXTRACTION_VERSION}`
    : `${decision.id}\u0000${sourceOrdinal}\u0000${SUBJECT_EXTRACTION_VERSION}`;
  const prefix = rootStoryOnly ? "discovery:root:" : "discovery:comment:";
  return `${prefix}${hasher.sha256(identity)}`;
};

export const createMaterializeClassification =
  (
    classifications: ClassificationRepository,
    subjects: SubjectMaterializationRepository,
    hasher: Hasher,
    reviewQueue: SubjectMaterializationReviewQueue | null = null,
  ): MaterializeClassification =>
  async (decisionId) => {
    const source = await subjects.loadSource(decisionId);
    if (source === null) {
      throw new SubjectMaterializationError(
        "MATERIALIZATION_DECISION_NOT_FOUND",
      );
    }
    const input = await loadClassifierInput(
      source.decision.commentId,
      classifications,
      hasher,
    );
    if (input.rootId !== source.resolvedRootId) {
      throw new SubjectMaterializationError("MATERIALIZATION_ROOT_DRIFT");
    }
    if (source.decision.source === "MODEL") {
      const runId = source.decision.classificationRunId;
      if (runId === null) {
        throw new SubjectMaterializationError("MATERIALIZATION_RUN_MISSING");
      }
      const run = await classifications.getRun(runId);
      if (
        run === null ||
        run.commentId !== source.decision.commentId ||
        run.schemaVersion !== "classification.v1" ||
        (run.status !== "SUCCEEDED" && run.status !== "REVIEW")
      ) {
        throw new SubjectMaterializationError("MATERIALIZATION_RUN_INVALID");
      }
      if (hasher.sha256(JSON.stringify(input)) !== run.inputHash) {
        throw new SubjectMaterializationError("MATERIALIZATION_INPUT_DRIFT");
      }
    } else if (source.decision.classificationRunId !== null) {
      throw new SubjectMaterializationError("MATERIALIZATION_RUN_INVALID");
    }
    const output = validateStoredOutput(source.decision, input, hasher);
    const prepared = prepareSubjects(output, input, source.decision, hasher);
    const nameOnlyMergeSuggestion = await hasNameOnlyMergeSuggestion(
      prepared.subjects,
      subjects,
    );
    const related = await resolveRelatedSubjects(
      output,
      prepared.subjects,
      `root:${input.rootId}`,
      subjects,
    );
    const stored = await subjects.materialize({
      decisionId: source.decision.id,
      commentId: source.decision.commentId,
      resolvedRootId: source.resolvedRootId,
      extractionVersion: SUBJECT_EXTRACTION_VERSION,
      urlCandidates: input.urlCandidates.flatMap((candidate) => {
        const normalized = materializationUrl(candidate.id, input, hasher);
        return normalized === null ? [] : [normalized];
      }),
      subjects: prepared.subjects.map((subject) => subject.input),
      mentions: output.discoveries.map((discovery, sourceOrdinal) => ({
        subjectLocalKey: `discovery:${sourceOrdinal}`,
        existingSubjectId: null,
        sourceKind: "DISCOVERY",
        sourceOrdinal,
        evidenceOrigin: discovery.evidence_origin,
        confidence: discovery.confidence,
        evidenceSpanIds: discovery.evidence_span_ids,
      })),
      discoveries: output.discoveries.map((discovery, sourceOrdinal) => {
        const subject = prepared.subjects[sourceOrdinal];
        if (subject === undefined) {
          throw new SubjectMaterializationError(
            "MATERIALIZATION_SUBJECT_ORDINAL_DRIFT",
          );
        }
        return {
          subjectLocalKey: subject.localKey,
          sourceOrdinal,
          identityKey: discoveryIdentityKey(
            source.decision,
            subject,
            sourceOrdinal,
            discovery.root_story_only,
            input,
            hasher,
          ),
          rootStoryOnly: discovery.root_story_only,
          descriptionClaim: discovery.description_claim,
          evidenceOrigin: discovery.evidence_origin,
          confidence: discovery.confidence,
          evidenceSpanIds: discovery.evidence_span_ids,
        };
      }),
      expertNote:
        output.expert_note === null
          ? null
          : {
              noteType: output.expert_note.note_type,
              title: output.expert_note.title.normalize("NFKC").trim(),
              summary: output.expert_note.summary.normalize("NFKC").trim(),
              relatedSubjectNames: output.expert_note.related_subject_names.map(
                (name) => name.normalize("NFKC").trim(),
              ),
              evidenceOrigin: output.expert_note.evidence_origin,
              confidence: output.expert_note.confidence,
              evidenceSpanIds: output.expert_note.evidence_span_ids,
              subjectLocalKeys: related.localKeys,
              subjectIds: related.ids,
            },
    });
    if (reviewQueue !== null) {
      const urlReasons = [
        ...(prepared.ambiguous.length > 0
          ? (["AMBIGUOUS_CANONICAL_URL"] as const)
          : []),
        ...(prepared.missing.length > 0 || prepared.invalid.length > 0
          ? (["MISSING_CANONICAL_URL"] as const)
          : []),
      ];
      if (urlReasons.length > 0) {
        await reviewQueue.openActionReview({
          commentId: source.decision.commentId,
          contentDecisionId: source.decision.id,
          kind: "URL_RESOLUTION",
          policy: reviewPolicyFromReasons(urlReasons),
        });
      }
      if (nameOnlyMergeSuggestion) {
        await reviewQueue.openActionReview({
          commentId: source.decision.commentId,
          contentDecisionId: source.decision.id,
          kind: "SUBJECT_MERGE",
          policy: reviewPolicyFromReasons(["NAME_ONLY_MERGE_SUGGESTION"]),
        });
      }
    }
    return {
      decisionId: source.decision.id,
      ...stored,
      missingUrlDiscoveryOrdinals: prepared.missing,
      ambiguousUrlDiscoveryOrdinals: prepared.ambiguous,
      invalidUrlDiscoveryOrdinals: prepared.invalid,
      unresolvedRelatedSubjectNames: related.unresolved,
    };
  };
