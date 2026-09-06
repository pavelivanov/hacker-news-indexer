import type {
  ManualReviewService,
  ClassifierResultsService,
  FeedProcessingService,
} from "@hn-knowledge/application";
import type {
  KnowledgeFeedV1,
  ManualDraftV1,
  ManualFinalizeResultV1,
  ManualFinalizeV1,
  ManualSaveV1,
  ReaderCommentV1,
  ClassifierFeedbackV1,
  ResultBookmarkV1,
} from "@hn-knowledge/contracts";

export type CommentDetail = Awaited<
  ReturnType<ManualReviewService["getComment"]>
>;
export type Inbox = Awaited<ReturnType<ManualReviewService["inbox"]>>;
export type InboxState =
  "unreviewed" | "draft" | "approved" | "rejected" | "all";
export type FeedKind = "discovery" | "expert_note";
export type ResultsPage = Awaited<ReturnType<ClassifierResultsService["list"]>>;
export type ProcessingStatus = Awaited<
  ReturnType<FeedProcessingService["status"]>
>;
export type ResultDetail = Awaited<ReturnType<ClassifierResultsService["get"]>>;
export type ResultBookmarkState = Pick<
  ResultDetail,
  "bookmarked" | "bookmark_version"
>;
export type ResultsFilter = NonNullable<
  Parameters<ClassifierResultsService["list"]>[0]
>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

export const errorMessage = (error: unknown): string => {
  if (!(error instanceof ApiError))
    return "The connection was interrupted. Your edits are still here. Try again.";
  const messages: Partial<Record<string, string>> = {
    version_conflict:
      "A newer draft was saved elsewhere. Your edits are still here. Compare the saved version before continuing.",
    source_conflict:
      "The source has changed. Refresh the evidence, then rebase the draft and choose its evidence again.",
    state_conflict:
      "This comment was already reviewed or its decision changed. Load the current version to continue.",
    idempotency_conflict:
      "This approval request conflicts with an earlier request. Reload the saved decision.",
    invalid_request: "Check the form values and their length, then try again.",
    output_invalid: "The saved draft needs attention before approval.",
    not_found: "This source or draft is no longer available.",
    unauthorized: "The token was not accepted. Unlock the workspace again.",
  };
  const details: Partial<Record<string, string>> = {
    SUBJECT_NAME_UNSUPPORTED:
      "Use a discovery name that appears in its selected evidence.",
    ROOT_RELEVANCE_FAILED:
      "Root-story discoveries require a materially technical selected comment.",
    MODEL_URL_STRING:
      "Choose URLs from the source catalog; remove raw URLs from written fields.",
    UNRESOLVED_SOURCE_OR_EVIDENCE_ISSUE:
      "Resolve the source or evidence issue before approval.",
    SCHEMA_INVALID:
      "Complete all required fields and select supporting evidence.",
  };
  return (
    details[error.detail ?? ""] ??
    messages[error.code] ??
    "The request could not be completed. Retry the same action; your saved draft is preserved."
  );
};

export const createApi = (token: string, onUnauthorized: () => void) => {
  const request = async <T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> => {
    const response = await fetch(path, {
      ...options,
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: options.signal ?? AbortSignal.timeout(20_000),
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) onUnauthorized();
      const record =
        value !== null && typeof value === "object"
          ? (value as Record<string, unknown>)
          : {};
      throw new ApiError(
        response.status,
        response.status === 401
          ? "unauthorized"
          : typeof record["error"] === "string"
            ? record["error"]
            : "internal_error",
        typeof record["detail"] === "string" ? record["detail"] : undefined,
      );
    }
    return value as T;
  };
  return {
    processing: (signal?: AbortSignal) =>
      request<ProcessingStatus>("/v1/processing", { signal }),
    controlProcessing: (action: "sync" | "pause" | "resume") =>
      request<{ accepted: boolean }>("/v1/processing/control", {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    retryProcessing: (kind: "job" | "result", id: string, commandKey: string) =>
      request<{ job_id: string; replayed: boolean }>(
        `/v1/processing/${kind}s/${id}/retry`,
        { method: "POST", body: JSON.stringify({ command_key: commandKey }) },
      ),
    results: (
      filter: ResultsFilter,
      cursor: string | null = null,
      signal?: AbortSignal,
      query = "",
    ) =>
      request<ResultsPage>(
        `/v1/classifier-results?filter=${filter}&q=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal },
      ),
    result: (id: string, signal?: AbortSignal) =>
      request<ResultDetail>(`/v1/classifier-results/${id}`, { signal }),
    bookmarkResult: (id: string, body: ResultBookmarkV1) =>
      request<{ bookmarked: boolean; version: number; replayed: boolean }>(
        `/v1/classifier-results/${id}/bookmark`,
        { method: "PUT", body: JSON.stringify(body) },
      ),
    correctResult: (id: string, body: ClassifierFeedbackV1) =>
      request<{ version: number; replayed: boolean }>(
        `/v1/classifier-results/${id}/corrections`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    inbox: (
      state: InboxState,
      cursor: string | null = null,
      signal?: AbortSignal,
    ) =>
      request<Inbox>(
        `/v1/manual-review/inbox?state=${state}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal },
      ),
    comment: (id: number, signal?: AbortSignal) =>
      request<CommentDetail>(`/v1/manual-review/comments/${id}`, { signal }),
    create: (id: number) =>
      request<{ draft: ManualDraftV1 }>(
        `/v1/manual-review/comments/${id}/draft`,
        { method: "POST", body: "{}" },
      ),
    save: (id: string, body: ManualSaveV1) =>
      request<{ draft: ManualDraftV1 }>(`/v1/manual-review/drafts/${id}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    rebase: (id: string, version: number) =>
      request<{ draft: ManualDraftV1 }>(
        `/v1/manual-review/drafts/${id}/rebase`,
        { method: "POST", body: JSON.stringify({ expected_version: version }) },
      ),
    finalize: (
      id: string,
      action: "approve" | "reject",
      body: ManualFinalizeV1,
    ) =>
      request<ManualFinalizeResultV1>(
        `/v1/manual-review/drafts/${id}/${action}`,
        { method: "POST", body: JSON.stringify(body) },
      ),
    feed: (kind: FeedKind, cursor: string | null, signal?: AbortSignal) =>
      request<KnowledgeFeedV1>(
        `/v1/feed?kind=${kind}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal },
      ),
    publishedComment: (id: number, signal?: AbortSignal) =>
      request<ReaderCommentV1>(`/v1/comments/${id}`, { signal }),
  };
};
export type Api = ReturnType<typeof createApi>;
