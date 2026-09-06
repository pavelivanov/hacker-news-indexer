import { describe, expect, it } from "vitest";
import { parseFeedControlV1, parseFeedRetryV1 } from "@hn-knowledge/contracts";
describe.skipIf(process.env["CONTRACT_SOURCE"] !== undefined)(
  "processing controls",
  () => {
    it("accepts operational commands without human content approval fields", () => {
      for (const action of ["sync", "pause", "resume"])
        expect(parseFeedControlV1({ action })).toEqual({ action });
      expect(parseFeedRetryV1({ command_key: "request-1" })).toEqual({
        command_key: "request-1",
      });
      expect(() =>
        parseFeedRetryV1({ command_key: "request-1", approved: true }),
      ).toThrow();
    });
  },
);
