import { describe, expect, it } from "vitest";

import {
  selectRecentOperationalDeploymentIds,
  type OperationalDeploymentHistoryItem,
} from "@hn-knowledge/config";

const item = (
  id: string,
  status: string,
  createdAt: string,
): OperationalDeploymentHistoryItem => ({ id, status, createdAt });

describe("operational deployment history", () => {
  it("selects recent loggable deployments newest first", () => {
    const selected = selectRecentOperationalDeploymentIds(
      [
        item("removed", "REMOVED", "2026-08-28T03:00:00.000Z"),
        item("current", "SUCCESS", "2026-08-28T07:00:00.000Z"),
        item("skipped", "SKIPPED", "2026-08-28T06:00:00.000Z"),
        item("failed", "FAILED", "2026-08-28T05:00:00.000Z"),
        item("old", "REMOVED", "2026-08-26T00:00:00.000Z"),
      ],
      "2026-08-28T08:00:00.000Z",
      27 * 60 * 60_000,
      20,
    );

    expect(selected).toEqual(["current", "removed"]);
  });

  it("caps the number of deployment log queries", () => {
    expect(
      selectRecentOperationalDeploymentIds(
        [
          item("first", "SUCCESS", "2026-08-28T07:00:00.000Z"),
          item("second", "REMOVED", "2026-08-28T06:00:00.000Z"),
        ],
        "2026-08-28T08:00:00.000Z",
        27 * 60 * 60_000,
        1,
      ),
    ).toEqual(["first"]);
  });

  it("rejects invalid timestamps and selection options", () => {
    expect(() =>
      selectRecentOperationalDeploymentIds(
        [item("invalid", "SUCCESS", "not-a-date")],
        "2026-08-28T08:00:00.000Z",
        27 * 60 * 60_000,
        20,
      ),
    ).toThrow(TypeError);
    expect(() =>
      selectRecentOperationalDeploymentIds(
        [],
        "not-a-date",
        27 * 60 * 60_000,
        20,
      ),
    ).toThrow(TypeError);
  });
});
