import { OpenAiClassifier } from "@hn-knowledge/adapters";
import type { AppConfig } from "@hn-knowledge/config";
import type { ClassifierPort } from "@hn-knowledge/ports";

/**
 * Builds the classifier the worker uses for CLASSIFY_COMMENT jobs.
 *
 * Returns null unless CLASSIFIER_ENABLED=true so the fail-closed default
 * (jobs terminating with CLASSIFIER_DISABLED) is preserved. The config
 * schema already requires provider/token/model when the flag is set; the
 * checks below turn any drift into a startup error rather than a per-job
 * one.
 *
 * NOTE: with CLASSIFIER_ENABLED=true every ingested comment triggers a
 * paid provider call. The default remains false.
 */
export const createWorkerClassifier = (
  config: AppConfig,
): ClassifierPort | null => {
  if (!config.CLASSIFIER_ENABLED) {
    return null;
  }
  if (config.CLASSIFIER_PROVIDER !== "openai") {
    throw new Error(
      `Unsupported CLASSIFIER_PROVIDER for worker classification: ${String(config.CLASSIFIER_PROVIDER)}`,
    );
  }
  if (
    config.CLASSIFIER_API_TOKEN === undefined ||
    config.CLASSIFIER_API_TOKEN.trim().length === 0
  ) {
    throw new Error(
      "CLASSIFIER_API_TOKEN is required when CLASSIFIER_ENABLED=true",
    );
  }
  if (
    config.CLASSIFIER_MODEL === undefined ||
    config.CLASSIFIER_MODEL.trim().length === 0
  ) {
    throw new Error(
      "CLASSIFIER_MODEL is required when CLASSIFIER_ENABLED=true",
    );
  }
  return new OpenAiClassifier({
    apiToken: config.CLASSIFIER_API_TOKEN,
    modelId: config.CLASSIFIER_MODEL,
    reasoningEffort: config.CLASSIFIER_REASONING_EFFORT,
  });
};
