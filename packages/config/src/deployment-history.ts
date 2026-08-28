const MAXIMUM_FUTURE_SKEW_MS = 60_000;
const LOGGABLE_DEPLOYMENT_STATUSES = new Set(["SUCCESS", "REMOVED"]);

export interface OperationalDeploymentHistoryItem {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
}

export const selectRecentOperationalDeploymentIds = (
  deployments: readonly OperationalDeploymentHistoryItem[],
  checkedAt: string,
  windowMs: number,
  maximumCount: number,
): readonly string[] => {
  const now = Date.parse(checkedAt);
  if (
    !Number.isFinite(now) ||
    !Number.isSafeInteger(windowMs) ||
    windowMs <= 0 ||
    !Number.isSafeInteger(maximumCount) ||
    maximumCount <= 0
  ) {
    throw new TypeError("Invalid deployment-history selection options");
  }
  return deployments
    .map((deployment) => {
      const createdAt = Date.parse(deployment.createdAt);
      if (!Number.isFinite(createdAt) || deployment.id.length === 0) {
        throw new TypeError("Invalid deployment-history item");
      }
      return { ...deployment, createdAt };
    })
    .filter(
      (deployment) =>
        LOGGABLE_DEPLOYMENT_STATUSES.has(deployment.status) &&
        deployment.createdAt >= now - windowMs &&
        deployment.createdAt <= now + MAXIMUM_FUTURE_SKEW_MS,
    )
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, maximumCount)
    .map((deployment) => deployment.id);
};
