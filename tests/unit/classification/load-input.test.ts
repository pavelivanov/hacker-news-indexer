import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadClassifierInput } from "@hn-knowledge/application";
import { hnItemId } from "@hn-knowledge/domain";
import type { ClassificationRepository, Hasher } from "@hn-knowledge/ports";

const hasher: Hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};

describe("classifier input loading", () => {
  it("preserves the adjudicated comment, story URL, root-body URL order", async () => {
    const repository = {
      loadSource: async () => ({
        selectedCommentId: hnItemId(100),
        rootId: hnItemId(200),
        commentHtml: "",
        commentText: "",
        rootTitle: "Example root",
        rootHtml:
          '<p>Root links <a href="https://root.example/first">first</a> and <a href="https://root.example/second">second</a>.</p>',
        rootUrl: "https://story.example/project",
        commentUrlCandidates: [
          {
            canonicalUrl: "https://comment.example/project",
            sourceDocument: "hn:item:100",
            originField: "href",
            validationState: "VALID" as const,
          },
          {
            canonicalUrl: "https://comment.example/project",
            sourceDocument: "hn:item:100",
            originField: "href",
            validationState: "VALID" as const,
          },
        ],
      }),
    } as Pick<
      ClassificationRepository,
      "loadSource"
    > as ClassificationRepository;

    const input = await loadClassifierInput(hnItemId(100), repository, hasher);

    expect(input.urlCandidates).toEqual([
      {
        id: "url:0",
        url: "https://comment.example/project",
        sourceDocument: "hn:item:100",
        originField: "href",
      },
      {
        id: "url:1",
        url: "https://comment.example/project",
        sourceDocument: "hn:item:100",
        originField: "href",
      },
      {
        id: "url:2",
        url: "https://story.example/project",
        sourceDocument: "hn:item:200",
        originField: "story_url",
      },
      {
        id: "url:3",
        url: "https://root.example/first",
        sourceDocument: "hn:item:200",
        originField: "href",
      },
      {
        id: "url:4",
        url: "https://root.example/second",
        sourceDocument: "hn:item:200",
        originField: "href",
      },
    ]);
  });
});
