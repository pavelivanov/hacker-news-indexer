const SUSTAINED_WINDOW_MS = 10 * 60_000;
const MINIMUM_COVERAGE_MS = 9 * 60_000;
const MINIMUM_SAMPLE_COUNT = 10;
const MAXIMUM_SAMPLE_AGE_MS = 2 * 60_000;
const MAXIMUM_FUTURE_SKEW_MS = 60_000;

export interface ResourceMetricPoint {
  readonly timestamp: string;
  readonly value: number;
}

interface NormalizedMetricPoint {
  readonly timestamp: number;
  readonly value: number;
}

const normalize = (
  points: readonly ResourceMetricPoint[],
): readonly NormalizedMetricPoint[] =>
  points.map((point) => {
    const timestamp = Date.parse(point.timestamp);
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(point.value) ||
      point.value < 0
    ) {
      throw new TypeError(
        "Resource metric points must be finite and non-negative",
      );
    }
    return { timestamp, value: point.value };
  });

const roundedPercent = (value: number): number => Math.round(value * 10) / 10;

export const resourceUtilizationPercent = (
  usage: number,
  limit: number,
): number => {
  if (
    !Number.isFinite(usage) ||
    usage < 0 ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    throw new TypeError(
      "Resource usage must be non-negative and limit must be positive",
    );
  }
  return roundedPercent((usage / limit) * 100);
};

export const sustainedUtilizationFloorPercent = (
  usagePoints: readonly ResourceMetricPoint[],
  limitPoints: readonly ResourceMetricPoint[],
  checkedAt: string,
): number | null => {
  const now = Date.parse(checkedAt);
  if (!Number.isFinite(now)) {
    throw new TypeError("checkedAt must be an ISO timestamp");
  }
  const limits = new Map(
    normalize(limitPoints).map((point) => [point.timestamp, point.value]),
  );
  const samples = normalize(usagePoints)
    .flatMap((point) => {
      const limit = limits.get(point.timestamp);
      if (
        limit === undefined ||
        limit <= 0 ||
        point.timestamp > now + MAXIMUM_FUTURE_SKEW_MS
      ) {
        return [];
      }
      return [
        {
          timestamp: point.timestamp,
          utilizationPercent: resourceUtilizationPercent(point.value, limit),
        },
      ];
    })
    .sort((left, right) => left.timestamp - right.timestamp);
  const latest = samples.at(-1);
  if (latest === undefined || now - latest.timestamp > MAXIMUM_SAMPLE_AGE_MS) {
    return null;
  }
  const windowStart = latest.timestamp - SUSTAINED_WINDOW_MS;
  const window = samples.filter((sample) => sample.timestamp >= windowStart);
  const earliest = window[0];
  if (
    earliest === undefined ||
    window.length < MINIMUM_SAMPLE_COUNT ||
    latest.timestamp - earliest.timestamp < MINIMUM_COVERAGE_MS
  ) {
    return null;
  }
  return Math.min(...window.map((sample) => sample.utilizationPercent));
};
