import { createHmac, timingSafeEqual } from "node:crypto";

import {
  parseManualDraftPayload,
  parseManualFinalize,
  parseManualSave,
  type ManualDraftV1,
  type ManualFinalizeResultV1,
} from "@hn-knowledge/contracts";
import {
  ManualReviewError,
  hnItemId,
  reviewPolicyFromReasons,
  type ManualDraft,
} from "@hn-knowledge/domain";
import type {
  Hasher,
  ManualInboxState,
  ManualReviewTransaction,
  ManualReviewUnitOfWork,
} from "@hn-knowledge/ports";
import { loadClassifierInput } from "../classification/load-input.js";
import { validateClassifierOutput } from "../classification/validate-output.js";
import { createMaterializeClassification } from "../subjects/materialize-classification.js";
import { createReviewService } from "../review/review-service.js";

const draftResponse = (draft: ManualDraft): ManualDraftV1 => ({
  id: draft.id,
  comment_id: draft.commentId,
  payload: parseManualDraftPayload(draft.payload),
  version: draft.version,
  source_hash: draft.sourceHash,
  state: draft.state,
  actor_id: draft.actorId,
  created_at: draft.createdAt.toISOString(),
  updated_at: draft.updatedAt.toISOString(),
  decision_id: draft.decisionId,
});
const requiredDraft = async (
  tx: ManualReviewTransaction,
  id: string,
): Promise<ManualDraft> => {
  const draft = await tx.drafts.get(id);
  if (draft === null) throw new ManualReviewError("NOT_FOUND");
  return draft;
};
const editable = (draft: ManualDraft, version: number): void => {
  if (draft.state !== "DRAFT") throw new ManualReviewError("STATE_CONFLICT");
  if (draft.version !== version)
    throw new ManualReviewError("VERSION_CONFLICT");
};

export const clearManualEvidence = (payload: unknown): unknown => {
  if (Array.isArray(payload)) return payload.map(clearManualEvidence);
  if (payload === null || typeof payload !== "object") return payload;
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [
      key,
      key === "evidence_span_ids" || key === "url_candidate_ids"
        ? []
        : key === "url_grounding"
          ? "NONE"
          : clearManualEvidence(value),
    ]),
  );
};

export const createManualReviewService = (
  unitOfWork: ManualReviewUnitOfWork,
  hasher: Hasher,
  options: { actorId: string; cursorSecret: string },
) => {
  if (!options.actorId.trim() || options.actorId.length > 128)
    throw new TypeError("Invalid review actor");
  const snapshot = async (tx: ManualReviewTransaction, commentId: number) => {
    const state = await tx.drafts.sourceState(commentId);
    if (state === null) throw new ManualReviewError("NOT_FOUND");
    const input = state.available
      ? await loadClassifierInput(
          hnItemId(commentId),
          tx.classifications,
          hasher,
        )
      : null;
    return {
      state,
      input,
      hash: hasher.sha256(
        JSON.stringify({ fingerprint: state.fingerprint, input }),
      ),
    };
  };
  const checkSnapshot = async (
    tx: ManualReviewTransaction,
    draft: ManualDraft,
    suppliedHash: string,
  ) => {
    const source = await snapshot(tx, draft.commentId);
    if (source.state.activeDecisionId !== draft.baseActiveDecisionId)
      throw new ManualReviewError("STATE_CONFLICT");
    if (
      !source.state.available ||
      source.input === null ||
      source.hash !== draft.sourceHash ||
      suppliedHash !== draft.sourceHash
    ) {
      throw new ManualReviewError("SOURCE_CONFLICT");
    }
    return source.input;
  };
  const signCursor = (body: string): string =>
    createHmac("sha256", options.cursorSecret).update(body).digest("hex");

  return {
    async getComment(commentId: number) {
      return unitOfWork.run(async (tx) => {
        const source = await snapshot(tx, commentId);
        const draft = await tx.drafts.findForComment(commentId);
        return {
          comment_id: commentId,
          source_hash: source.hash,
          available: source.state.available,
          blocked_reason: source.state.available ? null : "SOURCE_UNAVAILABLE",
          source: source.input,
          draft: draft === null ? null : draftResponse(draft),
        };
      });
    },
    async create(commentId: number) {
      return unitOfWork.run(async (tx) => {
        const existing = await tx.drafts.findForComment(commentId);
        if (existing !== null) return draftResponse(existing);
        const source = await snapshot(tx, commentId);
        if (source.state.activeDecisionId !== null)
          throw new ManualReviewError("STATE_CONFLICT");
        if (!source.state.available)
          throw new ManualReviewError("SOURCE_CONFLICT");
        return draftResponse(
          await tx.drafts.create({
            commentId,
            sourceHash: source.hash,
            baseActiveDecisionId: source.state.activeDecisionId,
            actorId: options.actorId,
          }),
        );
      });
    },
    async save(id: string, value: unknown) {
      const request = parseManualSave(value);
      return unitOfWork.run(async (tx) => {
        const draft = await requiredDraft(tx, id);
        editable(draft, request.expected_version);
        await checkSnapshot(tx, draft, request.source_hash);
        return draftResponse(
          await tx.drafts.save({
            id,
            expectedVersion: request.expected_version,
            sourceHash: draft.sourceHash,
            payload: request.payload,
            actorId: options.actorId,
          }),
        );
      });
    },
    async rebase(id: string, expectedVersion: number) {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion <= 0)
        throw new TypeError("Invalid version");
      return unitOfWork.run(async (tx) => {
        const draft = await requiredDraft(tx, id);
        editable(draft, expectedVersion);
        const source = await snapshot(tx, draft.commentId);
        if (source.state.activeDecisionId !== draft.baseActiveDecisionId)
          throw new ManualReviewError("STATE_CONFLICT");
        if (!source.state.available)
          throw new ManualReviewError("SOURCE_CONFLICT");
        return draftResponse(
          await tx.drafts.save({
            id,
            expectedVersion,
            sourceHash: source.hash,
            payload: clearManualEvidence(draft.payload),
            actorId: options.actorId,
          }),
        );
      });
    },
    async finalize(
      id: string,
      outcome: "APPROVED" | "REJECTED",
      value: unknown,
    ): Promise<ManualFinalizeResultV1> {
      const request = parseManualFinalize(value);
      const requestHash = hasher.sha256(
        JSON.stringify({
          id,
          outcome,
          actor: options.actorId,
          version: request.expected_version,
          sourceHash: request.source_hash,
          commandKey: request.command_key,
          reason: request.reason,
        }),
      );
      return unitOfWork.run(async (tx) => {
        const receipt = await tx.drafts.receipt(request.command_key);
        if (receipt !== null) {
          if (receipt.requestHash !== requestHash)
            throw new ManualReviewError("IDEMPOTENCY_CONFLICT");
          return {
            ...(receipt.result as ManualFinalizeResultV1),
            replayed: true,
          };
        }
        const draft = await requiredDraft(tx, id);
        editable(draft, request.expected_version);
        const input = await checkSnapshot(tx, draft, request.source_hash);
        const validated = validateClassifierOutput(
          JSON.stringify(draft.payload),
          input,
          hasher,
        );
        if (!validated.ok)
          throw new ManualReviewError("OUTPUT_INVALID", validated.code);
        const output = validated.output;
        if (
          output.review.reasons.some(
            (reason) =>
              reason === "UNAVAILABLE_CONTENT" ||
              reason === "INVALID_EVIDENCE_SPAN" ||
              reason === "UNSUPPORTED_URL",
          )
        )
          throw new ManualReviewError(
            "OUTPUT_INVALID",
            "UNRESOLVED_SOURCE_OR_EVIDENCE_ISSUE",
          );
        if (
          output.primary_decision === "REVIEW" ||
          (output.primary_decision === "REJECTED") !== (outcome === "REJECTED")
        ) {
          throw new ManualReviewError(
            "OUTPUT_INVALID",
            "FINALIZATION_CLASS_MISMATCH",
          );
        }
        const decision = await tx.classifications.saveDecision({
          commentId: hnItemId(draft.commentId),
          classificationRunId: null,
          source: "MANUAL",
          primaryDecision: output.primary_decision,
          decisionConfidence: output.decision_confidence,
          materiallyTechnical: output.comment_relevance.is_materially_technical,
          reviewRequired: true,
          validatedOutput: output,
          manualOverrideOfId: null,
          evidenceSpans: validated.evidenceSpans.map((span) => ({
            spanId: span.id,
            sourceDocument: span.documentId,
            origin: span.origin,
            start: span.start,
            end: span.end,
            textHash: span.textHash,
          })),
        });
        const review = createReviewService(tx.review, hasher);
        const materialized = await createMaterializeClassification(
          tx.classifications,
          tx.subjects,
          hasher,
          review,
        )(decision.id);
        const policy = reviewPolicyFromReasons([
          "MANUAL_DECISION_REVIEW",
          ...output.review.reasons.filter(
            (
              reason,
            ): reason is Exclude<
              typeof reason,
              | "UNAVAILABLE_CONTENT"
              | "INVALID_EVIDENCE_SPAN"
              | "UNSUPPORTED_URL"
            > =>
              reason !== "UNAVAILABLE_CONTENT" &&
              reason !== "INVALID_EVIDENCE_SPAN" &&
              reason !== "UNSUPPORTED_URL",
          ),
        ]);
        const opened = await review.openPolicyReview({
          commentId: decision.commentId,
          contentDecisionId: decision.id,
          policy,
        });
        await review.approve({
          taskId: opened.task.id,
          expectedVersion: opened.task.version,
          actorId: options.actorId,
          commandKey: `manual:${request.command_key}`,
          reason: request.reason,
        });
        const final = await tx.drafts.finish({
          id,
          expectedVersion: draft.version,
          state: outcome,
          actorId: options.actorId,
        });
        const result: ManualFinalizeResultV1 = {
          draft: draftResponse(final),
          decision_id: decision.id,
          review_task_id: opened.task.id,
          replayed: false,
          warnings: [
            ...(materialized.missingUrlDiscoveryOrdinals.length
              ? ["MISSING_CANONICAL_URL"]
              : []),
            ...(materialized.ambiguousUrlDiscoveryOrdinals.length
              ? ["AMBIGUOUS_CANONICAL_URL"]
              : []),
            ...(materialized.invalidUrlDiscoveryOrdinals.length
              ? ["INVALID_CANONICAL_URL"]
              : []),
            ...(materialized.unresolvedRelatedSubjectNames.length
              ? ["UNRESOLVED_RELATED_SUBJECT"]
              : []),
          ],
        };
        await tx.drafts.recordReceipt({
          draftId: id,
          commandKey: request.command_key,
          requestHash,
          result,
        });
        return result;
      }, id);
    },
    async inbox(
      state: ManualInboxState = "unreviewed",
      cursor: string | null = null,
    ) {
      if (
        !["all", "draft", "approved", "rejected", "unreviewed"].includes(state)
      )
        throw new TypeError("Invalid inbox state");
      let after: { firstSeenAt: Date; commentId: number } | null = null;
      if (cursor !== null) {
        if (cursor.length > 2048) throw new TypeError("Invalid cursor");
        const [body, signature, extra] = cursor.split(".");
        if (
          !body ||
          !signature ||
          extra !== undefined ||
          !/^[a-f0-9]{64}$/.test(signature) ||
          !timingSafeEqual(
            Buffer.from(signCursor(body)),
            Buffer.from(signature),
          )
        )
          throw new TypeError("Invalid cursor");
        const parsed: unknown = JSON.parse(
          Buffer.from(body, "base64url").toString("utf8"),
        );
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          !("v" in parsed) ||
          parsed.v !== 1 ||
          !("state" in parsed) ||
          parsed.state !== state ||
          !("time" in parsed) ||
          typeof parsed.time !== "string" ||
          !Number.isFinite(Date.parse(parsed.time)) ||
          !("id" in parsed) ||
          typeof parsed.id !== "number" ||
          !Number.isSafeInteger(parsed.id) ||
          parsed.id <= 0
        )
          throw new TypeError("Invalid cursor");
        after = { firstSeenAt: new Date(parsed.time), commentId: parsed.id };
      }
      return unitOfWork.run(async (tx) => {
        const rows = await tx.drafts.inbox(state, after);
        const items = rows.slice(0, 20);
        const last = items.at(-1);
        const body =
          last === undefined
            ? null
            : Buffer.from(
                JSON.stringify({
                  v: 1,
                  state,
                  time: last.firstSeenAt.toISOString(),
                  id: last.commentId,
                }),
              ).toString("base64url");
        return {
          items: items.map((row) => ({
            comment_id: row.commentId,
            excerpt: row.excerpt,
            state: row.state,
            available: row.available,
          })),
          next_cursor:
            rows.length > 20 && body !== null
              ? `${body}.${signCursor(body)}`
              : null,
        };
      });
    },
  };
};

export type ManualReviewService = ReturnType<typeof createManualReviewService>;
