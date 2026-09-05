import { describe, expect, it } from "vitest";

import {
  buildClassifierInput,
  restoreClassifierInputOrder,
  COMMENT_INPUT_LIMIT_BYTES,
  ROOT_TEXT_LIMIT_BYTES,
  ROOT_TITLE_LIMIT_CHARACTERS,
  TOTAL_INPUT_LIMIT_BYTES,
} from "@hn-knowledge/application";
import { hnItemId } from "@hn-knowledge/domain";

const source = () => ({
  selectedCommentId: hnItemId(100),
  rootId: hnItemId(200),
  commentText: "Example project details.\n\n".repeat(2_000),
  commentBlocks: [{ kind: "TEXT" as const, text: "Example project details." }],
  rootTitle: "R".repeat(1_000),
  rootText: "Root technical context.\n\n".repeat(2_000),
  rootBlocks: [{ kind: "TEXT" as const, text: "Root technical context." }],
  urlCandidates: Array.from({ length: 60 }, (_, index) => ({
    canonicalUrl: `https://example.com/resource/${index}`,
    sourceDocument: index % 2 === 0 ? "hn:item:100" : "hn:item:200",
    originField: index === 0 ? "story_url" : "href",
    validationState: "VALID" as const,
  })),
});

describe("bounded classifier input", () => {
  it("restores exact input bytes after object key order changes in storage", () => {
    const input = buildClassifierInput(source());
    const reverseKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reverseKeys);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, child]) => [key, reverseKeys(child)]),
        );
      return value;
    };
    const stored = reverseKeys(input) as typeof input;
    expect(JSON.stringify(stored)).not.toBe(JSON.stringify(input));
    expect(JSON.stringify(restoreClassifierInputOrder(stored))).toBe(
      JSON.stringify(input),
    );
  });
  it("is byte-for-byte deterministic and respects every cap", () => {
    const first = buildClassifierInput(source());
    const second = buildClassifierInput(source());
    const serialized = JSON.stringify(first);
    const comment = first.documents.find((value) => value.id === "comment:100");
    const rootTitle = first.documents.find(
      (value) => value.id === "root-title:200",
    );
    const rootText = first.documents.find(
      (value) => value.id === "root-text:200",
    );
    const bytes = (value: string): number => Buffer.byteLength(value, "utf8");

    expect(JSON.stringify(second)).toBe(serialized);
    expect(bytes(serialized)).toBeLessThanOrEqual(TOTAL_INPUT_LIMIT_BYTES);
    expect(
      bytes(comment?.spans.map((span) => span.text).join("") ?? ""),
    ).toBeLessThanOrEqual(COMMENT_INPUT_LIMIT_BYTES);
    expect(
      bytes(rootText?.spans.map((span) => span.text).join("") ?? ""),
    ).toBeLessThanOrEqual(ROOT_TEXT_LIMIT_BYTES);
    expect(
      rootTitle?.spans.reduce((total, span) => total + span.text.length, 0),
    ).toBeLessThanOrEqual(ROOT_TITLE_LIMIT_CHARACTERS);
    expect(first.urlCandidates.length).toBeLessThanOrEqual(50);
  });

  it("records a reversible truncation map without splitting included spans", () => {
    const original = source();
    const input = buildClassifierInput(original);
    const originals = new Map([
      ["comment:100", original.commentText],
      ["root-title:200", original.rootTitle],
      ["root-text:200", original.rootText],
    ]);

    for (const document of input.documents) {
      const text = originals.get(document.id);
      if (text === undefined) {
        throw new Error("Unexpected document ID");
      }
      for (const span of document.spans) {
        expect(text.slice(span.sourceStart, span.sourceEnd)).toBe(span.text);
      }
      const map = input.truncation.find(
        (value) => value.documentId === document.id,
      );
      expect(map?.originalLength).toBe(text.length);
      const coverage = [
        ...(map?.includedRanges ?? []),
        ...(map?.omittedRanges ?? []),
      ]
        .sort((left, right) => left.sourceStart - right.sourceStart)
        .reduce(
          (total, range) => total + range.sourceEnd - range.sourceStart,
          0,
        );
      expect(coverage).toBe(text.length);
    }
  });

  it("includes only valid supplied HTTP URL candidates", () => {
    const input = buildClassifierInput({
      ...source(),
      commentText: "safe",
      rootTitle: "root",
      rootText: "",
      urlCandidates: [
        {
          canonicalUrl: "https://example.com/allowed",
          sourceDocument: "hn:item:100",
          originField: "href",
          validationState: "VALID",
        },
        {
          canonicalUrl: "javascript:alert(1)",
          sourceDocument: "hn:item:100",
          originField: "href",
          validationState: "REJECTED",
        },
        {
          canonicalUrl: null,
          sourceDocument: "hn:item:100",
          originField: "href",
          validationState: "REJECTED",
        },
      ],
    });

    expect(input.urlCandidates).toEqual([
      {
        id: "url:0",
        url: "https://example.com/allowed",
        sourceDocument: "hn:item:100",
        originField: "href",
      },
    ]);
  });

  it("contains no configuration or credential diagnostics", () => {
    const serialized = JSON.stringify(
      buildClassifierInput({
        ...source(),
        commentText: "technical content",
        rootTitle: "title",
        rootText: "root text",
      }),
    );

    expect(serialized).not.toContain("TELEGRAM_API_HASH");
    expect(serialized).not.toContain("DATABASE_URL");
    expect(serialized).not.toContain("APP_API_TOKEN");
  });
});
