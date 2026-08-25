import type {
  ContentDecisionId,
  HnItemId,
  ReviewPolicyDecision,
  ReviewTask,
  ReviewTaskId,
} from "@hn-knowledge/domain";
import type {
  Hasher,
  OpenReviewTaskResult,
  ReviewRepository,
  ReviewTaskPage,
} from "@hn-knowledge/ports";

export class ReviewServiceError extends Error {
  constructor(
    readonly code:
      | "REVIEW_NOT_FOUND"
      | "REVIEW_VERSION_CONFLICT"
      | "REVIEW_INVALID_STATE"
      | "REVIEW_IDEMPOTENCY_CONFLICT",
    readonly currentVersion: number | null = null,
    readonly currentState: ReviewTask["state"] | null = null,
  ) {
    super(code);
    this.name = "ReviewServiceError";
  }
}

export interface OpenPolicyReviewInput {
  readonly commentId: HnItemId;
  readonly contentDecisionId: ContentDecisionId;
  readonly policy: ReviewPolicyDecision;
}

export interface ResolveReviewCommand {
  readonly taskId: ReviewTaskId;
  readonly expectedVersion: number;
  readonly actorId: string;
  readonly commandKey: string;
  readonly reason: string;
}

export interface ReviewService {
  readonly openPolicyReview: (
    input: OpenPolicyReviewInput,
  ) => Promise<OpenReviewTaskResult>;
  readonly getTask: (id: ReviewTaskId) => Promise<ReviewTask | null>;
  readonly listOpenTasks: (
    limit: number,
    afterId: ReviewTaskId | null,
  ) => Promise<ReviewTaskPage>;
  readonly approve: (command: ResolveReviewCommand) => Promise<ReviewTask>;
  readonly reject: (command: ResolveReviewCommand) => Promise<ReviewTask>;
}

const boundedText = (value: string, field: string, maximum: number): string => {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new TypeError(`${field} must contain 1 to ${maximum} characters`);
  }
  return normalized;
};

const commandHash = (
  hasher: Hasher,
  outcome: "APPROVED" | "REJECTED",
  command: ResolveReviewCommand,
): string =>
  hasher.sha256(
    JSON.stringify({
      taskId: command.taskId,
      expectedVersion: command.expectedVersion,
      outcome,
      actorId: command.actorId,
      commandKey: command.commandKey,
      reason: command.reason,
    }),
  );

const resolve = async (
  repository: ReviewRepository,
  hasher: Hasher,
  outcome: "APPROVED" | "REJECTED",
  command: ResolveReviewCommand,
): Promise<ReviewTask> => {
  if (
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion <= 0
  ) {
    throw new TypeError("expectedVersion must be a positive safe integer");
  }
  const actorId = boundedText(command.actorId, "actorId", 128);
  const commandKey = boundedText(command.commandKey, "commandKey", 256);
  const reason = boundedText(command.reason, "reason", 1_000);
  const normalized = { ...command, actorId, commandKey, reason };
  const result = await repository.resolveTask({
    ...normalized,
    outcome,
    requestHash: commandHash(hasher, outcome, normalized),
  });
  switch (result.kind) {
    case "RESOLVED":
      return result.task;
    case "NOT_FOUND":
      throw new ReviewServiceError("REVIEW_NOT_FOUND");
    case "VERSION_CONFLICT":
      throw new ReviewServiceError(
        "REVIEW_VERSION_CONFLICT",
        result.currentVersion,
      );
    case "INVALID_STATE":
      throw new ReviewServiceError("REVIEW_INVALID_STATE", null, result.state);
    case "IDEMPOTENCY_CONFLICT":
      throw new ReviewServiceError("REVIEW_IDEMPOTENCY_CONFLICT");
  }
};

export const createReviewService = (
  repository: ReviewRepository,
  hasher: Hasher,
): ReviewService => ({
  async openPolicyReview(input) {
    if (
      !input.policy.required ||
      input.policy.priority === "NONE" ||
      input.policy.reasons.length === 0
    ) {
      throw new TypeError("Review policy must require at least one reason");
    }
    const commandKey = `review-open:${input.contentDecisionId}:1`;
    const requestHash = hasher.sha256(
      JSON.stringify({
        commentId: input.commentId,
        contentDecisionId: input.contentDecisionId,
        priority: input.policy.priority,
        reasonCodes: input.policy.reasons,
      }),
    );
    return repository.openTask({
      commentId: input.commentId,
      contentDecisionId: input.contentDecisionId,
      priority: input.policy.priority,
      reasonCodes: input.policy.reasons,
      actorId: "system",
      commandKey,
      requestHash,
      reason: "Application-owned review policy",
    });
  },

  getTask: (id) => repository.getTask(id),
  listOpenTasks: (limit, afterId) => repository.listOpenTasks(limit, afterId),
  approve: (command) => resolve(repository, hasher, "APPROVED", command),
  reject: (command) => resolve(repository, hasher, "REJECTED", command),
});
