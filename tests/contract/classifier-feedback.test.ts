import { describe, expect, it } from "vitest";
import { parseClassifierFeedbackV1 } from "@hn-knowledge/contracts";
describe.skipIf(process.env["CONTRACT_SOURCE"] !== undefined)(
  "classifier feedback contract",
  () => {
    it("captures a correction without demanding confidence, evidence selection, or approval", () => {
      const body = {
        expected_version: 0,
        command_key: "contract",
        category: "REJECTED",
        title: "",
        summary: "",
        issue: "NOT_USEFUL",
        explanation: "",
      };
      expect(parseClassifierFeedbackV1(body)).toEqual(body);
      expect(() =>
        parseClassifierFeedbackV1({ ...body, approved: true }),
      ).toThrow();
      expect(() =>
        parseClassifierFeedbackV1({ ...body, actor_id: "other" }),
      ).toThrow();
    });
  },
);
