import type { HnItemId } from "@hn-knowledge/domain";
import type {
  BoundedClassifierInput,
  ClassificationRepository,
  Hasher,
} from "@hn-knowledge/ports";

import { normalizeHnCommentHtml } from "../normalize/hn-html.js";
import { buildClassifierInput } from "./build-input.js";

export const loadClassifierInput = async (
  commentId: HnItemId,
  repository: ClassificationRepository,
  hasher: Hasher,
): Promise<BoundedClassifierInput> => {
  const source = await repository.loadSource(commentId);
  if (source === null) {
    throw new TypeError("CLASSIFICATION_SOURCE_NOT_FOUND");
  }
  const comment = normalizeHnCommentHtml(
    source.commentHtml,
    `hn:item:${source.selectedCommentId}`,
    hasher,
  );
  if (comment.canonicalText !== source.commentText) {
    throw new TypeError("CLASSIFICATION_COMMENT_NORMALIZATION_DRIFT");
  }
  const root = normalizeHnCommentHtml(
    source.rootHtml,
    `hn:item:${source.rootId}`,
    hasher,
  );
  const rootUrlCandidate =
    source.rootUrl === null
      ? []
      : [
          {
            canonicalUrl: source.rootUrl,
            sourceDocument: `hn:item:${source.rootId}`,
            originField: "story_url",
            validationState: "CANDIDATE" as const,
          },
        ];

  return buildClassifierInput({
    selectedCommentId: source.selectedCommentId,
    rootId: source.rootId,
    commentText: source.commentText,
    commentBlocks: comment.blocks,
    rootTitle: source.rootTitle,
    rootText: root.canonicalText,
    rootBlocks: root.blocks,
    urlCandidates: [
      ...source.commentUrlCandidates,
      ...root.urlCandidates.map((candidate) => ({
        canonicalUrl: candidate.canonicalUrl ?? candidate.rawUrl,
        sourceDocument: candidate.sourceDocument,
        originField: candidate.originField,
        validationState: candidate.validationState,
      })),
      ...rootUrlCandidate,
    ],
  });
};
