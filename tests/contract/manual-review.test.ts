import { describe, expect, it } from "vitest";
import {
  parseManualDraftPayload,
  parseManualFinalize,
  validateClassificationV1,
} from "@hn-knowledge/contracts";

describe.skipIf(process.env["CONTRACT_SOURCE"] !== undefined)(
  "manual review local contract",
  () => {
    it("keeps partial drafts separate from complete published decisions", () => {
      const partial = { expert_note: { title: "Draft", summary: "" } };
      expect(parseManualDraftPayload(partial)).toEqual(partial);
      expect(validateClassificationV1(partial).ok).toBe(false);
      expect(() =>
        parseManualDraftPayload({ ...partial, classification_run_id: "fake" }),
      ).toThrow();
    });
    it("requires explicit versioned approval and does not accept actor impersonation", () => {
      const approval = {
        expected_version: 3,
        source_hash: "f".repeat(64),
        command_key: "contract:approval",
        reason: "Verified the evidence",
      };
      expect(parseManualFinalize(approval)).toEqual(approval);
      expect(() =>
        parseManualFinalize({ ...approval, actor_id: "other-owner" }),
      ).toThrow();
    });
  },
);
