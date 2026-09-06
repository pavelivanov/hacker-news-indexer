export type ResultCategory =
  "DISCOVERY" | "EXPERT_NOTE" | "REJECTED" | "REVIEW";
export type ResultIssue =
  | "WRONG_CATEGORY"
  | "INACCURATE_SUMMARY"
  | "NOT_USEFUL"
  | "MISSING_CONTEXT"
  | "OTHER";
export interface ResultCorrection {
  readonly category: ResultCategory;
  readonly title: string;
  readonly summary: string;
  readonly issue: ResultIssue;
  readonly explanation: string;
}
export class ClassifierResultsError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "VERSION_CONFLICT" | "IDEMPOTENCY_CONFLICT",
  ) {
    super(code);
    this.name = "ClassifierResultsError";
  }
}
