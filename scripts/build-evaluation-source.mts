import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  normalizeHnCommentHtml,
  normalizePlainText,
} from "../packages/application/src/index.ts";

interface HnFixtureItem {
  readonly id: number;
  readonly type: string;
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
}

interface HnFixture {
  readonly items: readonly HnFixtureItem[];
  readonly resolutions: readonly {
    readonly selectedCommentId: number;
    readonly resolvedRootId: number;
  }[];
}

interface CandidateInput {
  readonly documentId: string;
  readonly originField: "href" | "story_url";
  readonly url: string;
}

const fixturePath = path.resolve(
  process.argv[2] ?? "tests/fixtures/seed/hn-items.json",
);
const outputPath = path.resolve(
  process.argv[3] ?? "/tmp/hn-evaluation-source.json",
);
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as HnFixture;
const items = new Map(fixture.items.map((item) => [item.id, item]));
const hasher = {
  sha256: (value: string): string =>
    createHash("sha256").update(value).digest("hex"),
};

const validHttpUrl = (value: string | undefined): string | null => {
  if (value === undefined) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
};

const selected = [
  ...new Map(
    fixture.resolutions.map((resolution) => [
      resolution.selectedCommentId,
      resolution,
    ]),
  ).values(),
].sort((left, right) => left.selectedCommentId - right.selectedCommentId);

const documents = selected.map((resolution) => {
  const comment = items.get(resolution.selectedCommentId);
  const root = items.get(resolution.resolvedRootId);
  if (comment === undefined || root === undefined) {
    throw new Error(
      `Missing fixture item for resolution ${resolution.selectedCommentId}`,
    );
  }
  if (comment.type !== "comment") {
    throw new Error(`Selected item ${comment.id} is not a comment`);
  }

  const commentDocumentId = `comment:${comment.id}`;
  const rootDocumentId = `root:${root.id}`;
  const normalizedComment = normalizeHnCommentHtml(
    comment.text ?? "",
    commentDocumentId,
    hasher,
  );
  const normalizedRoot = normalizeHnCommentHtml(
    root.text ?? "",
    rootDocumentId,
    hasher,
  );
  const rootTitle = normalizePlainText(root.title ?? "");
  const rootPlainText = [rootTitle, normalizedRoot.canonicalText]
    .filter((value) => value.length > 0)
    .join("\n\n");
  const candidates: CandidateInput[] = normalizedComment.urlCandidates
    .filter((candidate) => candidate.canonicalUrl !== null)
    .map((candidate) => ({
      documentId: commentDocumentId,
      originField: "href" as const,
      url: candidate.canonicalUrl as string,
    }));
  const rootUrl = validHttpUrl(root.url);
  if (rootUrl !== null) {
    candidates.push({
      documentId: rootDocumentId,
      originField: "story_url",
      url: rootUrl,
    });
  }
  candidates.push(
    ...normalizedRoot.urlCandidates
      .filter((candidate) => candidate.canonicalUrl !== null)
      .map((candidate) => ({
        documentId: rootDocumentId,
        originField: "href" as const,
        url: candidate.canonicalUrl as string,
      })),
  );

  return {
    commentId: comment.id,
    rootId: root.id,
    comment: {
      documentId: commentDocumentId,
      plainText: normalizedComment.canonicalText,
      blocks: normalizedComment.blocks,
    },
    root: {
      documentId: rootDocumentId,
      title: rootTitle,
      bodyPlainText: normalizedRoot.canonicalText,
      plainText: rootPlainText,
      blocks: normalizedRoot.blocks,
    },
    urlCandidates: candidates.map((candidate, index) => ({
      id: `url:${index}`,
      ...candidate,
    })),
  };
});

if (documents.length !== 98) {
  throw new Error(
    `Expected 98 selected comments, received ${documents.length}`,
  );
}

await writeFile(
  outputPath,
  `${JSON.stringify({ schemaVersion: 1, documents }, null, 2)}\n`,
  "utf8",
);
console.log(
  JSON.stringify({ outputPath, selectedComments: documents.length }, null, 2),
);
