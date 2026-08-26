import type {
  ContentDecisionId,
  HnItemId,
  ReviewPolicyDecision,
  ReviewTask,
  ReviewTaskId,
  ReviewTaskKind,
  SubjectId,
  UrlCandidateId,
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
      | "REVIEW_POLICY_INVALID"
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

export interface OpenActionReviewInput extends OpenPolicyReviewInput {
  readonly kind: Exclude<ReviewTaskKind, "CONTENT_DECISION">;
  readonly targetKey?: string;
  readonly targetSnapshotHash?: string | null;
}

export interface ResolveReviewCommand {
  readonly taskId: ReviewTaskId;
  readonly expectedVersion: number;
  readonly actorId: string;
  readonly commandKey: string;
  readonly reason: string;
}

export interface MergeSubjectsReviewCommand extends ResolveReviewCommand {
  readonly sourceSubjectId: SubjectId;
  readonly targetSubjectId: SubjectId;
}

export interface ResolveSubjectUrlReviewCommand extends ResolveReviewCommand {
  readonly subjectId: SubjectId;
  readonly urlCandidateId: UrlCandidateId;
}

export interface ReviewService {
  readonly openPolicyReview: (
    input: OpenPolicyReviewInput,
  ) => Promise<OpenReviewTaskResult>;
  readonly openActionReview: (
    input: OpenActionReviewInput,
  ) => Promise<OpenReviewTaskResult>;
  readonly getTask: (id: ReviewTaskId) => Promise<ReviewTask | null>;
  readonly listOpenTasks: (
    limit: number,
    afterId: ReviewTaskId | null,
  ) => Promise<ReviewTaskPage>;
  readonly approve: (command: ResolveReviewCommand) => Promise<ReviewTask>;
  readonly reject: (command: ResolveReviewCommand) => Promise<ReviewTask>;
  readonly supersede: (command: ResolveReviewCommand) => Promise<ReviewTask>;
  readonly reopen: (command: ResolveReviewCommand) => Promise<ReviewTask>;
  readonly mergeSubjects: (
    command: MergeSubjectsReviewCommand,
  ) => Promise<ReviewTask>;
  readonly resolveSubjectUrl: (
    command: ResolveSubjectUrlReviewCommand,
  ) => Promise<ReviewTask>;
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
  outcome: "APPROVED" | "REJECTED" | "SUPERSEDED",
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

const normalizeCommand = <Command extends ResolveReviewCommand>(
  command: Command,
): Command => {
  if (
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion <= 0
  ) {
    throw new TypeError("expectedVersion must be a positive safe integer");
  }
  return {
    ...command,
    actorId: boundedText(command.actorId, "actorId", 128),
    commandKey: boundedText(command.commandKey, "commandKey", 256),
    reason: boundedText(command.reason, "reason", 1_000),
  };
};

const mutationTask = (
  result: Awaited<ReturnType<ReviewRepository["mergeSubjects"]>>,
): ReviewTask => {
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
    case "POLICY_INVALID":
      throw new ReviewServiceError("REVIEW_POLICY_INVALID");
    case "IDEMPOTENCY_CONFLICT":
      throw new ReviewServiceError("REVIEW_IDEMPOTENCY_CONFLICT");
  }
};

const resolve = async (
  repository: ReviewRepository,
  hasher: Hasher,
  outcome: "APPROVED" | "REJECTED" | "SUPERSEDED",
  command: ResolveReviewCommand,
): Promise<ReviewTask> => {
  const normalized = normalizeCommand(command);
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
    case "POLICY_INVALID":
      throw new ReviewServiceError("REVIEW_POLICY_INVALID");
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
        kind: "CONTENT_DECISION",
        priority: input.policy.priority,
        reasonCodes: input.policy.reasons,
      }),
    );
    return repository.openTask({
      commentId: input.commentId,
      contentDecisionId: input.contentDecisionId,
      kind: "CONTENT_DECISION",
      targetKey: "content",
      targetSnapshotHash: null,
      priority: input.policy.priority,
      reasonCodes: input.policy.reasons,
      actorId: "system",
      commandKey,
      requestHash,
      reason: "Application-owned review policy",
    });
  },

  async openActionReview(input) {
    if (
      !input.policy.required ||
      input.policy.priority === "NONE" ||
      input.policy.reasons.length === 0
    ) {
      throw new TypeError("Review policy must require at least one reason");
    }
    const targetKey = input.targetKey ?? input.kind.toLowerCase();
    const commandKey = `review-open:${input.contentDecisionId}:${input.kind}:${targetKey}:1`;
    const requestHash = hasher.sha256(
      JSON.stringify({
        commentId: input.commentId,
        contentDecisionId: input.contentDecisionId,
        kind: input.kind,
        targetKey,
        targetSnapshotHash: input.targetSnapshotHash ?? null,
        priority: input.policy.priority,
        reasonCodes: input.policy.reasons,
      }),
    );
    return repository.openTask({
      commentId: input.commentId,
      contentDecisionId: input.contentDecisionId,
      kind: input.kind,
      targetKey,
      targetSnapshotHash: input.targetSnapshotHash ?? null,
      priority: input.policy.priority,
      reasonCodes: input.policy.reasons,
      actorId: "system",
      commandKey,
      requestHash,
      reason: "Application-owned entity review policy",
    });
  },

  getTask: (id) => repository.getTask(id),
  listOpenTasks: (limit, afterId) => repository.listOpenTasks(limit, afterId),
  approve: (command) => resolve(repository, hasher, "APPROVED", command),
  reject: (command) => resolve(repository, hasher, "REJECTED", command),
  supersede: (command) => resolve(repository, hasher, "SUPERSEDED", command),
  async reopen(command) {
    const normalized = normalizeCommand(command);
    const result = await repository.reopenTask({
      ...normalized,
      requestHash: hasher.sha256(
        JSON.stringify({ ...normalized, action: "REOPENED" }),
      ),
    });
    switch (result.kind) {
      case "REOPENED":
        return result.task;
      case "NOT_FOUND":
        throw new ReviewServiceError("REVIEW_NOT_FOUND");
      case "VERSION_CONFLICT":
        throw new ReviewServiceError(
          "REVIEW_VERSION_CONFLICT",
          result.currentVersion,
        );
      case "INVALID_STATE":
        throw new ReviewServiceError(
          "REVIEW_INVALID_STATE",
          null,
          result.state,
        );
      case "POLICY_INVALID":
        throw new ReviewServiceError("REVIEW_POLICY_INVALID");
      case "IDEMPOTENCY_CONFLICT":
        throw new ReviewServiceError("REVIEW_IDEMPOTENCY_CONFLICT");
    }
  },
  async mergeSubjects(command) {
    const normalized = normalizeCommand(command);
    const result = await repository.mergeSubjects({
      ...normalized,
      requestHash: hasher.sha256(
        JSON.stringify({ ...normalized, action: "SUBJECT_MERGE" }),
      ),
    });
    return mutationTask(result);
  },
  async resolveSubjectUrl(command) {
    const normalized = normalizeCommand(command);
    const result = await repository.resolveSubjectUrl({
      ...normalized,
      requestHash: hasher.sha256(
        JSON.stringify({ ...normalized, action: "URL_RESOLUTION" }),
      ),
    });
    return mutationTask(result);
  },
});
