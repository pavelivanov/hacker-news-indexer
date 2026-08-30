import { describe, expect, it } from "vitest";

import {
  assertEvaluationHypothesisMatches,
  parseEvaluationHypothesis,
  parseEvaluationHypothesisReference,
} from "@hn-knowledge/application";

const value = {
  schemaVersion: "evaluation-hypothesis.v1",
  cycleId: "v2",
  mode: "benchmark",
  provider: "openai",
  modelId: "gpt-5.6-sol",
  modelConfigId:
    "openai-responses:gpt-5.6-sol:reasoning-low:max-output-8192:strict-json-schema:store-false:v1",
  reasoningEffort: "low",
  promptVersion: "classification-prompt.v4",
  promptHash: "a".repeat(64),
  decisionRouterVersion: "decision-router.v1",
  statement:
    "Sol-low should meet every frozen development quality gate on the fresh v2 labels.",
  decisionRule:
    "Select it only if every gate passes; otherwise stop and document the failed boundary.",
} as const;

describe("paid evaluation hypotheses", () => {
  it("parses one strict hypothesis for an exact development configuration", () => {
    const hypothesis = parseEvaluationHypothesis(value);

    expect(() =>
      assertEvaluationHypothesisMatches(hypothesis, {
        cycleId: "v2",
        mode: "benchmark",
        provider: "openai",
        modelId: "gpt-5.6-sol",
        modelConfigId: value.modelConfigId,
        reasoningEffort: "low",
        promptVersion: "classification-prompt.v4",
        promptHash: "a".repeat(64),
        decisionRouterVersion: "decision-router.v1",
      }),
    ).not.toThrow();
  });

  it("rejects reuse for a different model configuration", () => {
    const hypothesis = parseEvaluationHypothesis(value);

    expect(() =>
      assertEvaluationHypothesisMatches(hypothesis, {
        cycleId: "v2",
        mode: "benchmark",
        provider: "openai",
        modelId: "gpt-5.6-terra",
        modelConfigId: value.modelConfigId.replace("sol", "terra"),
        reasoningEffort: "low",
        promptVersion: "classification-prompt.v4",
        promptHash: "a".repeat(64),
        decisionRouterVersion: "decision-router.v1",
      }),
    ).toThrow(/modelId does not match/u);
  });

  it("rejects vague or structurally expanded hypotheses", () => {
    expect(() =>
      parseEvaluationHypothesis({ ...value, statement: "Try Sol." }),
    ).toThrow(/statement/u);
    expect(() =>
      parseEvaluationHypothesis({ ...value, authorization: "owner approved" }),
    ).toThrow(/unexpected or missing fields/u);
  });

  it("accepts only hash-pinned hypothesis files in the evaluation directory", () => {
    expect(
      parseEvaluationHypothesisReference({
        path: "evaluation/hypotheses/v2-sol-low.json",
        sha256: "b".repeat(64),
      }),
    ).toEqual({
      path: "evaluation/hypotheses/v2-sol-low.json",
      sha256: "b".repeat(64),
    });
    expect(() =>
      parseEvaluationHypothesisReference({
        path: "../v2-sol-low.json",
        sha256: "b".repeat(64),
      }),
    ).toThrow(/evaluation\/hypotheses/u);
  });
});
