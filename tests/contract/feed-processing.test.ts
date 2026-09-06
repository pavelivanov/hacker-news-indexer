import { describe, expect, it } from "vitest";
import {
  parseFeedControlV1,
  parseFeedRetryV1,
  parseFeedSettingsV1,
} from "@hn-knowledge/contracts";
describe.skipIf(process.env["CONTRACT_SOURCE"] !== undefined)(
  "processing controls",
  () => {
    it("accepts settings boundaries without source, model or content approval changes", () => {
      for (const [interval_minutes, daily_request_limit] of [
        [1, 1],
        [1440, 1000],
      ])
        expect(
          parseFeedSettingsV1({
            interval_minutes,
            daily_request_limit,
            expected_version: 0,
            command_key: "settings:1",
          }),
        ).toMatchObject({ interval_minutes, daily_request_limit });
      expect(() =>
        parseFeedSettingsV1({
          interval_minutes: 30,
          daily_request_limit: 100,
          expected_version: 0,
          command_key: "settings:1",
          approved: true,
        }),
      ).toThrow();
    });
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
