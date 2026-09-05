export const MANUAL_DRAFT_STATES = ["DRAFT", "APPROVED", "REJECTED"] as const;
export type ManualDraftState = (typeof MANUAL_DRAFT_STATES)[number];

export interface ManualDraft {
  readonly id: string;
  readonly commentId: number;
  readonly payload: unknown;
  readonly version: number;
  readonly sourceHash: string;
  readonly baseActiveDecisionId: string | null;
  readonly state: ManualDraftState;
  readonly actorId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly decisionId: string | null;
}

export class ManualReviewError extends Error {
  constructor(
    readonly code:
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "SOURCE_CONFLICT"
      | "STATE_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "OUTPUT_INVALID",
    readonly detail: string | null = null,
  ) {
    super(code);
    this.name = "ManualReviewError";
  }
}
