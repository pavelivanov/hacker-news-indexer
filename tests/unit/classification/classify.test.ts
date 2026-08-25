import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FixtureClassifier } from "@hn-knowledge/adapters";
import {
  buildClassifierInput,
  CLASSIFIER_REQUEST_TIMEOUT_MS,
  createClassifyComment,
} from "@hn-knowledge/application";
import type { ClassificationRun, ContentDecision } from "@hn-knowledge/domain";
import {
  UNPROMOTED_MODEL_REVIEW_DECISION,
  classificationRunId,
  contentDecisionId,
  hnItemId,
} from "@hn-knowledge/domain";
import {
  ClassifierProviderError,
  type ClassificationRepository,
  type ClassifierPort,
  type ClassifierRequest,
  type ClassifierResponse,
  type RecordClassificationRunInput,
  type SaveContentDecisionInput,
} from "@hn-knowledge/ports";

const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};
const commentId = hnItemId(100);
const boundedInput = buildClassifierInput({
  selectedCommentId: commentId,
  rootId: hnItemId(200),
  commentText: "AcmeDB uses an append-only write-ahead log.",
  commentBlocks: [
    { kind: "TEXT", text: "AcmeDB uses an append-only write-ahead log." },
  ],
  rootTitle: "Database internals",
  rootText: "",
  rootBlocks: [],
  urlCandidates: [],
});

const validOutput = {
  schema_version: "classification.v1",
  primary_decision: "EXPERT_NOTE",
  decision_confidence: 0.94,
  comment_relevance: {
    is_materially_technical: true,
    reason: "The comment explains an implementation property.",
    evidence_span_ids: ["span:0"],
  },
  rejection_reasons: [],
  discoveries: [],
  expert_note: {
    note_type: "TECHNICAL_EXPLANATION",
    title: "AcmeDB write-ahead logging",
    summary: "AcmeDB uses an append-only write-ahead log.",
    evidence_origin: "COMMENT",
    evidence_span_ids: ["span:0"],
    related_subject_names: ["AcmeDB"],
    qualifiers: [],
    confidence: 0.92,
  },
  review: { required: false, reasons: [] },
} as const;

class MemoryClassificationRepository implements ClassificationRepository {
  readonly runs: RecordClassificationRunInput[] = [];
  readonly decisions: SaveContentDecisionInput[] = [];
  activeDecisionId: string | null = null;

  loadSource() {
    return Promise.resolve(null);
  }

  recordRun(input: RecordClassificationRunInput) {
    this.runs.push(input);
    const run: ClassificationRun = {
      id: classificationRunId("00000000-0000-4000-8000-000000000001"),
      ...input,
      createdAt: new Date("2026-08-24T12:00:00.000Z"),
    };
    return Promise.resolve({ run, created: true });
  }

  getRun() {
    return Promise.resolve(null);
  }

  saveDecision(input: SaveContentDecisionInput) {
    this.decisions.push(input);
    const id = contentDecisionId("00000000-0000-4000-8000-000000000002");
    const decision: ContentDecision = {
      id,
      commentId: input.commentId,
      classificationRunId: input.classificationRunId,
      source: input.source,
      primaryDecision: input.primaryDecision,
      decisionConfidence: input.decisionConfidence,
      materiallyTechnical: input.materiallyTechnical,
      reviewRequired: input.reviewRequired,
      validatedOutput: input.validatedOutput,
      manualOverrideOfId: input.manualOverrideOfId,
      evidenceSpans: input.evidenceSpans.map((span, index) => ({
        id: `evidence-${index}`,
        contentDecisionId: id,
        ...span,
        createdAt: new Date("2026-08-24T12:00:00.000Z"),
      })),
      createdAt: new Date("2026-08-24T12:00:00.000Z"),
    };
    return Promise.resolve(decision);
  }

  activateDecision(_commentId: typeof commentId, decisionId: string) {
    this.activeDecisionId = decisionId;
    return Promise.resolve();
  }

  getActiveDecision() {
    return Promise.resolve(null);
  }
}

class SequenceClassifier implements ClassifierPort {
  readonly provider = "fake";
  readonly modelId = "fake-v1";
  readonly modelConfigId = "fake-v1-temp0";
  readonly requests: ClassifierRequest[] = [];

  constructor(private readonly results: readonly (string | Error)[]) {}

  classify(request: ClassifierRequest): Promise<ClassifierResponse> {
    this.requests.push(request);
    const value = this.results[this.requests.length - 1];
    if (value instanceof Error) {
      return Promise.reject(value);
    }
    if (value === undefined) {
      return Promise.reject(new TypeError("Missing fake response"));
    }
    return Promise.resolve({
      rawOutput: value,
      provider: this.provider,
      modelId: this.modelId,
      modelConfigId: this.modelConfigId,
      latencyMs: 5,
      inputTokens: 10,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 1,
      outputTokens: 20,
    });
  }
}

describe("classify comment", () => {
  it("persists grounded model evidence without activating the decision", async () => {
    const classifier = new FixtureClassifier({
      outputs: new Map([[Number(commentId), validOutput]]),
    });
    const repository = new MemoryClassificationRepository();
    const openedReviews: unknown[] = [];

    const result = await createClassifyComment(classifier, repository, hasher, {
      openPolicyReview: (input) => {
        openedReviews.push(input);
        return Promise.resolve();
      },
    })({ commentId, boundedInput });

    expect(result.kind).toBe("DECISION");
    if (result.kind !== "DECISION") {
      throw new Error("Expected a persisted classification decision");
    }
    expect(repository.runs[0]).toMatchObject({
      status: "REVIEW",
      provider: "fixture",
      schemaVersion: "classification.v1",
    });
    expect(repository.decisions[0]).toMatchObject({
      source: "MODEL",
      reviewRequired: true,
      validatedOutput: { review: { required: false } },
    });
    expect(repository.decisions[0]?.evidenceSpans).toHaveLength(1);
    expect(repository.activeDecisionId).toBeNull();
    expect(openedReviews).toEqual([
      {
        commentId,
        contentDecisionId: result.decision.id,
        policy: UNPROMOTED_MODEL_REVIEW_DECISION,
      },
    ]);
    expect(classifier.requests[0]?.timeoutMs).toBe(
      CLASSIFIER_REQUEST_TIMEOUT_MS,
    );
    expect(classifier.requests[0]?.outputSchema).toMatchObject({
      $id: "classification.v1",
      additionalProperties: false,
    });
  });

  it("makes one fresh repair-free retry for invalid JSON", async () => {
    const classifier = new SequenceClassifier([
      "not json",
      JSON.stringify(validOutput),
    ]);
    const repository = new MemoryClassificationRepository();

    await expect(
      createClassifyComment(
        classifier,
        repository,
        hasher,
        null,
      )({
        commentId,
        boundedInput,
      }),
    ).resolves.toMatchObject({ kind: "DECISION" });

    expect(classifier.requests).toHaveLength(2);
    expect(classifier.requests[1]).toEqual(classifier.requests[0]);
    expect(classifier.requests[1]?.prompt).not.toContain("not json");
    expect(repository.runs).toHaveLength(1);
  });

  it("fails closed to review after a second invalid response", async () => {
    const classifier = new SequenceClassifier(["{", "still invalid"]);
    const repository = new MemoryClassificationRepository();

    const result = await createClassifyComment(
      classifier,
      repository,
      hasher,
      null,
    )({ commentId, boundedInput });

    expect(result).toMatchObject({ kind: "REVIEW", errorCode: "JSON_INVALID" });
    expect(repository.runs[0]).toMatchObject({
      status: "REVIEW",
      errorCode: "JSON_INVALID",
      latencyMs: 10,
      inputTokens: 20,
      cachedInputTokens: 8,
      cacheWriteInputTokens: 2,
      outputTokens: 40,
    });
    expect(repository.decisions).toHaveLength(0);
  });

  it.each([
    ["CLASSIFIER_TIMEOUT", true],
    ["CLASSIFIER_RATE_LIMIT", true],
    ["CLASSIFIER_AUTH", false],
  ] as const)("classifies %s provider failures", async (code, retryable) => {
    const classifier = new SequenceClassifier([
      new ClassifierProviderError(code, retryable, retryable ? 1_000 : null),
    ]);
    const repository = new MemoryClassificationRepository();

    const promise = createClassifyComment(
      classifier,
      repository,
      hasher,
      null,
    )({
      commentId,
      boundedInput,
    });

    await expect(promise).rejects.toMatchObject({
      code,
      retryable,
    });
    expect(repository.runs).toHaveLength(retryable ? 0 : 1);
    if (!retryable) {
      expect(repository.runs[0]).toMatchObject({
        status: "FAILED",
        errorCode: code,
      });
    }
  });
});
