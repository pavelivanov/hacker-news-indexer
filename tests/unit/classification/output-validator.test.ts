import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildClassifierInput,
  validateClassifierOutput,
} from "@hn-knowledge/application";
import type { ClassificationV1 } from "@hn-knowledge/contracts";
import { hnItemId } from "@hn-knowledge/domain";

const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};
const input = buildClassifierInput({
  selectedCommentId: hnItemId(100),
  rootId: hnItemId(200),
  commentText: "Example is a private search project with a local index.",
  commentBlocks: [
    {
      kind: "TEXT",
      text: "Example is a private search project with a local index.",
    },
  ],
  rootTitle: "Example project launch",
  rootText: "Example provides full-content search.",
  rootBlocks: [{ kind: "TEXT", text: "Example provides full-content search." }],
  urlCandidates: [
    {
      canonicalUrl: "https://example.com/",
      sourceDocument: "hn:item:200",
      originField: "story_url",
      validationState: "VALID",
    },
  ],
});

const valid = (): ClassificationV1 => ({
  schema_version: "classification.v1",
  primary_decision: "DISCOVERY",
  decision_confidence: 0.95,
  comment_relevance: {
    is_materially_technical: true,
    reason: "The comment materially describes the project.",
    evidence_span_ids: ["span:0"],
  },
  rejection_reasons: [],
  discoveries: [
    {
      subject_type: "PROJECT",
      name: "Example",
      aliases: [],
      description_claim: "A private search project with a local index.",
      evidence_origin: "COMMENT",
      evidence_span_ids: ["span:0"],
      url_candidate_ids: ["url:0"],
      url_grounding: "GROUNDED",
      root_story_only: false,
      confidence: 0.95,
    },
  ],
  expert_note: null,
  review: { required: false, reasons: [] },
});

const validate = (value: unknown) =>
  validateClassifierOutput(JSON.stringify(value), input, hasher);

describe("classifier output validation", () => {
  it("parses, grounds, and hashes every referenced evidence span", () => {
    const result = validate(valid());

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) {
      throw new Error("Expected valid output");
    }
    expect(result.evidenceSpans).toEqual([
      {
        id: "span:0",
        documentId: "comment:100",
        origin: "COMMENT",
        start: 0,
        end: 55,
        textHash: hasher.sha256(
          "Example is a private search project with a local index.",
        ),
      },
    ]);
  });

  it.each([
    [
      "invented candidate",
      { url_candidate_ids: ["url:99"] },
      "URL_CANDIDATE_UNKNOWN",
    ],
    [
      "missing span",
      { evidence_span_ids: ["span:99"] },
      "EVIDENCE_SPAN_UNKNOWN",
    ],
    ["wrong origin", { evidence_origin: "BOTH" }, "EVIDENCE_ORIGIN_MISMATCH"],
    ["unsupported name", { name: "Invented" }, "SUBJECT_NAME_UNSUPPORTED"],
    [
      "returned URL",
      { description_claim: "See https://invented.example" },
      "MODEL_URL_STRING",
    ],
  ])("rejects %s", (_name, mutation, code) => {
    const output = valid();
    const discovery = output.discoveries[0];
    if (discovery === undefined) {
      throw new Error("Expected discovery fixture");
    }
    expect(
      validate({
        ...output,
        discoveries: [{ ...discovery, ...mutation }],
      }),
    ).toEqual({ ok: false, code });
  });

  it("rejects malformed JSON and strict-schema violations first", () => {
    expect(validateClassifierOutput("{", input, hasher)).toEqual({
      ok: false,
      code: "JSON_INVALID",
    });
    expect(validate({ ...valid(), extra: true })).toEqual({
      ok: false,
      code: "SCHEMA_INVALID",
    });
  });

  it("rejects generic root discoveries for irrelevant comments", () => {
    const output = valid();
    const rootSpan = input.documents
      .find((document) => document.id === "root-title:200")
      ?.spans.at(0);
    const discovery = output.discoveries[0];
    if (rootSpan === undefined || discovery === undefined) {
      throw new Error("Expected root span and discovery");
    }

    expect(
      validate({
        ...output,
        comment_relevance: {
          is_materially_technical: false,
          reason: "The comment is incidental.",
          evidence_span_ids: [],
        },
        discoveries: [
          {
            ...discovery,
            evidence_origin: "ROOT_STORY",
            evidence_span_ids: [rootSpan.id],
            root_story_only: true,
          },
        ],
      }),
    ).toEqual({ ok: false, code: "ROOT_RELEVANCE_FAILED" });
  });
});
