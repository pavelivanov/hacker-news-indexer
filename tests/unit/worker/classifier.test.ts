import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { FixtureClassifier, OpenAiClassifier } from "@hn-knowledge/adapters";
import { createClassifyComment } from "@hn-knowledge/application";
import type { ClassificationRun, ContentDecision } from "@hn-knowledge/domain";
import {
  classificationRunId,
  contentDecisionId,
  hnItemId,
  type PipelineJob,
  pipelineJobId,
} from "@hn-knowledge/domain";
import type {
  ClassificationRepository,
  ClassifierPort,
  RecordClassificationRunInput,
  SaveContentDecisionInput,
} from "@hn-knowledge/ports";
import type { AppConfig } from "@hn-knowledge/config";

import { createWorkerClassifier } from "@hn-knowledge/worker/classifier";
import { createClassifyJobHandler } from "@hn-knowledge/worker/jobs/classify";

const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};

const baseConfig = {
  CLASSIFIER_ENABLED: false,
  CLASSIFIER_PROVIDER: undefined,
  CLASSIFIER_API_TOKEN: undefined,
  CLASSIFIER_MODEL: undefined,
  CLASSIFIER_REASONING_EFFORT: "low",
} as const;

const configWith = (overrides: Partial<AppConfig>): AppConfig => ({
  ...(baseConfig as unknown as AppConfig),
  ...overrides,
});

const enabledConfig = configWith({
  CLASSIFIER_ENABLED: true,
  CLASSIFIER_PROVIDER: "openai",
  CLASSIFIER_API_TOKEN: "test-token",
  CLASSIFIER_MODEL: "gpt-test",
  CLASSIFIER_REASONING_EFFORT: "medium",
});

describe("createWorkerClassifier", () => {
  it("returns null when classification is disabled", () => {
    expect(createWorkerClassifier(configWith({}))).toBeNull();
  });

  it("returns an OpenAiClassifier when enabled with valid config", () => {
    const classifier = createWorkerClassifier(enabledConfig);

    expect(classifier).toBeInstanceOf(OpenAiClassifier);
    expect(classifier?.provider).toBe("openai");
    expect(classifier?.modelId).toBe("gpt-test");
  });

  it("throws a startup error on provider mismatch", () => {
    expect(() =>
      createWorkerClassifier(
        configWith({
          CLASSIFIER_ENABLED: true,
          CLASSIFIER_PROVIDER: "fixture",
          CLASSIFIER_API_TOKEN: "test-token",
          CLASSIFIER_MODEL: "gpt-test",
        }),
      ),
    ).toThrow("Unsupported CLASSIFIER_PROVIDER");
  });

  it("throws a startup error when token or model drift is missing", () => {
    expect(() =>
      createWorkerClassifier(
        configWith({
          CLASSIFIER_ENABLED: true,
          CLASSIFIER_PROVIDER: "openai",
          CLASSIFIER_API_TOKEN: undefined,
          CLASSIFIER_MODEL: "gpt-test",
        }),
      ),
    ).toThrow("CLASSIFIER_API_TOKEN is required");

    expect(() =>
      createWorkerClassifier(
        configWith({
          CLASSIFIER_ENABLED: true,
          CLASSIFIER_PROVIDER: "openai",
          CLASSIFIER_API_TOKEN: "test-token",
          CLASSIFIER_MODEL: undefined,
        }),
      ),
    ).toThrow("CLASSIFIER_MODEL is required");
  });
});

const validOutput = {
  schema_version: "classification.v1",
  primary_decision: "REJECTED",
  decision_confidence: 0.99,
  comment_relevance: {
    is_materially_technical: false,
    reason: "The comment contains no technical signal.",
    evidence_span_ids: [],
  },
  rejection_reasons: ["NO_TECHNICAL_SIGNAL"],
  discoveries: [],
  expert_note: null,
  review: { required: false, reasons: [] },
} as const;

class StubClassificationRepository implements ClassificationRepository {
  readonly runs: RecordClassificationRunInput[] = [];
  readonly decisions: SaveContentDecisionInput[] = [];

  loadSource() {
    return Promise.resolve({
      selectedCommentId: hnItemId(100),
      rootId: hnItemId(200),
      commentHtml: "",
      commentText: "",
      rootTitle: "Example root",
      rootHtml: "",
      rootUrl: null,
      commentUrlCandidates: [],
    });
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
      evidenceSpans: [],
      createdAt: new Date("2026-08-24T12:00:00.000Z"),
    };
    return Promise.resolve(decision);
  }

  getActiveDecision() {
    return Promise.resolve(null);
  }
}

const classifyJob = (attempts: number): PipelineJob => ({
  id: pipelineJobId("00000000-0000-4000-8000-000000000003"),
  ingestionRunId: null,
  type: "CLASSIFY_COMMENT",
  payload: { selectedCommentId: 100 },
  idempotencyKey: "classify-job-test",
  state: "LEASED",
  attempts,
  availableAt: new Date("2026-08-24T12:00:00.000Z"),
  leaseOwner: "worker-test",
  leaseExpiresAt: null,
  lastErrorCode: null,
  createdAt: new Date("2026-08-24T12:00:00.000Z"),
  updatedAt: new Date("2026-08-24T12:00:00.000Z"),
});

describe("classify job handler classifier wiring", () => {
  it("throws CLASSIFIER_DISABLED when the factory returns null", async () => {
    const handler = createClassifyJobHandler(
      createWorkerClassifier(configWith({})),
      new StubClassificationRepository(),
      hasher,
      { openPolicyReview: () => Promise.resolve() },
      4,
    );

    await expect(handler(classifyJob(1))).rejects.toThrow(
      "CLASSIFIER_DISABLED",
    );
  });

  it("does not throw CLASSIFIER_DISABLED when a classifier port is wired", async () => {
    const stub: ClassifierPort = new FixtureClassifier({
      outputs: new Map([[100, validOutput]]),
    });
    const repository = new StubClassificationRepository();
    const handler = createClassifyJobHandler(
      stub,
      repository,
      hasher,
      { openPolicyReview: () => Promise.resolve() },
      4,
    );

    await handler(classifyJob(1));

    expect(repository.runs).toHaveLength(1);
    expect(repository.runs[0]?.provider).toBe("fixture");
    expect(repository.runs[0]?.latencyMs).not.toBeNull();
  });

  it("composes the factory with the application classify pipeline", () => {
    const classifier = createWorkerClassifier(enabledConfig);
    expect(classifier).not.toBeNull();
    // The factory product satisfies the same port the application pipeline
    // (createClassifyComment) consumes — wiring is type-compatible end to end.
    expect(() =>
      createClassifyComment(
        classifier as ClassifierPort,
        new StubClassificationRepository(),
        hasher,
        { openPolicyReview: () => Promise.resolve() },
      ),
    ).not.toThrow();
  });
});
