import { hnItemId } from "@hn-knowledge/domain";
import type { ManualDraftV1 } from "@hn-knowledge/contracts";
import { createApi, type CommentDetail } from "../lib/api";
import { initialDraft, newNote, setConfidence } from "../lib/draft";

export const complete = setConfidence(
  initialDraft({
    primary_decision: "EXPERT_NOTE",
    comment_relevance: {
      is_materially_technical: true,
      reason: "Explains batched writes",
      evidence_span_ids: ["span:0"],
    },
    expert_note: {
      ...newNote(),
      title: "WidgetDB writes",
      summary: "Batches writes to improve throughput.",
      evidence_span_ids: ["span:0"],
    },
  }),
  0.9,
);
export const saved: ManualDraftV1 = {
  id: "11111111-1111-4111-8111-111111111111",
  comment_id: 900001,
  version: 2,
  source_hash: "a".repeat(64),
  state: "DRAFT",
  actor_id: "owner",
  created_at: "2026-09-05T00:00:00Z",
  updated_at: "2026-09-05T00:00:00Z",
  decision_id: null,
  payload: complete,
};
export const detail: CommentDetail = {
  comment_id: 900001,
  source_hash: saved.source_hash,
  available: true,
  blocked_reason: null,
  draft: saved,
  source: {
    schemaVersion: "classification-input.v1",
    selectedCommentId: hnItemId(900001),
    rootId: hnItemId(900000),
    documents: [
      {
        id: "hn:item:900001",
        origin: "COMMENT",
        spans: [
          {
            id: "span:0",
            documentId: "hn:item:900001",
            origin: "COMMENT",
            kind: "TEXT",
            sourceStart: 0,
            sourceEnd: 33,
            text: "WidgetDB batches writes efficiently.",
          },
        ],
      },
    ],
    urlCandidates: [],
    truncation: [],
  },
};
export const baseApi = () => createApi("test-only", () => {});
