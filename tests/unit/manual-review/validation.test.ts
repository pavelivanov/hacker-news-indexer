import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildClassifierInput,
  clearManualEvidence,
  validateClassifierOutput,
} from "@hn-knowledge/application";
import { hnItemId } from "@hn-knowledge/domain";
import { manualOutput } from "../../fixtures/manual-review/output.js";

const hasher = {
  sha256: (value: string) => createHash("sha256").update(value).digest("hex"),
};
const input = buildClassifierInput({
  selectedCommentId: hnItemId(900001),
  rootId: hnItemId(900000),
  commentText: "WidgetDB batches writes.",
  commentBlocks: [],
  rootTitle: "WidgetDB",
  rootText: "WidgetDB uses a log.",
  rootBlocks: [],
  urlCandidates: [],
});
describe("manual output validation", () => {
  it.each(["DISCOVERY", "EXPERT_NOTE", "BOTH", "REJECTED"] as const)(
    "retains the existing %s taxonomy",
    (kind) => {
      expect(
        validateClassifierOutput(
          JSON.stringify(manualOutput(input, kind)),
          input,
          hasher,
        ).ok,
      ).toBe(true);
    },
  );
  it("rejects incomplete, ungrounded, and wrong-origin output", () => {
    expect(validateClassifierOutput("{}", input, hasher).ok).toBe(false);
    const output = manualOutput(input);
    for (const changes of [
      { evidence_span_ids: ["span:999"] },
      { url_candidate_ids: ["url:999"], url_grounding: "GROUNDED" },
      { evidence_origin: "ROOT_STORY", root_story_only: true },
    ]) {
      expect(
        validateClassifierOutput(
          JSON.stringify({
            ...output,
            discoveries: [{ ...output.discoveries[0], ...changes }],
          }),
          input,
          hasher,
        ).ok,
      ).toBe(false);
    }
  });
  it("rebase preserves writing but drops every evidence and URL selection", () => {
    const cleared = clearManualEvidence(manualOutput(input));
    expect(cleared).toMatchObject({
      discoveries: [
        {
          name: "WidgetDB",
          evidence_span_ids: [],
          url_candidate_ids: [],
          url_grounding: "NONE",
        },
      ],
      comment_relevance: { evidence_span_ids: [] },
    });
    expect(
      validateClassifierOutput(JSON.stringify(cleared), input, hasher).ok,
    ).toBe(false);
  });
});
