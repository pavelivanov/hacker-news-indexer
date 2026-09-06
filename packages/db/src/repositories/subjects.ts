import {
  withTransaction,
  isTransactionClient,
  type RepositoryClient,
} from "../transaction-context.js";
import type { ContentDecision, SubjectId } from "@hn-knowledge/domain";
import {
  classificationRunId,
  contentDecisionId,
  hnItemId,
  subjectId,
} from "@hn-knowledge/domain";
import type {
  MaterializationUrlCandidate,
  MaterializeClassificationInput,
  MaterializeClassificationResult,
  SubjectMaterializationRepository,
} from "@hn-knowledge/ports";

import type { EvidenceSpan as DatabaseEvidenceSpan } from "../generated/prisma/client.js";
import { Prisma } from "../generated/prisma/client.js";

type MaterializationClient = Prisma.TransactionClient;
type DatabaseDecision = Prisma.ContentDecisionGetPayload<{
  include: { evidenceSpans: true };
}>;

const hasPrismaErrorCode = (error: unknown, code: string): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === code;

const requiredText = (
  value: string,
  field: string,
  maximum: number,
): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TypeError(`${field} must contain 1 to ${maximum} characters`);
  }
  return normalized;
};

const confidence = (value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError("confidence must be between 0 and 1");
  }
  return value;
};

const ordinal = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("sourceOrdinal must be a non-negative safe integer");
  }
  return value;
};

const toEvidence = (
  span: DatabaseEvidenceSpan,
): ContentDecision["evidenceSpans"][number] => ({
  id: span.id,
  contentDecisionId: contentDecisionId(span.contentDecisionId),
  spanId: span.spanId,
  sourceDocument: span.sourceDocument,
  origin: span.origin,
  start: span.startOffset,
  end: span.endOffset,
  textHash: span.textHash,
  createdAt: span.createdAt,
});

const toDecision = (decision: DatabaseDecision): ContentDecision => ({
  id: contentDecisionId(decision.id),
  commentId: hnItemId(Number(decision.commentId)),
  classificationRunId:
    decision.classificationRunId === null
      ? null
      : classificationRunId(decision.classificationRunId),
  source: decision.source,
  primaryDecision: decision.primaryDecision,
  decisionConfidence: decision.decisionConfidence,
  materiallyTechnical: decision.materiallyTechnical,
  reviewRequired: decision.reviewRequired,
  validatedOutput: decision.validatedOutput,
  manualOverrideOfId:
    decision.manualOverrideOfId === null
      ? null
      : contentDecisionId(decision.manualOverrideOfId),
  evidenceSpans: decision.evidenceSpans.map(toEvidence),
  createdAt: decision.createdAt,
});

const evidenceIds = (
  values: readonly string[],
  storedBySpanId: ReadonlyMap<
    string,
    { readonly id: string; readonly origin: "COMMENT" | "ROOT_STORY" }
  >,
  expectedOrigin: "COMMENT" | "ROOT_STORY" | "BOTH",
): readonly string[] => {
  if (new Set(values).size !== values.length) {
    throw new TypeError("Materialized evidence span IDs must be unique");
  }
  const ids = values.map((value) => {
    const span = storedBySpanId.get(value);
    if (span === undefined) {
      throw new TypeError(
        `Evidence span does not belong to the decision: ${value}`,
      );
    }
    return span.id;
  });
  const origins = new Set(
    values.map((value) => storedBySpanId.get(value)?.origin),
  );
  const actualOrigin =
    origins.size === 2
      ? "BOTH"
      : origins.has("COMMENT")
        ? "COMMENT"
        : origins.has("ROOT_STORY")
          ? "ROOT_STORY"
          : null;
  if (actualOrigin !== expectedOrigin) {
    throw new TypeError("Materialized evidence origin does not match spans");
  }
  return ids;
};

const sourceHnItemId = (
  candidate: MaterializationUrlCandidate,
  input: MaterializeClassificationInput,
): bigint => {
  const match = /^hn:item:([1-9][0-9]*)$/u.exec(candidate.sourceDocument);
  if (match?.[1] === undefined) {
    throw new TypeError("URL candidate source document must be an HN item");
  }
  const id = BigInt(match[1]);
  if (id !== BigInt(input.commentId) && id !== BigInt(input.resolvedRootId)) {
    throw new TypeError("URL candidate source is outside materialized context");
  }
  return id;
};

const sameStringSet = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  [...left].sort().every((value, index) => value === [...right].sort()[index]);

const assertInputShape = (input: MaterializeClassificationInput): void => {
  requiredText(input.extractionVersion, "extractionVersion", 128);
  const candidateIds = input.urlCandidates.map((candidate) => {
    requiredText(candidate.classifierId, "URL classifierId", 64);
    ordinal(candidate.sourceOrdinal);
    return candidate.classifierId;
  });
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new TypeError("Materialized URL candidate IDs must be unique");
  }
  const localKeys = input.subjects.map((subject) =>
    requiredText(subject.localKey, "subject localKey", 128),
  );
  if (new Set(localKeys).size !== localKeys.length) {
    throw new TypeError("Subject local keys must be unique");
  }
  for (const mention of input.mentions) {
    const references =
      Number(mention.subjectLocalKey !== null) +
      Number(mention.existingSubjectId !== null);
    if (references !== 1) {
      throw new TypeError(
        "A subject mention must have exactly one subject reference",
      );
    }
    ordinal(mention.sourceOrdinal);
    confidence(mention.confidence);
  }
  const mentionKeys = input.mentions.map(
    (mention) =>
      `${mention.sourceKind}\u0000${mention.sourceOrdinal}\u0000${mention.subjectLocalKey ?? mention.existingSubjectId ?? ""}`,
  );
  if (new Set(mentionKeys).size !== mentionKeys.length) {
    throw new TypeError("Subject mention identities must be unique");
  }
  const discoveryOrdinals = new Set<number>();
  for (const discovery of input.discoveries) {
    ordinal(discovery.sourceOrdinal);
    confidence(discovery.confidence);
    requiredText(discovery.identityKey, "discovery identityKey", 96);
    requiredText(discovery.descriptionClaim, "descriptionClaim", 1_000);
    if (discoveryOrdinals.has(discovery.sourceOrdinal)) {
      throw new TypeError("Discovery source ordinals must be unique");
    }
    discoveryOrdinals.add(discovery.sourceOrdinal);
  }
  if (input.expertNote !== null) {
    confidence(input.expertNote.confidence);
    requiredText(input.expertNote.title, "expert note title", 200);
    requiredText(input.expertNote.summary, "expert note summary", 2_000);
    if (input.expertNote.relatedSubjectNames.length > 12) {
      throw new TypeError("Expert note related subjects must not exceed 12");
    }
    if (
      new Set(input.expertNote.subjectLocalKeys).size !==
        input.expertNote.subjectLocalKeys.length ||
      new Set(input.expertNote.subjectIds).size !==
        input.expertNote.subjectIds.length
    ) {
      throw new TypeError("Expert note subject references must be unique");
    }
  }
};

const ensureUrlCandidate = async (
  transaction: MaterializationClient,
  candidate: MaterializationUrlCandidate,
  input: MaterializeClassificationInput,
): Promise<string> => {
  requiredText(candidate.classifierId, "URL classifierId", 64);
  requiredText(candidate.rawUrl, "URL rawUrl", 2_048);
  requiredText(candidate.canonicalUrl, "URL canonicalUrl", 2_048);
  requiredText(candidate.sourceDocument, "URL sourceDocument", 256);
  requiredText(candidate.originField, "URL originField", 128);
  requiredText(candidate.host, "URL host", 253);
  requiredText(candidate.contentHash, "URL contentHash", 256);
  ordinal(candidate.sourceOrdinal);
  const hnItemId = sourceHnItemId(candidate, input);
  const existing = await transaction.urlCandidate.findFirst({
    where: {
      canonicalUrl: candidate.canonicalUrl,
      sourceDocument: candidate.sourceDocument,
      originField: candidate.originField,
      sourceOrdinal: candidate.sourceOrdinal,
    },
    orderBy: [{ classifierEligible: "desc" }, { id: "asc" }],
  });
  if (existing !== null) {
    if (
      existing.hnItemId !== hnItemId ||
      existing.scheme !== candidate.scheme ||
      existing.host !== candidate.host
    ) {
      throw new Error("URL_CANDIDATE_PROVENANCE_CONFLICT");
    }
    return existing.id;
  }
  const stored = await transaction.urlCandidate.upsert({
    where: {
      contentHash_sourceDocument_originField_sourceOrdinal: {
        contentHash: candidate.contentHash,
        sourceDocument: candidate.sourceDocument,
        originField: candidate.originField,
        sourceOrdinal: candidate.sourceOrdinal,
      },
    },
    create: {
      hnItemId,
      rawUrl: candidate.rawUrl,
      canonicalUrl: candidate.canonicalUrl,
      sourceDocument: candidate.sourceDocument,
      originField: candidate.originField,
      scheme: candidate.scheme,
      host: candidate.host,
      validationState: "VALID",
      contentHash: candidate.contentHash,
      sourceOrdinal: candidate.sourceOrdinal,
      classifierEligible: false,
    },
    update: {},
  });
  if (
    stored.canonicalUrl !== candidate.canonicalUrl ||
    stored.hnItemId !== hnItemId ||
    stored.scheme !== candidate.scheme ||
    stored.host !== candidate.host
  ) {
    throw new Error("URL_CANDIDATE_IDEMPOTENCY_CONFLICT");
  }
  return stored.id;
};

const ensureSubject = async (
  transaction: MaterializationClient,
  input: MaterializeClassificationInput,
  subject: MaterializeClassificationInput["subjects"][number],
): Promise<string> => {
  requiredText(subject.name, "subject name", 160);
  requiredText(subject.identity.normalizedName, "normalized subject name", 160);
  requiredText(subject.identity.dedupKey, "subject dedupKey", 96);
  requiredText(subject.identity.contextKey, "subject contextKey", 256);
  const candidateId =
    subject.canonicalUrlCandidate === null
      ? null
      : await ensureUrlCandidate(
          transaction,
          subject.canonicalUrlCandidate,
          input,
        );
  const existing = await transaction.subject.findUnique({
    where: { dedupKey: subject.identity.dedupKey },
    include: {
      canonicalUrlCandidate: { select: { canonicalUrl: true } },
    },
  });
  if (existing !== null) {
    const basisMatches =
      existing.identityBasis === subject.identity.basis &&
      ((subject.identity.basis === "ECOSYSTEM_COORDINATE" &&
        existing.ecosystemCoordinate ===
          subject.identity.ecosystemCoordinate) ||
        (subject.identity.basis === "CANONICAL_URL" &&
          existing.canonicalUrlCandidate?.canonicalUrl ===
            subject.identity.canonicalUrl) ||
        (subject.identity.basis === "OFFICIAL_DOMAIN" &&
          existing.officialDomain === subject.identity.officialDomain) ||
        (subject.identity.basis === "NAME_CONTEXT" &&
          existing.normalizedName === subject.identity.normalizedName &&
          existing.type === subject.identity.subjectType &&
          existing.contextKey === subject.identity.contextKey));
    if (existing.lifecycleState !== "ACTIVE" || !basisMatches) {
      throw new Error("SUBJECT_IDENTITY_CONFLICT");
    }
    if (existing.normalizedName !== subject.identity.normalizedName) {
      await transaction.subjectAlias.createMany({
        data: [
          {
            subjectId: existing.id,
            alias: subject.name,
            normalizedAlias: subject.identity.normalizedName,
            contentDecisionId: input.decisionId,
          },
        ],
        skipDuplicates: true,
      });
    }
    return existing.id;
  }
  const created = await transaction.subject.create({
    data: {
      type: subject.identity.subjectType,
      name: subject.name,
      normalizedName: subject.identity.normalizedName,
      dedupKey: subject.identity.dedupKey,
      identityBasis: subject.identity.basis,
      ecosystemCoordinate: subject.identity.ecosystemCoordinate,
      canonicalUrlCandidateId: candidateId,
      officialDomain: subject.identity.officialDomain,
      contextKey: subject.identity.contextKey,
      createdFromDecisionId: input.decisionId,
    },
  });
  return created.id;
};

const ensureAliases = async (
  transaction: MaterializationClient,
  decisionId: string,
  subjectId: string,
  aliases: MaterializeClassificationInput["subjects"][number]["aliases"],
): Promise<void> => {
  const normalized = new Set<string>();
  for (const alias of aliases) {
    requiredText(alias.value, "subject alias", 160);
    requiredText(alias.normalized, "normalized subject alias", 160);
    if (normalized.has(alias.normalized)) {
      throw new TypeError("Normalized subject aliases must be unique");
    }
    normalized.add(alias.normalized);
  }
  if (aliases.length === 0) {
    return;
  }
  await transaction.subjectAlias.createMany({
    data: aliases.map((alias) => ({
      subjectId,
      alias: alias.value,
      normalizedAlias: alias.normalized,
      contentDecisionId: decisionId,
    })),
    skipDuplicates: true,
  });
};

const resolveSubjectReference = (
  localSubjectIds: ReadonlyMap<string, string>,
  localKey: string | null,
  existingId: SubjectId | null,
): string => {
  if (existingId !== null) {
    return existingId;
  }
  const id = localKey === null ? undefined : localSubjectIds.get(localKey);
  if (id === undefined) {
    throw new TypeError(`Unknown local subject key: ${localKey ?? "null"}`);
  }
  return id;
};

const ensureReferencedSubjectsActive = async (
  transaction: MaterializationClient,
  ids: readonly string[],
): Promise<void> => {
  if (ids.length === 0) {
    return;
  }
  const active = await transaction.subject.count({
    where: { id: { in: [...ids] }, lifecycleState: "ACTIVE" },
  });
  if (active !== new Set(ids).size) {
    throw new TypeError("Expert note references an unavailable subject");
  }
};

const ensureMention = async (
  transaction: MaterializationClient,
  input: MaterializeClassificationInput,
  localSubjectIds: ReadonlyMap<string, string>,
  storedEvidence: ReadonlyMap<
    string,
    { readonly id: string; readonly origin: "COMMENT" | "ROOT_STORY" }
  >,
  mention: MaterializeClassificationInput["mentions"][number],
): Promise<void> => {
  const resolvedSubjectId = resolveSubjectReference(
    localSubjectIds,
    mention.subjectLocalKey,
    mention.existingSubjectId,
  );
  const evidence = evidenceIds(
    mention.evidenceSpanIds,
    storedEvidence,
    mention.evidenceOrigin,
  );
  const existing = await transaction.subjectMention.findUnique({
    where: {
      contentDecisionId_sourceKind_sourceOrdinal_subjectId: {
        contentDecisionId: input.decisionId,
        sourceKind: mention.sourceKind,
        sourceOrdinal: mention.sourceOrdinal,
        subjectId: resolvedSubjectId,
      },
    },
  });
  if (existing !== null) {
    if (
      existing.selectedCommentId !== BigInt(input.commentId) ||
      existing.evidenceOrigin !== mention.evidenceOrigin ||
      existing.confidence !== mention.confidence ||
      existing.extractionVersion !== input.extractionVersion
    ) {
      throw new Error("SUBJECT_MENTION_IDEMPOTENCY_CONFLICT");
    }
    await transaction.subjectMentionEvidence.createMany({
      data: evidence.map((evidenceSpanId) => ({
        subjectMentionId: existing.id,
        evidenceSpanId,
      })),
      skipDuplicates: true,
    });
    return;
  }
  await transaction.subjectMention.create({
    data: {
      subjectId: resolvedSubjectId,
      selectedCommentId: BigInt(input.commentId),
      contentDecisionId: input.decisionId,
      sourceKind: mention.sourceKind,
      sourceOrdinal: mention.sourceOrdinal,
      evidenceOrigin: mention.evidenceOrigin,
      confidence: mention.confidence,
      extractionVersion: input.extractionVersion,
      evidenceSpans: {
        create: evidence.map((evidenceSpanId) => ({ evidenceSpanId })),
      },
    },
  });
};

const ensureDiscovery = async (
  transaction: MaterializationClient,
  input: MaterializeClassificationInput,
  localSubjectIds: ReadonlyMap<string, string>,
  storedEvidence: ReadonlyMap<
    string,
    { readonly id: string; readonly origin: "COMMENT" | "ROOT_STORY" }
  >,
  discovery: MaterializeClassificationInput["discoveries"][number],
): Promise<void> => {
  const resolvedSubjectId = localSubjectIds.get(discovery.subjectLocalKey);
  if (resolvedSubjectId === undefined) {
    throw new TypeError(
      `Unknown discovery subject key: ${discovery.subjectLocalKey}`,
    );
  }
  if (discovery.rootStoryOnly !== (discovery.evidenceOrigin === "ROOT_STORY")) {
    throw new TypeError("Root-only discovery origin is inconsistent");
  }
  const evidence = evidenceIds(
    discovery.evidenceSpanIds,
    storedEvidence,
    discovery.evidenceOrigin,
  );
  const resolvedRootId = discovery.rootStoryOnly
    ? BigInt(input.resolvedRootId)
    : null;
  let stored = await transaction.discovery.findUnique({
    where: { identityKey: discovery.identityKey },
  });
  if (stored === null) {
    stored = await transaction.discovery.create({
      data: {
        subjectId: resolvedSubjectId,
        resolvedRootId,
        identityKey: discovery.identityKey,
        rootStoryOnly: discovery.rootStoryOnly,
        extractionVersion: input.extractionVersion,
      },
    });
  } else if (
    stored.subjectId !== resolvedSubjectId ||
    stored.resolvedRootId !== resolvedRootId ||
    stored.rootStoryOnly !== discovery.rootStoryOnly ||
    stored.extractionVersion !== input.extractionVersion
  ) {
    throw new Error("DISCOVERY_IDENTITY_CONFLICT");
  }
  const existingSource = await transaction.discoverySource.findUnique({
    where: {
      contentDecisionId_sourceOrdinal: {
        contentDecisionId: input.decisionId,
        sourceOrdinal: discovery.sourceOrdinal,
      },
    },
  });
  if (existingSource !== null) {
    if (
      existingSource.discoveryId !== stored.id ||
      existingSource.selectedCommentId !== BigInt(input.commentId) ||
      existingSource.descriptionClaim !== discovery.descriptionClaim ||
      existingSource.evidenceOrigin !== discovery.evidenceOrigin ||
      existingSource.confidence !== discovery.confidence
    ) {
      throw new Error("DISCOVERY_SOURCE_IDEMPOTENCY_CONFLICT");
    }
    await transaction.discoverySourceEvidence.createMany({
      data: evidence.map((evidenceSpanId) => ({
        discoverySourceId: existingSource.id,
        evidenceSpanId,
      })),
      skipDuplicates: true,
    });
    return;
  }
  await transaction.discoverySource.create({
    data: {
      discoveryId: stored.id,
      selectedCommentId: BigInt(input.commentId),
      contentDecisionId: input.decisionId,
      sourceOrdinal: discovery.sourceOrdinal,
      descriptionClaim: discovery.descriptionClaim,
      evidenceOrigin: discovery.evidenceOrigin,
      confidence: discovery.confidence,
      evidenceSpans: {
        create: evidence.map((evidenceSpanId) => ({ evidenceSpanId })),
      },
    },
  });
  await transaction.discovery.updateMany({
    where: { id: stored.id, status: "SUPERSEDED" },
    data: {
      status: "REVIEW_PENDING",
      publicationRevision: { increment: 1 },
    },
  });
};

const ensureExpertNote = async (
  transaction: MaterializationClient,
  input: MaterializeClassificationInput,
  localSubjectIds: ReadonlyMap<string, string>,
  storedEvidence: ReadonlyMap<
    string,
    { readonly id: string; readonly origin: "COMMENT" | "ROOT_STORY" }
  >,
): Promise<void> => {
  const note = input.expertNote;
  if (note === null) {
    return;
  }
  const relatedIds = [
    ...note.subjectIds,
    ...note.subjectLocalKeys.map((key) => {
      const id = localSubjectIds.get(key);
      if (id === undefined) {
        throw new TypeError(`Unknown expert-note subject key: ${key}`);
      }
      return id;
    }),
  ];
  const uniqueRelatedIds = [...new Set(relatedIds)].sort();
  await ensureReferencedSubjectsActive(transaction, uniqueRelatedIds);
  const evidence = evidenceIds(
    note.evidenceSpanIds,
    storedEvidence,
    note.evidenceOrigin,
  );
  const existing = await transaction.expertNote.findUnique({
    where: {
      contentDecisionId_extractionVersion: {
        contentDecisionId: input.decisionId,
        extractionVersion: input.extractionVersion,
      },
    },
    include: {
      subjects: { select: { subjectId: true } },
      evidenceSpans: { select: { evidenceSpanId: true } },
    },
  });
  if (existing !== null) {
    if (
      existing.selectedCommentId !== BigInt(input.commentId) ||
      existing.noteType !== note.noteType ||
      existing.title !== note.title ||
      existing.summary !== note.summary ||
      !sameStringSet(existing.relatedSubjectNames, note.relatedSubjectNames) ||
      existing.evidenceOrigin !== note.evidenceOrigin ||
      existing.confidence !== note.confidence ||
      !sameStringSet(
        existing.subjects.map((value) => value.subjectId),
        uniqueRelatedIds,
      ) ||
      !sameStringSet(
        existing.evidenceSpans.map((value) => value.evidenceSpanId),
        evidence,
      )
    ) {
      throw new Error("EXPERT_NOTE_IDEMPOTENCY_CONFLICT");
    }
    return;
  }
  await transaction.expertNote.create({
    data: {
      selectedCommentId: BigInt(input.commentId),
      contentDecisionId: input.decisionId,
      noteType: note.noteType,
      title: note.title,
      summary: note.summary,
      relatedSubjectNames: [...note.relatedSubjectNames],
      evidenceOrigin: note.evidenceOrigin,
      confidence: note.confidence,
      extractionVersion: input.extractionVersion,
      subjects: {
        create: uniqueRelatedIds.map((relatedSubjectId) => ({
          subjectId: relatedSubjectId,
        })),
      },
      evidenceSpans: {
        create: evidence.map((evidenceSpanId) => ({ evidenceSpanId })),
      },
    },
  });
};

const runMaterialization = async (
  transaction: MaterializationClient,
  input: MaterializeClassificationInput,
): Promise<MaterializeClassificationResult> => {
  const decision = await transaction.contentDecision.findUnique({
    where: { id: input.decisionId },
    include: {
      evidenceSpans: true,
      comment: {
        select: {
          rootId: true,
          resolutionPath: { select: { resolvedRootId: true } },
        },
      },
    },
  });
  if (decision === null) {
    throw new TypeError("MATERIALIZATION_DECISION_NOT_FOUND");
  }
  const storedRootId =
    decision.comment.resolutionPath?.resolvedRootId ?? decision.comment.rootId;
  if (
    decision.commentId !== BigInt(input.commentId) ||
    storedRootId !== BigInt(input.resolvedRootId)
  ) {
    throw new TypeError("MATERIALIZATION_SOURCE_MISMATCH");
  }
  const storedEvidence = new Map(
    decision.evidenceSpans.map((span) => [
      span.spanId,
      { id: span.id, origin: span.origin },
    ]),
  );
  const localSubjectIds = new Map<string, string>();
  for (const candidate of input.urlCandidates) {
    await ensureUrlCandidate(transaction, candidate, input);
  }
  for (const subject of input.subjects) {
    const id = await ensureSubject(transaction, input, subject);
    localSubjectIds.set(subject.localKey, id);
    await ensureAliases(transaction, input.decisionId, id, subject.aliases);
  }
  await ensureReferencedSubjectsActive(
    transaction,
    input.mentions.flatMap((mention) =>
      mention.existingSubjectId === null ? [] : [mention.existingSubjectId],
    ),
  );
  for (const mention of input.mentions) {
    await ensureMention(
      transaction,
      input,
      localSubjectIds,
      storedEvidence,
      mention,
    );
  }
  for (const discovery of input.discoveries) {
    await ensureDiscovery(
      transaction,
      input,
      localSubjectIds,
      storedEvidence,
      discovery,
    );
  }
  await ensureExpertNote(transaction, input, localSubjectIds, storedEvidence);
  return {
    subjects: new Set(localSubjectIds.values()).size,
    mentions: input.mentions.length,
    discoveries: new Set(
      input.discoveries.map((discovery) => discovery.identityKey),
    ).size,
    discoverySources: input.discoveries.length,
    expertNotes: input.expertNote === null ? 0 : 1,
  };
};

export const createSubjectMaterializationRepository = (
  client: RepositoryClient,
): SubjectMaterializationRepository => ({
  async loadSource(decisionId) {
    const decision = await client.contentDecision.findUnique({
      where: { id: decisionId },
      include: {
        evidenceSpans: true,
        comment: {
          select: {
            rootId: true,
            resolutionPath: { select: { resolvedRootId: true } },
          },
        },
      },
    });
    if (decision === null) {
      return null;
    }
    const resolvedRootId =
      decision.comment.resolutionPath?.resolvedRootId ??
      decision.comment.rootId;
    return {
      decision: toDecision(decision),
      resolvedRootId: hnItemId(Number(resolvedRootId)),
    };
  },

  async findNameMatches(normalizedNames, contextKey) {
    const names = [...new Set(normalizedNames)];
    if (names.length === 0) {
      return [];
    }
    for (const name of names) {
      requiredText(name, "normalized subject name", 160);
    }
    if (contextKey !== null) {
      requiredText(contextKey, "subject contextKey", 256);
    }
    const subjects = await client.subject.findMany({
      where: {
        lifecycleState: "ACTIVE",
        ...(contextKey === null ? {} : { contextKey }),
        OR: [
          { normalizedName: { in: names } },
          { aliases: { some: { normalizedAlias: { in: names } } } },
        ],
      },
      include: { aliases: { select: { normalizedAlias: true } } },
      orderBy: { id: "asc" },
    });
    return subjects.map((subject) => ({
      id: subjectId(subject.id),
      type: subject.type,
      normalizedName: subject.normalizedName,
      normalizedAliases: subject.aliases.map((alias) => alias.normalizedAlias),
      contextKey: subject.contextKey,
      dedupKey: subject.dedupKey,
    }));
  },

  async materialize(input) {
    assertInputShape(input);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await withTransaction(
          client,
          (transaction) => runMaterialization(transaction, input),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (isTransactionClient(client)) throw error;
        if (
          attempt === 0 &&
          (hasPrismaErrorCode(error, "P2002") ||
            hasPrismaErrorCode(error, "P2034"))
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error("MATERIALIZATION_RETRY_EXHAUSTED");
  },
});
