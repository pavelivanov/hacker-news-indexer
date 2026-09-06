import { describe, expect, it } from "vitest";
import {
  parseManualDraftPayload,
  parseManualFinalize,
  parseManualSave,
} from "@hn-knowledge/contracts";

describe("manual draft contracts", () => {
  it("saves incomplete nested forms independently of final output validation", () => {
    expect(
      parseManualDraftPayload({
        discoveries: [{ name: "", evidence_span_ids: [] }],
        expert_note: { summary: "Unfinished" },
        review: { required: true },
      }),
    ).toBeDefined();
    expect(
      parseManualSave({
        expected_version: 1,
        source_hash: "a".repeat(64),
        payload: {},
      }),
    ).toBeDefined();
  });
  it.each([
    { provider: "fabricated" },
    { expert_note: { html: "unsafe" } },
    { decision_confidence: 1.1 },
    { primary_decision: "OTHER" },
    { discoveries: [{ name: "a".repeat(161) }] },
    { discoveries: Array.from({ length: 6 }, () => ({})) },
    { comment_relevance: { evidence_span_ids: ["forged"] } },
    { discoveries: [{ url_candidate_ids: ["https://example.com"] }] },
  ])("rejects unknown vocabulary or excessive data: %j", (payload) => {
    expect(() => parseManualDraftPayload(payload)).toThrow(TypeError);
  });
  it("requires explicit bounded version, source, command, and reason", () => {
    const command = {
      expected_version: 2,
      source_hash: "a".repeat(64),
      command_key: "review:1",
      reason: " Reviewed ",
    };
    expect(parseManualFinalize(command).reason).toBe("Reviewed");
    for (const change of [
      { actor_id: "spoof" },
      { reason: "   " },
      { expected_version: 0 },
      { source_hash: "stale" },
      { command_key: "unsafe key" },
    ]) {
      expect(() => parseManualFinalize({ ...command, ...change })).toThrow(
        TypeError,
      );
    }
  });
});
