import { describe, expect, it } from "vitest";

import {
  resourceUtilizationPercent,
  sustainedUtilizationFloorPercent,
  type ResourceMetricPoint,
} from "@hn-knowledge/config";

const CHECKED_AT = "2026-08-27T15:00:00.000Z";

const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new TypeError("Expected fixture value");
  }
  return value;
};

const series = (
  value: number,
  count = 21,
  lastTimestamp = Date.parse(CHECKED_AT),
): readonly ResourceMetricPoint[] =>
  Array.from({ length: count }, (_, index) => ({
    timestamp: new Date(
      lastTimestamp - (count - index - 1) * 30_000,
    ).toISOString(),
    value,
  }));

describe("resource metric summaries", () => {
  it("returns the ten-minute utilization floor with complete fresh coverage", () => {
    const usage = [...series(9)];
    usage[10] = { ...required(usage[10]), value: 5 };

    expect(
      sustainedUtilizationFloorPercent(usage, series(10), CHECKED_AT),
    ).toBe(50);
  });

  it("does not call a short or stale sample set sustained", () => {
    expect(
      sustainedUtilizationFloorPercent(series(9, 9), series(10, 9), CHECKED_AT),
    ).toBeNull();

    const staleTimestamp = Date.parse(CHECKED_AT) - 3 * 60_000;
    expect(
      sustainedUtilizationFloorPercent(
        series(9, 21, staleTimestamp),
        series(10, 21, staleTimestamp),
        CHECKED_AT,
      ),
    ).toBeNull();
  });

  it("pairs usage and limits by timestamp and ignores zero-limit startup points", () => {
    const usage = series(9);
    const limits = [...series(10)];
    limits[0] = { ...required(limits[0]), value: 0 };

    expect(sustainedUtilizationFloorPercent(usage, limits, CHECKED_AT)).toBe(
      90,
    );
  });

  it("rounds safe capacity percentages and rejects invalid limits", () => {
    expect(resourceUtilizationPercent(82.65728, 5_000)).toBe(1.7);
    expect(() => resourceUtilizationPercent(1, 0)).toThrow(TypeError);
  });
});
