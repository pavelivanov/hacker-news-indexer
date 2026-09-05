import type { ManualDraft } from "@hn-knowledge/domain";
import type {
  ClassificationRepository,
  ReviewRepository,
  SubjectMaterializationRepository,
} from "./repositories.js";

export interface ManualSourceState {
  readonly commentId: number;
  readonly rootId: number;
  readonly activeDecisionId: string | null;
  readonly available: boolean;
  readonly fingerprint: string;
}
export interface ManualInboxItem {
  readonly commentId: number;
  readonly firstSeenAt: Date;
  readonly excerpt: string;
  readonly state: "unreviewed" | "draft" | "approved" | "rejected";
  readonly available: boolean;
}
export type ManualInboxState = ManualInboxItem["state"] | "all";
export interface ManualReceipt {
  readonly draftId: string;
  readonly commandKey: string;
  readonly requestHash: string;
  readonly result: unknown;
}
export interface ManualDraftRepository {
  sourceState(commentId: number): Promise<ManualSourceState | null>;
  findForComment(commentId: number): Promise<ManualDraft | null>;
  get(id: string): Promise<ManualDraft | null>;
  create(input: {
    commentId: number;
    sourceHash: string;
    baseActiveDecisionId: string | null;
    actorId: string;
  }): Promise<ManualDraft>;
  save(input: {
    id: string;
    expectedVersion: number;
    payload: unknown;
    sourceHash: string;
    actorId: string;
  }): Promise<ManualDraft>;
  finish(input: {
    id: string;
    expectedVersion: number;
    state: "APPROVED" | "REJECTED";
    actorId: string;
  }): Promise<ManualDraft>;
  receipt(commandKey: string): Promise<ManualReceipt | null>;
  recordReceipt(receipt: ManualReceipt): Promise<void>;
  inbox(
    state: ManualInboxState,
    after: { firstSeenAt: Date; commentId: number } | null,
  ): Promise<readonly ManualInboxItem[]>;
}
export interface ManualReviewTransaction {
  readonly drafts: ManualDraftRepository;
  readonly classifications: ClassificationRepository;
  readonly subjects: SubjectMaterializationRepository;
  readonly review: ReviewRepository;
}
export interface ManualReviewUnitOfWork {
  run<T>(
    operation: (transaction: ManualReviewTransaction) => Promise<T>,
    draftId?: string,
  ): Promise<T>;
}
