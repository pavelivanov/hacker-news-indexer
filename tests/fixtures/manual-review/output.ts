import type { ClassificationV1 } from "@hn-knowledge/contracts";
import type { BoundedClassifierInput } from "@hn-knowledge/ports";

export const manualOutput = (
  input: BoundedClassifierInput,
  kind: "DISCOVERY" | "EXPERT_NOTE" | "BOTH" | "REJECTED" = "DISCOVERY",
  rootBody = false,
): ClassificationV1 => {
  const comment = input.documents.find(
    (document) => document.origin === "COMMENT",
  )?.spans[0];
  const evidence = rootBody
    ? input.documents.find((document) => document.id.startsWith("root-text:"))
        ?.spans[0]
    : comment;
  if (!comment || !evidence) throw new Error("Missing fixture evidence");
  const ids = [evidence.id];
  return {
    schema_version: "classification.v1",
    primary_decision: kind === "BOTH" ? "DISCOVERY" : kind,
    decision_confidence: 0.85,
    comment_relevance: {
      is_materially_technical: kind !== "REJECTED",
      reason: "Describes the storage implementation",
      evidence_span_ids: [comment.id],
    },
    rejection_reasons: kind === "REJECTED" ? ["GENERIC_OPINION"] : [],
    discoveries:
      kind === "DISCOVERY" || kind === "BOTH"
        ? [
            {
              subject_type: "LIBRARY",
              name: "WidgetDB",
              aliases: [],
              description_claim: "Batches writes with a write-ahead log",
              evidence_origin: evidence.origin,
              evidence_span_ids: ids,
              url_candidate_ids: input.urlCandidates
                .slice(0, 1)
                .map((url) => url.id),
              url_grounding: input.urlCandidates.length ? "GROUNDED" : "NONE",
              root_story_only: rootBody,
              confidence: 0.85,
            },
          ]
        : [],
    expert_note:
      kind === "EXPERT_NOTE" || kind === "BOTH"
        ? {
            note_type: "TECHNICAL_EXPLANATION",
            title: "Batching storage writes",
            summary: "Batching reduces disk synchronization overhead.",
            evidence_origin: evidence.origin,
            evidence_span_ids: ids,
            related_subject_names: [],
            qualifiers: [],
            confidence: 0.85,
          }
        : null,
    review: {
      required: rootBody,
      reasons: rootBody ? ["ROOT_ONLY_DISCOVERY"] : [],
    },
  };
};
